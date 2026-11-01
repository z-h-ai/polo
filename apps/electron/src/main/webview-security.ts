import { getAppSdkBridge, setAppSdkWorkspaceResolver } from './app-sdk-service'
import { app, session, shell } from 'electron'
import { classifyExternalUrl, formatBlockedUrlError } from '@polo-ai/shared/utils/url-safety'
import { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager'
import { describeUrlForLog } from './deep-link-log'
import { windowLog } from './logger'
import { extractPoloBridgeCapabilities, getUiCardRegistry } from './ui-card-registry'
import {
  legacyTabAppPartitionForScope,
  tabAppPartitionForScope,
} from '../shared/tab-browser-partition'
import {
  getRuntimeActiveProductSpace,
  getRuntimeActiveProductSpaceAccount,
} from '@polo-ai/server-core/runtime/product-space-executions'
import { getSyncTrustedProductSpaceAccountState } from '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'

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

/**
 * Main-trusted validator for a genui canvas guest's initial src (POO-102
 * review): the session id comes from the already-gated partition name and the
 * src must be a `data:` URL or a `file:` URL that resolves to a generated
 * bundle under that session's data directory. Wired from the genui RPC
 * handler registration (which owns the session/storage deps); while unset the
 * verdict is fail-closed — `data:` only.
 */
type GenUiGuestSrcValidator = (sessionId: string, src: string) => boolean
let genUiGuestSrcValidator: GenUiGuestSrcValidator | null = null

export function setGenUiGuestSrcValidator(validator: GenUiGuestSrcValidator | null): void {
  genUiGuestSrcValidator = validator
}

/** Recovers the chat session id from a validated genui-app-<sessionId> partition. */
export function sessionIdFromGenUiPartition(partition: string): string {
  return partition.replace(/^genui-app-/, '')
}

/**
 * POO-103: the one deep-link shape a canvas guest may navigate to —
 * `poloai://action/ui-event/{sessionId}`. Forwarded to the ui-event handler
 * (wired below), never navigated. Everything else from a canvas guest stays
 * blocked.
 */
export function isGenUiGuestUiEventUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === 'poloai:' &&
      parsed.hostname === 'action' &&
      parsed.pathname.split('/').filter(Boolean)[0] === 'ui-event'
    )
  } catch {
    return false
  }
}

type GenUiGuestDeepLinkForwarder = (url: string, guestWebContentsId: number) => void
let genUiGuestDeepLinkForwarder: GenUiGuestDeepLinkForwarder | null = null

/**
 * P1-3/P2-1 canvas app data channel hooks, installed by the genui RPC handler
 * registration (which owns the data-channel deps). did-attach carries the
 * validated initial src so the observer can read the document's
 * polo-app-data declaration; dom-ready re-injects once the page can actually
 * receive postMessage; destroyed releases the card's channel and watcher.
 * While unset the channel is simply inert — fail closed.
 */
export interface GenUiGuestAppDataHooks {
  onGuestAttached(info: { sessionId: string; guestWebContentsId: number; hostWebContentsId: number; src: string }): void
  onGuestDomReady(guestWebContentsId: number): void
  onGuestDestroyed(guestWebContentsId: number): void
}

let genUiGuestAppDataHooks: GenUiGuestAppDataHooks | null = null

export function setGenUiGuestAppDataHooks(hooks: GenUiGuestAppDataHooks | null): void {
  genUiGuestAppDataHooks = hooks
}

/**
 * Wires the ui-event forwarding (from the genui handler registration, which
 * owns the ui-event deps). Setter injection keeps this module free of the
 * bridge/registry import graph. While unset, canvas-guest ui-event URLs are
 * simply dropped (fail closed).
 */
export function setGenUiGuestDeepLinkForwarder(forwarder: GenUiGuestDeepLinkForwarder | null): void {
  genUiGuestDeepLinkForwarder = forwarder
}

