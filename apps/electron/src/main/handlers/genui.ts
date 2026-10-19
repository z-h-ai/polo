/**
 * Generative UI canvas (generate_app) GUI handlers — POO-102.
 *
 * AUDIT_APP_PIN records a canvas app being pinned into the tab browser. The
 * renderer supplies ids and metadata only; every path is derived Main-side:
 *
 * - The session directory comes from the calling window's Workspace mapping
 *   (never from the request), with the same managed-vs-storage identity
 *   cross-check the attachment flow uses.
 * - The bundle path in the request is only trusted after it resolves to
 *   exactly `<session data>/genui-apps/<appId>/index.html` for an existing
 *   file — a forged or renamed path is rejected, not clamped.
 * - pinnedAppId must be exactly `gen-ui-app-<appId>` — the derivation the
 *   renderer bridge is supposed to make, verified instead of trusted.
 * - The bundle size is checked against the remote web_app artifact policy
 *   (POO-102): an oversized bundle is refused, not pinned.
 * - The audit line is appended to `<session dir>/audit.jsonl` (JSONL, one
 *   record per pin, newest last). A failed audit write fails the pin.
 *
 * This module also owns the Main-trusted validator for a canvas guest's
 * initial webview src (see createGenUiGuestSrcValidator), wired into
 * webview-security at registration time, and the POO-103 ui-event wiring:
 * the UiCardRegistry RPC surface (register/unregister), the ui-event handler
 * deps and the canvas-guest deep-link forwarder.
 *
 * POO-104 adds the publish-chain packaging leg (PUBLISH_APP_AS_ARTIFACT):
 * Main packages the session-local canvas app into the upload ZIP behind the
 * same trust anchors as the pin audit — the renderer names only ids, every
 * path is derived here, the web_app policy gates the bundle, the audit line
 * lands BEFORE the payload is handed back, and the upload itself goes through
 * the existing admin.PUBLISH_CREATOR_APP chain (polo-app.json stays
 * upload-flow-owned; generation never pre-writes it).
 */

import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, sep } from 'node:path'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import { getWebAppArtifactPolicyState } from '@polo-ai/shared/config'
import {
  buildGenUiAppArtifactZip,
  buildGenUiPublishNotice,
  collectGenUiAppPublishFiles,
  evaluateGenUiAppPublishPolicy,
} from '@polo-ai/shared/genui'
import type { RpcServer } from '@polo-ai/server-core/transport'
import { validateSessionId } from '@polo-ai/shared/sessions'
import { GENUI_PINNED_APP_ID_PREFIX, type GenUiAppPinAuditRequest, type GenUiAppPinAuditResult, type GenUiAppPublishPackageRequest, type GenUiAppPublishPackageResult, type GenUiCardRegisterRequest, type GenUiCardRegisterResult, type GenUiCardUnregisterRequest, type GenUiCardUnregisterResult } from '../../shared/types'
import { setGenUiGuestSrcValidator, setGenUiGuestDeepLinkForwarder } from '../webview-security'
import { getUiCardRegistry } from '../ui-card-registry'
import { setGenUiUiEventDeps, handleUiEventUrl } from '../genui-ui-event'
import { getDeepLinkCallbackBridge } from '../deep-link-callback-bridge'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.genui.AUDIT_APP_PIN,
  RPC_CHANNELS.genui.REGISTER_UI_CARD,
  RPC_CHANNELS.genui.UNREGISTER_UI_CARD,
  RPC_CHANNELS.genui.PUBLISH_APP_AS_ARTIFACT,
] as const

// Mirrors the generate_app APP_ID_PATTERN (session-tools-core) — the audit
// path is only constructed from ids that pass this.
const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const APP_ID_MAX_LENGTH = 64
const AUDIT_LINE_MAX_BYTES = 16 * 1024

/**
 * Structural surfaces of the deps this module consumes — the full
 * WindowManager/SessionManager/SessionStorage classes satisfy them, and tests
 * can stand in with minimal fakes.
 */
