import { app, session, shell } from 'electron'
import { classifyExternalUrl, formatBlockedUrlError } from '@polo-ai/shared/utils/url-safety'
import { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager'
import { describeUrlForLog } from './deep-link-log'
import { windowLog } from './logger'
import {
  LEGACY_TAB_APP_PARTITION_PREFIX,
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
 * Synchronously derives the ONLY tab-app partition a window may embed, from
 * the trusted runtime fence and the window→Workspace mapping. Returns null
 * when no committed fence exists (local-account mode): such windows may use
 * only the shared legacy browser-pane partition.
 */
function deriveTrustedTabAppPartition(
  hostWebContentsId: number,
): string | null {
  const accountId = getRuntimeActiveProductSpaceAccount()
  const productSpaceId = getRuntimeActiveProductSpace()
  if (!accountId || !productSpaceId) return null
  const workspaceId = trustedWebviewScopeResolver.getWorkspaceForWebContentsId?.(hostWebContentsId)
  if (!workspaceId) return null
  return tabAppPartitionForScope({ accountId, productSpaceId, workspaceId })
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
): void {
  // The superseded digest covered account+ProductSpace without the
  // Workspace dimension; every workspace of the tuple shared one partition.
  const legacyPartition = legacyTabAppPartitionForScope({ accountId, productSpaceId })
  cleanupLegacyTabAppPartition(legacyPartition)
  // Belt and braces: clean every legacy-named partition this process has
  // already seen (e.g. from a previously committed fence).
  for (const partition of handledPartitions) {
    if (partition.startsWith(LEGACY_TAB_APP_PARTITION_PREFIX)) {
      cleanupLegacyTabAppPartition(partition)
    }
  }
}

export function installWebviewSecurityHandlers(): void {
  attachWebviewPermissionHandlers(BROWSER_PANE_SESSION_PARTITION)

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      // Defense in depth: the authoritative gate is the host's
      // will-attach-webview below; this guest-side hook covers guests whose
      // window predates the resolver wiring.
      const host = contents.hostWebContents
      const expectedPartition = host
        ? deriveTrustedTabAppPartition(host.id)
        : null
      if (expectedPartition) {
        attachWebviewPermissionHandlers(expectedPartition)
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
    // trusted account+ProductSpace+Workspace tuple. A mismatching or
    // missing partition (compromised or buggy renderer) never loads.
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const requestedPartition = webPreferences.partition
      const expectedPartition = deriveTrustedTabAppPartition(contents.id)

      if (expectedPartition) {
        // Before any navigation the scoped policy is guaranteed on the
        // exact session the guest will use. The superseded 32-bit legacy
        // partitions are cleared once per process.
        clearLegacyPartitionsForScope(
          getRuntimeActiveProductSpaceAccount()!,
          getRuntimeActiveProductSpace()!,
        )
        if (requestedPartition !== expectedPartition) {
          event.preventDefault()
          windowLog.warn(
            '[webview-security] blocked webview with unexpected partition',
            `${describeUrlForLog(params.src ?? '')} requested=${requestedPartition ?? '(none)'} expected=${expectedPartition}`,
          )
          return
        }
        attachWebviewPermissionHandlers(expectedPartition)
        return
      }

      // Local-account mode (no committed fence): only the shared legacy
      // browser-pane partition is acceptable.
      if (requestedPartition !== BROWSER_PANE_SESSION_PARTITION) {
        event.preventDefault()
        windowLog.warn(
          '[webview-security] blocked webview partition without a committed ProductSpace',
          `${describeUrlForLog(params.src ?? '')} requested=${requestedPartition ?? '(none)'}`,
        )
      }
    })
  })
}