// ── POO-103 attach correlation ───────────────────────────────────────────────
// will-attach knows the validated src (and therefore the document's bridge
// capability declaration) but not the guest id; did-attach knows the guest but
// not the src. A short FIFO queue per host correlates the two — webviews of
// one window attach in creation order. Entries expire quickly: a miss only
// ever costs the card its (optional) capability grant, never grants one.

interface PendingGenUiAttach {
  partition: string
  src: string
  hostWebContentsId: number
  queuedAt: number
}

const GENUI_ATTACH_PENDING_TTL_MS = 10_000
let pendingGenUiAttaches: PendingGenUiAttach[] = []

function queuePendingGenUiAttach(entry: PendingGenUiAttach): void {
  const now = Date.now()
  pendingGenUiAttaches = pendingGenUiAttaches.filter(pending => now - pending.queuedAt <= GENUI_ATTACH_PENDING_TTL_MS)
  pendingGenUiAttaches.push(entry)
}

function takePendingGenUiAttach(hostWebContentsId: number, guest: Electron.WebContents): PendingGenUiAttach | undefined {
  const now = Date.now()
  const index = pendingGenUiAttaches.findIndex(
    pending =>
      pending.hostWebContentsId === hostWebContentsId &&
      now - pending.queuedAt <= GENUI_ATTACH_PENDING_TTL_MS &&
      matchesPartition(pending.partition, guest),
  )
  if (index < 0) return undefined
  const [entry] = pendingGenUiAttaches.splice(index, 1)
  return entry
}

function matchesPartition(partitionName: string, guest: Electron.WebContents): boolean {
  try {
    return session.fromPartition(partitionName) === guest.session
  } catch {
    return false
  }
}

/**
 * Whether the initial src of a genui canvas guest may load. `data:` URLs are
 * inert (no network — the fence below cancels every non-file/data/blob
 * request — and no navigation). Everything else needs the Main-trusted path
 * validator; a missing validator fails closed.
 */
function isAllowedGenUiGuestSrc(partition: string, src: string | undefined): boolean {
  if (typeof src !== 'string' || src.length === 0) return false
  try {
    const parsed = new URL(src)
    if (parsed.protocol === 'data:') return true
    if (parsed.protocol !== 'file:') return false
  } catch {
    return false
  }
  return genUiGuestSrcValidator?.(sessionIdFromGenUiPartition(partition), src) ?? false
}

/**
 * Ephemeral per-session partition namespace for generate_app canvas guests.
 * The strict shape doubles as the will-attach allow-list: it can never carry
 * the `persist:` prefix (in-memory storage only, so canvas state dies with
 * the guest and can never leak across accounts, ProductSpaces or restarts),
 * and it can never collide with the scoped tab-app or browser-pane
 * partitions that the gate below expects.
 */
export const GENUI_APP_PARTITION_PATTERN = /^genui-app-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function isGenUiAppPartition(partition: string | undefined | null): partition is string {
  return typeof partition === 'string' && GENUI_APP_PARTITION_PATTERN.test(partition)
}

// Session objects created from a genui-app partition, tracked by identity so
// the guest-side popup/navigation policy can recognize canvas guests without
// re-deriving partition names from WebContents.
let genuiGuestSessions = new WeakSet<Electron.Session>()

// Session objects whose canvas policy (network fence + permission deny-all)
// has been installed, tracked by identity — genui partitions are in-memory
// and recreated per process, so identity is stable exactly as long as the
// policy is.
let genUiPolicySessions = new WeakSet<Electron.Session>()

/**
 * Canvas-guest policy (POO-102 review): deliberately separate from the
 * browser-pane/tab-app permission set. A generated bundle is untrusted model
 * output rendered locally, so it gets
 *
 * 1. a fail-closed request fence — every request whose scheme is not
 *    file:/data:/blob: is cancelled (fetch/XHR/WebSocket/images/fonts: a
 *    bundle can never call home even if the static generation scan missed an
 *    encoding), and
 * 2. deny-all permissions — no clipboard, geolocation, media, notifications,
 *    or any other power; the loose `allow` set below stays exclusive to the
 *    user-facing browser surfaces.
 */