export interface GenUiWindowManagerLike {
  getWorkspaceForWindow(webContentsId: number): string | null | undefined
}
export interface GenUiWorkspaceRef {
  id: string
  rootPath: string
}
export interface GenUiSessionManagerLike {
  getWorkspaces(): GenUiWorkspaceRef[]
  getSessionPath(sessionId: string): string | null
  /** POO-103 ui-event wiring (optional so dep-less test fakes stay minimal). */
  hasLiveSession?(sessionId: string): boolean
  queueGenUiModelContext?(sessionId: string, entry: { cardId: string; context: string }): boolean
  setGenUiSessionTeardownHook?(fn: (sessionId: string) => void): void
}
export interface GenUiSessionStorageLike {
  getSessionPath(workspaceRootPath: string, sessionId: string): string
  getDataPath(workspaceRootPath: string, sessionId: string): string
}

export interface GenUiDeps {
  windowManager?: GenUiWindowManagerLike
  sessionManager?: GenUiSessionManagerLike
  sessionStorage?: GenUiSessionStorageLike
}

export function registerGenUiHandlers(server: RpcServer, deps: GenUiDeps = {}): void {
  // Main-trusted initial-src gate for canvas webviews (POO-102): while these
  // deps are available, webview-security consults this validator for every
  // genui-app-<sessionId> guest's file: src. Until registration runs (and in
  // dep-less tests) the gate fails closed to data:-only.
  if (deps.sessionManager && deps.sessionStorage) {
    setGenUiGuestSrcValidator(createGenUiGuestSrcValidator(deps))
  }

  // POO-103 ui-event wiring: deps, deep-link forwarder, and the
  // session-destruction hook that clears the registry. Everything fails
  // closed while the session manager lacks the ui-event surface.
  const registry = getUiCardRegistry()
  const sessionManager = deps.sessionManager
  if (sessionManager?.hasLiveSession && sessionManager.queueGenUiModelContext) {
    setGenUiUiEventDeps({
      registry,
      bridge: getDeepLinkCallbackBridge(),
      hasLiveSession: sessionId => sessionManager.hasLiveSession!(sessionId),
      queueGenUiModelContext: (sessionId, entry) => sessionManager.queueGenUiModelContext!(sessionId, entry),
      resolveSessionDataPath: createSessionDataPathResolver(deps),
    })
    sessionManager.setGenUiSessionTeardownHook?.(sessionId => {
      registry.clearSession(sessionId)
    })
    setGenUiGuestDeepLinkForwarder((url, guestWebContentsId) => {
      handleUiEventUrl(url, guestWebContentsId)
    })
  }

  server.handle(RPC_CHANNELS.genui.AUDIT_APP_PIN, async (ctx, request: GenUiAppPinAuditRequest): Promise<GenUiAppPinAuditResult> => {
    try {
      if (!request || typeof request !== 'object') throw new Error('Invalid audit request')
      const { sessionId, appId, title, indexPath, version, pinnedAppId } = request
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing session id')
      if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId) || appId.length > APP_ID_MAX_LENGTH) {
        throw new Error('Invalid app id')
      }
      if (typeof pinnedAppId !== 'string' || pinnedAppId.length === 0 || pinnedAppId.length > 128) {
        throw new Error('Invalid pinned app id')
      }
      // pinnedAppId is never trusted as a name: it must be exactly the
      // gen-ui-app-<appId> derivation of the audited appId, so an audit line
      // can never tie one app's bundle to another app's tab-browser entry.
      if (pinnedAppId !== `${GENUI_PINNED_APP_ID_PREFIX}${appId}`) {
        throw new Error(`pinnedAppId must be ${GENUI_PINNED_APP_ID_PREFIX}<appId>`)
      }
      if (typeof title !== 'string' || title.length === 0 || title.length > 200) throw new Error('Invalid title')
      if (typeof indexPath !== 'string' || indexPath.length === 0) throw new Error('Missing bundle path')
      if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version < 1)) {
        throw new Error('Invalid version')
      }

      // The calling window's Workspace mapping is the only trust anchor — a
      // renderer cannot name another workspace's session directory.
      const { sessionPath, dataPath } = resolveTrustedSessionContext(ctx, deps, sessionId)

      // The audited bundle must be exactly the generate_app artifact for this
      // app id — resolve() both sides, then require the request path to equal
      // the derived one (no "close enough", no clamping into place).
      const expectedIndexPath = resolve(dataPath, 'genui-apps', appId, 'index.html')
      if (resolve(indexPath) !== expectedIndexPath) {
        throw new Error('Bundle path does not match the generated artifact for this app')
      }
      if (!existsSync(expectedIndexPath) || !statSync(expectedIndexPath).isFile()) {
        throw new Error('Bundle file not found')
      }

      // Pin gate (POO-102): the remote web_app artifact policy bounds what
      // may be pinned, on top of the generation-side hard cap — a bundle
      // above the policy's maxBundleBytes is refused, not recorded.
      const policyState = getWebAppArtifactPolicyState()
      const bundleBytes = statSync(expectedIndexPath).size
      if (bundleBytes > policyState.maxBundleBytes) {
        throw new Error(
          `Bundle exceeds the web_app policy limit: ${bundleBytes} > ${policyState.maxBundleBytes} bytes`
        )
      }

      const record = {
        event: 'genui_app_pin',
        at: new Date().toISOString(),
        sessionId,
        appId,
        version: version ?? null,
        title,
        indexPath: expectedIndexPath,
        pinnedAppId,
        webContentsId: ctx.webContentsId ?? null,
      }
      const line = JSON.stringify(record)
      if (Buffer.byteLength(line, 'utf8') > AUDIT_LINE_MAX_BYTES) {
        throw new Error('Audit record too large')
      }
      appendFileSync(join(sessionPath, 'audit.jsonl'), `${line}\n`, { encoding: 'utf-8', flag: 'a' })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // POO-104 publish chain, packaging leg: package the session-local canvas
  // app into the upload payload. Same trust anchors as the pin audit; the
  // audit line lands BEFORE the payload is handed back, so a publish package
  // can never leave the device unrecorded.
  server.handle(RPC_CHANNELS.genui.PUBLISH_APP_AS_ARTIFACT, async (ctx, request: GenUiAppPublishPackageRequest): Promise<GenUiAppPublishPackageResult> => {
    try {
      if (!request || typeof request !== 'object') throw new Error('Invalid publish request')
      const { sessionId, appId, title } = request
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing session id')
      if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId) || appId.length > APP_ID_MAX_LENGTH) {
        throw new Error('Invalid app id')
      }
      if (typeof title !== 'string' || title.length === 0 || title.length > 200) throw new Error('Invalid title')

      // Trust anchor + path derivation: the renderer names ids only; the app
      // directory comes from the calling window's workspace mapping.
      const { sessionPath, dataPath } = resolveTrustedSessionContext(ctx, deps, sessionId)
      const appDir = resolve(dataPath, 'genui-apps', appId)
      const indexPath = join(appDir, 'index.html')
      if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
        throw new Error(`Bundle file not found for app: ${appId}`)
      }

      // Layout + policy gates, both fail-closed, in that order: the layout
      // decides what would be packaged, the policy decides whether it may be.
      const collected = collectGenUiAppPublishFiles(appDir)
      if (!collected.ok) throw new Error(collected.error)
      const policyVerdict = evaluateGenUiAppPublishPolicy(collected.files, getWebAppArtifactPolicyState())
      if (!policyVerdict.ok) throw new Error(policyVerdict.error)

      const archive = buildGenUiAppArtifactZip(collected.files)
      const checksum = createHash('sha256').update(archive).digest('hex')

      // Audit-first (same contract as the pin): a failed audit write fails
      // the packaging, so no payload is ever produced unrecorded.
      const version = readGenUiAppVersion(appDir)
      const record = {
        event: 'genui_app_publish',
        at: new Date().toISOString(),
        sessionId,
        appId,
        version,
        title,
        checksum,
        sizeBytes: archive.byteLength,
        fileCount: collected.files.length,
        webContentsId: ctx.webContentsId ?? null,
      }
      const line = JSON.stringify(record)
      if (Buffer.byteLength(line, 'utf8') > AUDIT_LINE_MAX_BYTES) {
        throw new Error('Audit record too large')
      }
      appendFileSync(join(sessionPath, 'audit.jsonl'), `${line}\n`, { encoding: 'utf-8', flag: 'a' })

      return {
        ok: true,
        payloadBase64: Buffer.from(archive).toString('base64'),
        // The analyzed entry the admin publish chain expects for a static
        // bundle (CREATOR_APP_CANONICAL_ENTRIES.static).
        entry: { runtime: 'static', path: 'index.html' },
        checksum,
        sizeBytes: archive.byteLength,
        fileCount: collected.files.length,
        policyNotice: buildGenUiPublishNotice(),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // POO-103: card registration. The renderer reports a mounted canvas
  // webview; Main honors it ONLY when its own attach observation agrees
  // (guest id known, same session, same host window). The host window id
  // comes from the RPC context — the renderer never names it.
  server.handle(RPC_CHANNELS.genui.REGISTER_UI_CARD, async (ctx, request: GenUiCardRegisterRequest): Promise<GenUiCardRegisterResult> => {
    try {
      if (!request || typeof request !== 'object') throw new Error('Invalid register request')
      const { sessionId, cardId, guestWebContentsId } = request
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing session id')
      if (typeof cardId !== 'string' || cardId.length === 0 || cardId.length > 128) throw new Error('Invalid card id')
      if (typeof guestWebContentsId !== 'number' || !Number.isInteger(guestWebContentsId) || guestWebContentsId <= 0) {
        throw new Error('Invalid guest webContents id')
      }
      const hostWebContentsId = ctx.webContentsId
      if (typeof hostWebContentsId !== 'number') throw new Error('Cannot determine the calling window')
      const verdict = registry.registerCard({ sessionId, cardId, guestWebContentsId, hostWebContentsId })
      if (!verdict.ok) {
        throw new Error(`Card registration rejected: ${verdict.reason}`)
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_CHANNELS.genui.UNREGISTER_UI_CARD, async (ctx, request: GenUiCardUnregisterRequest): Promise<GenUiCardUnregisterResult> => {
    try {
      if (!request || typeof request !== 'object') throw new Error('Invalid unregister request')
      const { sessionId, cardId } = request
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('Missing session id')
      if (typeof cardId !== 'string' || cardId.length === 0 || cardId.length > 128) throw new Error('Invalid card id')
      // Only the window that registered a card may unregister it — one
      // renderer cannot drop another window's card out of the loop.
      const existing = registry.getCard(sessionId, cardId)
      if (existing && existing.hostWebContentsId !== ctx.webContentsId) {
        return { ok: false, error: 'Card belongs to a different window' }
      }
      registry.unregisterCard(sessionId, cardId)
      // Unregistration is idempotent — a missed unmount (window closed before
      // the RPC) is already covered by the guest-destroyed hook Main-side.
      return { ok: true }
    } catch (error) {
      return { ok: false }
    }
  })
}

/**
 * The trust anchor shared by the pin audit and the publish packaging: the
 * calling window's Workspace mapping is the only anchor — a renderer cannot
 * name another workspace's session directory. SECURITY: sessionId is
 * path-checked before any path composition, and the managed-vs-storage
 * identity cross-check rejects a moved or fabricated session.
 */
function resolveTrustedSessionContext(
  ctx: { workspaceId?: string | null; webContentsId?: number | null },
  deps: GenUiDeps,
  sessionId: string,
): { sessionPath: string; dataPath: string } {
  const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
  if (!workspaceId) throw new Error('Cannot determine workspace for the genui request')
  const sessionManager = deps.sessionManager
  if (!sessionManager) throw new Error('Session manager is unavailable')
  const storage = deps.sessionStorage
  if (!storage) throw new Error('Session storage resolver is unavailable')
  const workspace = sessionManager.getWorkspaces()
    .find(candidate => candidate.id === workspaceId)
  if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
  validateSessionId(sessionId)
  const managedSessionPath = sessionManager.getSessionPath(sessionId)
  if (!managedSessionPath) throw new Error(`Session not found: ${sessionId}`)
  const sessionPath = storage.getSessionPath(workspace.rootPath, sessionId)
  if (resolve(managedSessionPath) !== resolve(sessionPath)) {
    throw new Error(`Session storage identity mismatch: ${sessionId}`)
  }
  return { sessionPath, dataPath: storage.getDataPath(workspace.rootPath, sessionId) }
}

/**
 * Tolerant read of the session-local version.json a generate_app write leaves
 * next to index.html. Publish bookkeeping only — a missing or malformed file
 * publishes with version: null rather than failing the chain.
 */
function readGenUiAppVersion(appDir: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(join(appDir, 'version.json'), 'utf-8')) as { version?: unknown }
    return typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > 0 ? raw.version : null
  } catch {
    return null
  }
}

/**
 * POO-103: session data/ resolver for ui-event payloadSrc confinement — same
 * managed-vs-storage identity cross-check as the src validator, resolved per
 * session at validation time (a session that moved workspaces re-resolves).
 */
export function createSessionDataPathResolver(deps: GenUiDeps): (sessionId: string) => string | null {
  return (sessionId) => {
    try {
      const sessionManager = deps.sessionManager
      const storage = deps.sessionStorage
      if (!sessionManager || !storage) return null
      validateSessionId(sessionId)
      const managedSessionPath = sessionManager.getSessionPath(sessionId)
      if (!managedSessionPath) return null
      for (const workspace of sessionManager.getWorkspaces()) {
        const storageSessionPath = storage.getSessionPath(workspace.rootPath, sessionId)
        if (resolve(managedSessionPath) !== resolve(storageSessionPath)) continue
        return storage.getDataPath(workspace.rootPath, sessionId)
      }
      return null
    } catch {
      return null
    }
  }
}

/**
 * The Main-trusted verdict for a canvas guest's initial file: src (wired into
 * webview-security above). The src may only be the generate_app entry of the
 * very session the partition names:
 *
 * - the session id is re-validated and resolved through the SessionManager
 *   (never from the request alone),
 * - the managed-vs-storage path identity is cross-checked exactly like the
 *   audit flow, so a session that moved workspaces (or a fabricated one)
 *   cannot satisfy the check,
 * - the decoded path must equal
 *   `<session data>/genui-apps/<appId>/index.html` for a well-formed appId —
 *   derived by comparison against the storage-derived path, not by clamping.
 *
 * data: srcs never reach this validator (allowed directly by webview-security
 * as inert); any other scheme is rejected there.
 */
export function createGenUiGuestSrcValidator(deps: GenUiDeps): (sessionId: string, src: string) => boolean {
  return (sessionId, src) => {
    try {
      const sessionManager = deps.sessionManager
      const storage = deps.sessionStorage
      if (!sessionManager || !storage) return false
      validateSessionId(sessionId)
      const managedSessionPath = sessionManager.getSessionPath(sessionId)
      if (!managedSessionPath) return false

      let candidatePath: string
      try {
        candidatePath = resolve(fileURLToPath(new URL(src)))
      } catch {
        return false
      }
      // Shape gate first: .../genui-apps/<appId>/index.html with a
      // generate_app-shaped appId. The workspace loop below then requires the
      // exact storage-derived twin of this path.
      const bundleMatch = /^(.+)[/]genui-apps[/]([A-Za-z0-9][A-Za-z0-9_-]*)[/]index\.html$/.exec(
        candidatePath.split(sep).join('/')
      )
      if (!bundleMatch) return false

      for (const workspace of sessionManager.getWorkspaces()) {
        const storageSessionPath = storage.getSessionPath(workspace.rootPath, sessionId)
        if (resolve(managedSessionPath) !== resolve(storageSessionPath)) continue
        const expectedIndexPath = resolve(
          storage.getDataPath(workspace.rootPath, sessionId),
          'genui-apps',
          bundleMatch[2],
          'index.html',
        )
        if (candidatePath === expectedIndexPath) return true
      }
      return false
    } catch {
      return false
    }
  }
}
