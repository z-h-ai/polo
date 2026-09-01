import { app, session, shell } from 'electron'
import { classifyExternalUrl, formatBlockedUrlError } from '@polo-ai/shared/utils/url-safety'
import { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager'
import { describeUrlForLog } from './deep-link-log'
import { windowLog } from './logger'
import {
  legacyTabAppPartitionForScope,
  tabAppPartitionForScope,
} from '../shared/tab-browser-partition'
import {
  getRuntimeActiveProductSpace,
  getRuntimeActiveProductSpaceAccount,
} from '@polo-ai/server-core/runtime/product-space-executions'

const allow = new Set([
  'fullscreen',
  'pointerLock',
  'window-management',
  'notifications',
  'geolocation',
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'idle-detection',
])

const handledPartitions = new Set<string>()
const cleanedLegacyPartitions = new Set<string>()

interface WebviewScopeResolver {
  getWorkspaceForWebContentsId?: (webContentsId: number) => string | null
}

const trustedWebviewScopeResolver: WebviewScopeResolver = {}

/**
 * Wires the Main-trusted window→Workspace mapping. The account and
 * ProductSpace are always read synchronously from the runtime fence so an
 * account change is reflected at every attach, never cached.
 */
export function setWebviewScopeResolver(resolver: WebviewScopeResolver): void {
  trustedWebviewScopeResolver.getWorkspaceForWebContentsId = resolver.getWorkspaceForWebContentsId
}

/** Test seam: resets the caches and the scope resolver. */
export function __resetWebviewSecurityForTests(): void {
  handledPartitions.clear()
  cleanedLegacyPartitions.clear()
  delete trustedWebviewScopeResolver.getWorkspaceForWebContentsId
}

/**
 * The attach-time trust decision for one host window:
 *
 * - `scoped`: a committed fence bound to the trusted account AND a resolved
 *   Workspace — the guest must use exactly the derived partition.
 * - `local-account`: genuinely signed out (no Admin account AND no committed
 *   fence) — only the shared browser-pane partition is acceptable.
 * - `closed`: any partial state (signed in without a fence, a fence without
 *   a Workspace mapping, …) — NO partition is acceptable; the webview is
 *   prevented unconditionally.
 */
type TabAppAttachDecision =
  | { mode: 'scoped'; partition: string; accountId: string; productSpaceId: string; workspaceId: string }
  | { mode: 'local-account' }
  | { mode: 'closed' }

function decideTabAppAttach(
  hostWebContentsId: number,
): TabAppAttachDecision {
  const accountId = getRuntimeActiveProductSpaceAccount()
  const productSpaceId = getRuntimeActiveProductSpace()
  if (!accountId && !productSpaceId) {
    return { mode: 'local-account' }
  }
  if (!accountId || !productSpaceId) {
    // Signed in without a committed fence (contract-blocked, mid-revoke,
    // pre-bootstrap) — fail closed.
    return { mode: 'closed' }
  }
  const workspaceId = trustedWebviewScopeResolver.getWorkspaceForWebContentsId?.(hostWebContentsId)
  if (!workspaceId) {
    // A fence whose window→Workspace mapping is missing is an incomplete
    // scope — never degrade to a shared partition.
    return { mode: 'closed' }
  }
  return {
    mode: 'scoped',
    partition: tabAppPartitionForScope({ accountId, productSpaceId, workspaceId }),
    accountId,
    productSpaceId,
    workspaceId,
  }
}

/**
 * Installs the webview permission policy on a session partition. The base
 * browser-pane partition is handled eagerly; scoped tab-app partitions are
 * attached at `will-attach-webview` (before the guest navigates) and — as
 * defense in depth — on guest web-contents creation.
 */
function attachWebviewPermissionHandlers(partitionName: string): void {
  if (handledPartitions.has(partitionName)) return
  handledPartitions.add(partitionName)
  const ses = session.fromPartition(partitionName)

  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      const allowed = allow.has(permission)
      if (!allowed) {
        windowLog.warn(
          `[webview-security] permission check denied: ${permission}`,
          describeUrlForLog(requestingOrigin),
        )
      }
      return allowed
    })
  }

  if (typeof ses.setPermissionRequestHandler === 'function') {
    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const allowed = allow.has(permission)
      if (!allowed) {
        const requestingOrigin = (
          details as { requestingOrigin?: string } | undefined
        )?.requestingOrigin ?? 'unknown'
        windowLog.warn(
          `[webview-security] permission request denied: ${permission}`,
          describeUrlForLog(requestingOrigin),
        )
      }
      callback(allowed)
    })
  }
}

/**
 * One-shot cleanup of the superseded 32-bit tab-app partitions: after the
 * digest change the old `persist:tab-app-<fnv>` cookies/storage are orphaned
 * (never loaded again), so they are cleared instead of lingering.
 */