function attachGenUiGuestPolicyToSession(ses: Electron.Session): void {
  if (genUiPolicySessions.has(ses)) return
  genUiPolicySessions.add(ses)

  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      windowLog.warn(
        '[webview-security] genui guest permission denied:',
        permission,
        describeUrlForLog(requestingOrigin),
      )
      return false
    })
  }

  if (typeof ses.setPermissionRequestHandler === 'function') {
    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const requestingOrigin = (
        details as { requestingOrigin?: string } | undefined
      )?.requestingOrigin ?? 'unknown'
      windowLog.warn(
        '[webview-security] genui guest permission request denied:',
        permission,
        describeUrlForLog(requestingOrigin),
      )
      callback(false)
    })
  }

  if (typeof ses.webRequest?.onBeforeRequest === 'function') {
    ses.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false
      try {
        allowed = ['file:', 'data:', 'blob:'].includes(new URL(details.url).protocol)
      } catch {
        allowed = false
      }
      if (!allowed) {
        windowLog.warn(
          '[webview-security] cancelled genui guest request:',
          String(details.resourceType ?? 'unknown'),
          describeUrlForLog(details.url),
        )
        callback({ cancel: true })
        return
      }
      callback({})
    })
  }
}

function attachGenUiGuestPolicy(partitionName: string): void {
  attachGenUiGuestPolicyToSession(session.fromPartition(partitionName))
}

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
  setAppSdkWorkspaceResolver(id => resolver.getWorkspaceForWebContentsId?.(id) ?? null)
}

/** Test seam: resets the caches and the scope resolver. */
export function __resetWebviewSecurityForTests(): void {
  handledPartitions.clear()
  cleanedLegacyPartitions.clear()
  genuiGuestSessions = new WeakSet()
  genUiPolicySessions = new WeakSet()
  genUiGuestSrcValidator = null
  genUiGuestDeepLinkForwarder = null
  genUiGuestAppDataHooks = null
  pendingGenUiAttaches = []
  delete trustedWebviewScopeResolver.getWorkspaceForWebContentsId
}

/**
 * The attach-time trust decision for one host window:
 *
 * - `scoped`: a committed fence bound to the authenticated account AND a
 *   resolved Workspace — the guest must use exactly the derived partition.
 * - `local-account`: genuinely signed out — no authenticated Admin session
 *   AND no committed fence — only the shared browser-pane partition is
 *   acceptable.
 * - `closed`: any partial state — authenticated but no fence (contract
 *   blocked, logout's revoke step, startup re-bootstrap: revoking the fence
 *   clears the fence account while the Admin session lives on), a fence
 *   bound to another account, or a missing Workspace mapping — NO partition
 *   is acceptable; the webview is prevented unconditionally.
 *
 * The authenticated account comes from a lifecycle-maintained synchronous
 * mirror (Admin session commits/ends), NOT from the runtime fence, which a
 * revoke clears together with the fence.
 */
type TabAppAttachDecision =
  | { mode: 'scoped'; partition: string; accountId: string; productSpaceId: string; workspaceId: string }
  | { mode: 'local-account' }
  | { mode: 'closed' }

function decideTabAppAttach(
  hostWebContentsId: number,
): TabAppAttachDecision {
  // The lifecycle-maintained mirror is tri-state: `unknown` means the
  // persisted credentials have not been read yet (process start before the
  // initial restore) — neither signed in nor signed out is known, so the
  // decision is fail-closed. Main awaits the initial restore before creating
  // the first window, so `unknown` is a transient strictly-narrower state.
  const accountState = getSyncTrustedProductSpaceAccountState()
  if (accountState.status === 'unknown') {
    return { mode: 'closed' }
  }
  const authenticatedAccountId = accountState.status === 'authenticated'
    ? accountState.accountId
    : null
  const fenceAccountId = getRuntimeActiveProductSpaceAccount()
  const productSpaceId = getRuntimeActiveProductSpace()
  if (!authenticatedAccountId) {
    // Confirmed signed out: a leftover fence would be unowned runtime
    // state — fail closed; otherwise the pre-ProductSpace local-account
    // window.
    return productSpaceId ? { mode: 'closed' } : { mode: 'local-account' }
  }
  if (!productSpaceId || fenceAccountId !== authenticatedAccountId) {
    // Authenticated but the ProductSpace scope is gone, mid-rebuild, or
    // bound to a replaced account — fail closed.
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
    partition: tabAppPartitionForScope({ accountId: authenticatedAccountId, productSpaceId, workspaceId }),
    accountId: authenticatedAccountId,
    productSpaceId,
    workspaceId,
  }
}

/**
 * Installs the webview permission policy on a session partition. The base
 * browser-pane partition is handled eagerly; scoped tab-app partitions are
 * attached at `will-attach-webview` (before the guest navigates) and — as
 * defense in depth — on guest web-contents creation.
 *
 * Genui canvas partitions are redirected to their own deny-all + fenced
 * policy: the loose `allow` set must never govern a generated bundle, no
 * matter which future call site passes the partition name in.
 */
function attachWebviewPermissionHandlers(partitionName: string): void {
  if (isGenUiAppPartition(partitionName)) {
    attachGenUiGuestPolicy(partitionName)
    return
  }
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

// Only Main-created persistent canvas carriers may host the named session's guest.
const genUiCarriers = new Map<number, string>()
export function registerGenUiCarrier(webContentsId: number, sessionId: string): void { genUiCarriers.set(webContentsId, sessionId) }
export function unregisterGenUiCarrier(webContentsId: number): void { genUiCarriers.delete(webContentsId) }

export function installWebviewSecurityHandlers(): void {
  attachWebviewPermissionHandlers(BROWSER_PANE_SESSION_PARTITION)

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'webview') {
      // Defense in depth: the authoritative gate is the host's
      // will-attach-webview below; this guest-side hook covers guests whose
      // window predates the resolver wiring. A session already recognized as
      // a genui canvas guest re-arms its deny-all + fenced policy here too
      // (no return: the common popup/navigation policy below still applies).
      if (genuiGuestSessions.has(contents.session)) {
        attachGenUiGuestPolicyToSession(contents.session)
      }
      const host = contents.hostWebContents
      const decision = host ? decideTabAppAttach(host.id) : { mode: 'closed' as const }
      if (decision.mode === 'scoped') {
        attachWebviewPermissionHandlers(decision.partition)
      }
    } else if (contents.getType() !== 'window' && contents.getType() !== 'browserView') {
      return
    }

    // Common webview/window policy: popups open externally (never inside the
    // guest), and only HTTP(S) navigations are allowed. Canvas guests are the
    // exception on both counts: model-generated content gets no popups at all
    // (never handed to the user's browser) and no in-guest navigation — its
    // one document is the generated bundle.
    contents.setWindowOpenHandler((details) => {
      if (genuiGuestSessions.has(contents.session)) {
        windowLog.warn(
          '[webview-security] blocked popup from a genui canvas guest',
          describeUrlForLog(details.url),
        )
        return { action: 'deny' }
      }
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
      if (genuiGuestSessions.has(contents.session)) {
        event.preventDefault()
        // POO-103: the ui-event deep link is the single sanctioned bridge —
        // forwarded Main-side (the handler re-validates the URL strictly).
        // The guest's URL never changes: the navigation stays prevented.
        if (isGenUiGuestUiEventUrl(url)) {
          if (genUiGuestDeepLinkForwarder) {
            genUiGuestDeepLinkForwarder(url, contents.id)
          } else {
            windowLog.warn(
              '[webview-security] dropped genui guest ui-event (no forwarder wired)',
              describeUrlForLog(url),
            )
          }
          return
        }
        windowLog.warn(
          '[webview-security] blocked navigation from a genui canvas guest',
          describeUrlForLog(url),
        )
        return
      }
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

    if (contents.getType() !== 'window' && contents.getType() !== 'browserView') return

    // The host window gate: when the renderer attaches a <webview>, verify
    // the guest's actual partition against the one Main derives from the
    // trusted account+ProductSpace+Workspace tuple. A mismatching, missing,
    // or unresolvable partition (compromised or buggy renderer, partial
    // scope) never loads.
    contents.on('did-attach-webview', (_event, guest) => {
      getAppSdkBridge().attachGuest(contents, guest)
      // POO-103: observe canvas guest attaches for the UiCardRegistry — the
      // registration RPC from the renderer is only honored against these
      // Main-observed records.
      if (genuiGuestSessions.has(guest.session)) {
        const pending = takePendingGenUiAttach(contents.id, guest)
        if (pending) {
          const registry = getUiCardRegistry()
          const sessionId = sessionIdFromGenUiPartition(pending.partition)
          registry.noteGuestAttached({
            guestWebContentsId: guest.id,
            hostWebContentsId: contents.id,
            sessionId,
            partition: pending.partition,
            capabilities: extractPoloBridgeCapabilities(pending.src),
          })
          // A destroyed guest drops its attach record and every card bound
          // to it — closed cards can never keep accepting events.
          guest.once('destroyed', () => {
            getUiCardRegistry().noteGuestDetached(guest.id)
            genUiGuestAppDataHooks?.onGuestDestroyed(guest.id)
          })
          // P1-3: the canvas app data channel observes the same validated
          // attach (declaration read from the exact initial src) and gets one
          // dom-ready re-injection — the attach-time push can outrun the
          // page's message listener.
          genUiGuestAppDataHooks?.onGuestAttached({
            sessionId,
            guestWebContentsId: guest.id,
            hostWebContentsId: contents.id,
            src: pending.src,
          })
          guest.once('dom-ready', () => {
            genUiGuestAppDataHooks?.onGuestDomReady(guest.id)
          })
        } else {
          windowLog.warn(
            '[webview-security] genui guest attached without a correlated will-attach record; bridge capabilities stay empty',
          )
        }
      }
    })
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      if (contents.getType() === 'browserView') {
        const sessionId = genUiCarriers.get(contents.id)
        if (!sessionId || webPreferences.partition !== `genui-app-${sessionId}`) { event.preventDefault(); return }
      }
      delete params.preload
      delete webPreferences.preload
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInSubFrames = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      const requestedPartition = webPreferences.partition
      const decision = decideTabAppAttach(contents.id)

      // Genui canvas guests: the ephemeral genui-app-* namespace is allowed in
      // every resolvable window mode (its storage is in-memory only), while an
      // incomplete scope ('closed') still blocks everything. The SDK bridge
      // stays inert here — prepareGuest only ever injects a preload for
      // registered 127.0.0.1 launch origins, never for file/data content.
      //
      // The initial src is Main-validated too (POO-102 review): a data: URL or
      // a file: URL that resolves to a generated bundle of exactly the session
      // named by the partition. A renderer-supplied arbitrary file path (or
      // any remote URL) never loads.
      if (decision.mode !== 'closed' && isGenUiAppPartition(requestedPartition)) {
        if (!isAllowedGenUiGuestSrc(requestedPartition, params.src)) {
          event.preventDefault()
          windowLog.warn(
            '[webview-security] blocked genui guest with an untrusted initial src',
            describeUrlForLog(params.src ?? ''),
          )
          return
        }
        attachGenUiGuestPolicy(requestedPartition)
        genuiGuestSessions.add(session.fromPartition(requestedPartition))
        // POO-103: remember the validated src so did-attach can extract the
        // document's bridge capability declaration Main-side (issue at mount,
        // invalidate on document change — the exact attached document is the
        // only trust input).
        queuePendingGenUiAttach({
          partition: requestedPartition,
          src: params.src ?? '',
          hostWebContentsId: contents.id,
          queuedAt: Date.now(),
        })
        return
      }


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
        getAppSdkBridge().prepareGuest(contents.id, params.src ?? '', webPreferences)
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