function cleanupLegacyTabAppPartition(legacyPartition: string): void {
  if (cleanedLegacyPartitions.has(legacyPartition)) return
  cleanedLegacyPartitions.add(legacyPartition)
  try {
    void session.fromPartition(legacyPartition).clearStorageData().catch(error => {
      windowLog.warn(
        '[webview-security] legacy tab-app partition cleanup failed:',
        error instanceof Error ? error.message : String(error),
      )
    })
  } catch (error) {
    windowLog.warn(
      '[webview-security] legacy tab-app partition cleanup failed:',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function clearLegacyPartitionsForScope(
  accountId: string,
  productSpaceId: string,
  workspaceId: string,
): void {
  // The superseded 425e90a1 naming hashed the JSON triple INCLUDING the
  // workspace id with its own prefix — reproduce that exact name so the
  // orphaned storage of this tuple's workspaces is actually cleared.
  const legacyPartition = legacyTabAppPartitionForScope({
    accountId,
    productSpaceId,
    workspaceId,
  })
  cleanupLegacyTabAppPartition(legacyPartition)
}

export function installWebviewSecurityHandlers(): void {
  attachWebviewPermissionHandlers(BROWSER_PANE_SESSION_PARTITION)

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      // Defense in depth: the authoritative gate is the host's
      // will-attach-webview below; this guest-side hook covers guests whose
      // window predates the resolver wiring.
      const host = contents.hostWebContents
      const decision = host ? decideTabAppAttach(host.id) : { mode: 'closed' as const }
      if (decision.mode === 'scoped') {
        attachWebviewPermissionHandlers(decision.partition)
      }
    } else if (contents.getType() !== 'window') {
      return
    }

    // Common webview/window policy: popups open externally (never inside the
    // guest), and only HTTP(S) navigations are allowed.
    contents.setWindowOpenHandler((details) => {
      const classification = classifyExternalUrl(details.url)
      if (classification.kind === 'dangerous' || classification.kind === 'internal-deeplink') {
        const reason = classification.kind === 'internal-deeplink'
          ? 'internal_deeplink'
          : formatBlockedUrlError(classification)
        windowLog.warn(
          `[webview-security] blocked popup: ${reason}`,
          describeUrlForLog(details.url),
        )
        return { action: 'deny' }
      }

      void shell.openExternal(details.url).catch((error) => {
        windowLog.warn(
          `[webview-security] failed to open popup externally: ${error instanceof Error ? error.message : String(error)}`,
          describeUrlForLog(details.url),
        )
      })
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return
      } catch {
        // Invalid URLs fall through to blocking.
      }

      event.preventDefault()
      windowLog.warn(
        '[webview-security] blocked navigation',
        describeUrlForLog(url),
      )
    })

    if (contents.getType() !== 'window') return

    // The host window gate: when the renderer attaches a <webview>, verify
    // the guest's actual partition against the one Main derives from the
    // trusted account+ProductSpace+Workspace tuple. A mismatching, missing,
    // or unresolvable partition (compromised or buggy renderer, partial
    // scope) never loads.
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const requestedPartition = webPreferences.partition
      const decision = decideTabAppAttach(contents.id)

      if (decision.mode === 'scoped') {
        // Before any navigation the scoped policy is guaranteed on the
        // exact session the guest will use. The superseded 425e90a1
        // partitions are cleared once per process.
        clearLegacyPartitionsForScope(
          decision.accountId,
          decision.productSpaceId,
          decision.workspaceId,
        )
        if (requestedPartition !== decision.partition) {
          event.preventDefault()
          windowLog.warn(
            '[webview-security] blocked webview with unexpected partition',
            `${describeUrlForLog(params.src ?? '')} requested=${requestedPartition ?? '(none)'} expected=${decision.partition}`,
          )
          return
        }
        attachWebviewPermissionHandlers(decision.partition)
        return
      }

      if (decision.mode === 'local-account') {
        // Genuinely signed out: only the shared legacy browser-pane
        // partition is acceptable.
        if (requestedPartition !== BROWSER_PANE_SESSION_PARTITION) {
          event.preventDefault()
          windowLog.warn(
            '[webview-security] blocked webview partition in local-account mode',
            `${describeUrlForLog(params.src ?? '')} requested=${requestedPartition ?? '(none)'}`,
          )
        }
        return
      }

      // Partial or unresolvable scope: nothing may load.
      event.preventDefault()
      windowLog.warn(
        '[webview-security] blocked webview for an incomplete ProductSpace scope',
        `${describeUrlForLog(params.src ?? '')} requested=${requestedPartition ?? '(none)'}`,
      )
    })
  })
}
