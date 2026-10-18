/**
 * GenUiAppCard - Renders a generate_app canvas app inline in the transcript.
 *
 * The tool writes a single self-contained HTML file into the session data
 * directory and returns a stable marker line; this card loads that file in a
 * sandboxed <webview> using an ephemeral, non-persistent partition
 * (`genui-app-<sessionId>`), so the generated page can never reach the app's
 * cookies, the tab browser's scoped storage, or disk-backed session state.
 * Main's webview gate allow-lists exactly this partition namespace and blocks
 * every navigation/popup attempt the guest can make.
 *
 * Pinning opens the same file as a tab-browser web app (plus an audit record
 * written Main-side); the request travels over a CustomEvent so this shared
 * package stays decoupled from the Electron renderer's contexts. POO-104 adds
 * the publish action (发布为 Web App Artifact) on the same pattern: Main
 * packages the session-local bundle and the Electron-side bridge hands it to
 * the existing CreatorArtifact upload chain.
 *
 * POO-103: the card's webview registers itself with the Main-owned
 * UiCardRegistry on attach (CustomEvent bridge, same decoupling), which is
 * what admits its ui-event deep links into the host's six-step validation —
 * only when the generated bundle declared the `ui-event` bridge capability.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, Globe, Pin } from 'lucide-react'
import { cn } from '../../lib/utils'

// <webview> JSX typing comes from @types/react's WebViewHTMLAttributes
// (partition/src/webpreferences) — no local augmentation needed.

// ── Result marker (renderer-side mirror of the generate_app output) ──────────

export interface GenUiAppCall {
  appId: string
  version: number
  indexPath: string
}

/**
 * Parse the stable marker line the generate_app tool appends to its result:
 * `[genui-app id="<id>" version="<n>" path="<abs>"]`. Returns null for
 * anything that does not match — callers must tolerate partial tool output.
 */
export function parseGenUiAppResult(resultText: string | null | undefined): GenUiAppCall | null {
  if (!resultText) return null
  const match = resultText.match(/\[genui-app id="([^"]+)" version="(\d+)" path="([^"]+)"\]/)
  if (!match) return null
  const appId = match[1]
  const versionRaw = match[2]
  const indexPath = match[3]
  if (!appId || !versionRaw || !indexPath) return null
  const version = Number.parseInt(versionRaw, 10)
  if (!Number.isFinite(version) || version < 1) return null
  return { appId, version, indexPath }
}

/** Tolerant parse of the tool input; silently rejects unusable payloads. */
export function parseGenUiAppInput(input: unknown): { title: string; html: string } | null {
  if (!input || typeof input !== 'object') return null
  const title = (input as { title?: unknown }).title
  const html = (input as { html?: unknown }).html
  if (typeof title !== 'string' || title.length === 0) return null
  if (typeof html !== 'string' || html.length === 0) return null
  return { title, html }
}

// ── Ephemeral partition naming (must match Main's GENUI_APP_PARTITION_PATTERN)

/** Session ids that may name a genui partition / appear in guest URLs. */
export const GENUI_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Partition for a canvas guest: in-memory only (never `persist:`-prefixed),
 * namespaced per chat session. Unparseable session ids collapse to a shared
 * `unknown` bucket rather than smuggling arbitrary strings into Electron's
 * partition name.
 */
export function getGenUiAppPartition(sessionId: string | null | undefined): string {
  const id = sessionId && GENUI_SESSION_ID_PATTERN.test(sessionId) ? sessionId : 'unknown'
  return `genui-app-${id}`
}

/**
 * Renderer-safe equivalent of node:url's pathToFileURL() for absolute bundle
 * paths (packages/ui must stay free of node: imports — this module is bundled
 * for the webui too). Percent-encodes every path segment — spaces, '#', '?'
 * and '%' included, so a path can never be read as URL syntax — and gives
 * Windows drive paths the well-formed third slash (`file:///C:/…`), which the
 * previous hand-rolled `file://C:\…` form lacked.
 */
export function pathToFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const drive = /^([A-Za-z]:)(.+)$/.exec(normalized)
  // `(.+)` guarantees group 2 is non-empty, but indexed access types it
  // optional (noUncheckedIndexedAccess); the fallback is unreachable.
  const body = drive?.[2] ?? normalized
  const prefix = drive ? `file:///${drive[1]}` : 'file://'
  return `${prefix}${body.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * Guest source: the written bundle file when known, else the HTML inline as a
 * data URL (same-document content, no network, no disk requirement).
 */
export function buildGenUiAppSrc(indexPath: string | undefined, html: string): string {
  if (indexPath) return pathToFileUrl(indexPath)
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

// ── Pin bridge (CustomEvent request/result, Electron-side listener) ──────────

export const GENUI_APP_PIN_EVENT = 'craft:pin-genui-app'
export const GENUI_APP_PIN_RESULT_EVENT = 'craft:pin-genui-app-result'

export interface GenUiAppPinRequest {
  requestId: string
  sessionId: string
  appId: string
  title: string
  indexPath: string
  version?: number
}

export interface GenUiAppPinResult {
  requestId: string
  ok: boolean
  error?: string
}

export function dispatchGenUiAppPin(request: GenUiAppPinRequest): void {
  window.dispatchEvent(new CustomEvent<GenUiAppPinRequest>(GENUI_APP_PIN_EVENT, { detail: request }))
}

/** Electron-side bridge replies through this. */
export function dispatchGenUiAppPinResult(result: GenUiAppPinResult): void {
  window.dispatchEvent(new CustomEvent<GenUiAppPinResult>(GENUI_APP_PIN_RESULT_EVENT, { detail: result }))
}

/** Subscribe to the pin result for one requestId; returns an unsubscribe. */
export function onGenUiAppPinResult(
  requestId: string,
  handler: (result: GenUiAppPinResult) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<GenUiAppPinResult>).detail
    if (detail?.requestId !== requestId) return
    handler(detail)
  }
  window.addEventListener(GENUI_APP_PIN_RESULT_EVENT, listener)
  return () => window.removeEventListener(GENUI_APP_PIN_RESULT_EVENT, listener)
}

function createPinRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

// ── Publish bridge (POO-104: 发布为 Web App Artifact) ────────────────────────
//
// Same CustomEvent decoupling as pinning: the card asks for a publish, the
// Electron-side bridge packages the session-local bundle (Main) and hands the
// payload to the existing CreatorArtifact upload chain. The card never sees
// organization ids or zip bytes — Main derives the bundle path from the
// session identity itself, so no path crosses this boundary.

export const GENUI_APP_PUBLISH_EVENT = 'craft:publish-genui-app'
export const GENUI_APP_PUBLISH_RESULT_EVENT = 'craft:publish-genui-app-result'

export interface GenUiAppPublishRequest {
  requestId: string
  sessionId: string
  appId: string
  title: string
}

export interface GenUiAppPublishResult {
  requestId: string
  ok: boolean
  error?: string
}

export function dispatchGenUiAppPublish(request: GenUiAppPublishRequest): void {
  window.dispatchEvent(new CustomEvent<GenUiAppPublishRequest>(GENUI_APP_PUBLISH_EVENT, { detail: request }))
}

/** Electron-side bridge replies through this. */
export function dispatchGenUiAppPublishResult(result: GenUiAppPublishResult): void {
  window.dispatchEvent(new CustomEvent<GenUiAppPublishResult>(GENUI_APP_PUBLISH_RESULT_EVENT, { detail: result }))
}

/** Subscribe to the publish result for one requestId; returns an unsubscribe. */
export function onGenUiAppPublishResult(
  requestId: string,
  handler: (result: GenUiAppPublishResult) => void,
): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<GenUiAppPublishResult>).detail
    if (detail?.requestId !== requestId) return
    handler(detail)
  }
  window.addEventListener(GENUI_APP_PUBLISH_RESULT_EVENT, listener)
  return () => window.removeEventListener(GENUI_APP_PUBLISH_RESULT_EVENT, listener)
}

// ── Card registration bridge (POO-103, CustomEvent → Electron bridge) ────────

export const GENUI_CARD_REGISTER_EVENT = 'craft:register-genui-card'
export const GENUI_CARD_UNREGISTER_EVENT = 'craft:unregister-genui-card'

export interface GenUiCardRegistration {
  sessionId: string
  cardId: string
  guestWebContentsId: number
}

export function dispatchGenUiCardRegister(registration: GenUiCardRegistration): void {
  window.dispatchEvent(new CustomEvent<GenUiCardRegistration>(GENUI_CARD_REGISTER_EVENT, { detail: registration }))
}

export function dispatchGenUiCardUnregister(registration: GenUiCardRegistration): void {
  window.dispatchEvent(new CustomEvent<GenUiCardRegistration>(GENUI_CARD_UNREGISTER_EVENT, { detail: registration }))
}

// ── Card ─────────────────────────────────────────────────────────────────────

export interface GenUiAppCardProps {
  appId: string
  title: string
  html: string
  /** Absolute bundle path from the tool result; enables the pin action. */
  indexPath?: string
  version?: number
  sessionId?: string | null
  className?: string
}

/** Minimal structural view of the <webview> element's attach-time API. */
interface GenUiWebviewElement extends HTMLElement {
  getWebContentsId?: () => number
}

function createMountNonce(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().slice(0, 8)
  }
  return Math.random().toString(36).slice(2, 10)
}

export function GenUiAppCard({ appId, title, html, indexPath, version, sessionId, className }: GenUiAppCardProps) {
  const { t } = useTranslation()
  const webviewRef = React.useRef<HTMLElement | null>(null)
  const [pinState, setPinState] = React.useState<'idle' | 'pending' | 'pinned' | 'error'>('idle')
  const [pinError, setPinError] = React.useState<string | null>(null)
  const [loadFailed, setLoadFailed] = React.useState(false)
  // Per-mount card id (POO-103): two mounted instances of one app each get
  // their own UiCardRegistry entry, so both can drive ui-events safely.
  const cardId = React.useMemo(() => `${appId}-${createMountNonce()}`, [appId])
  const partition = React.useMemo(() => getGenUiAppPartition(sessionId), [sessionId])
  // The bridge needs a real bundle file: data: fallback cards get no identity
  // (and therefore no ui-event loop — their URL would be corrupted by params).
  const canBridge = Boolean(indexPath && sessionId && GENUI_SESSION_ID_PATTERN.test(sessionId))
  const src = React.useMemo(() => {
    const base = buildGenUiAppSrc(indexPath, html)
    if (!canBridge) return base
    // Identity injection for file: bundles: the query string never changes
    // the path Main's validators compare (fileURLToPath uses the pathname),
    // while the guest reads its own ids to build ui-event deep links.
    const params = new URLSearchParams({ poloCard: cardId, poloSession: sessionId! })
    return `${base}?${params.toString()}`
  }, [indexPath, html, cardId, sessionId, canBridge])

  // The guest may not navigate anywhere: its one document is the generated
  // bundle. This mirrors Main's hard block (defense in depth) and keeps the
  // initial src load (which does not emit will-navigate) untouched. The one
  // exception (POO-103): poloai:// navigations are left to Main's
  // will-navigate handler — the authoritative gate, which prevents the
  // navigation itself and forwards ui-event URLs into validation.
  React.useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return
    const blockNavigation = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail
      if (typeof detail === 'string' && detail.startsWith('poloai://')) return
      event.preventDefault()
      console.warn('[GenUiAppCard] blocked guest navigation:', detail)
    }
    const failLoad = (event: Event) => {
      const detail = (event as CustomEvent<{ isMainFrame?: boolean }>).detail
      if (detail && detail.isMainFrame === false) return
      setLoadFailed(true)
    }
    webview.addEventListener('will-navigate', blockNavigation)
    webview.addEventListener('did-fail-load', failLoad)
    return () => {
      webview.removeEventListener('will-navigate', blockNavigation)
      webview.removeEventListener('did-fail-load', failLoad)
    }
  }, [src, partition])

  // POO-103: register the mounted guest with the Main-owned UiCardRegistry
  // (via the Electron-side bridge) and unregister on unmount. Registration is
  // only honored when Main observed this very guest attach.
  React.useEffect(() => {
    const webview = webviewRef.current as GenUiWebviewElement | null
    if (!webview || !canBridge || !sessionId) return
    let registeredGuestId: number | null = null
    const handleDidAttach = () => {
      const guestId = webview.getWebContentsId?.()
      if (typeof guestId !== 'number' || guestId <= 0) return
      registeredGuestId = guestId
      dispatchGenUiCardRegister({ sessionId, cardId, guestWebContentsId: guestId })
    }
    webview.addEventListener('did-attach', handleDidAttach)
    return () => {
      webview.removeEventListener('did-attach', handleDidAttach)
      if (registeredGuestId != null) {
        dispatchGenUiCardUnregister({ sessionId, cardId, guestWebContentsId: registeredGuestId })
      }
    }
  }, [cardId, sessionId, canBridge])

  const handlePin = React.useCallback(() => {
    if (!indexPath || pinState === 'pending') return
    const requestId = createPinRequestId()
    setPinState('pending')
    setPinError(null)
    const unsubscribe = onGenUiAppPinResult(requestId, (result) => {
      unsubscribe()
      if (result.ok) {
        setPinState('pinned')
      } else {
        setPinState('error')
        setPinError(result.error ?? t('genui.app.pinFailed'))
      }
    })
    dispatchGenUiAppPin({
      requestId,
      sessionId: sessionId ?? '',
      appId,
      title,
      indexPath,
      version,
    })
  }, [appId, indexPath, pinState, sessionId, t, title, version])

  // POO-104 publish: Main packages the bundle and the Electron bridge pushes
  // it through the CreatorArtifact upload chain. Only a real bundle file in a
  // real session can publish — the same gating as the pin action.
  const canPublish = Boolean(indexPath && sessionId)
  const [publishState, setPublishState] = React.useState<'idle' | 'pending' | 'published' | 'error'>('idle')
  const [publishError, setPublishError] = React.useState<string | null>(null)

  const handlePublish = React.useCallback(() => {
    if (!canPublish || publishState === 'pending') return
    const requestId = createPinRequestId()
    setPublishState('pending')
    setPublishError(null)
    const unsubscribe = onGenUiAppPublishResult(requestId, (result) => {
      unsubscribe()
      if (result.ok) {
        setPublishState('published')
      } else {
        setPublishState('error')
        setPublishError(result.error ?? t('genui.app.publishFailed'))
      }
    })
    dispatchGenUiAppPublish({
      requestId,
      sessionId: sessionId!,
      appId,
      title,
    })
  }, [appId, canPublish, publishState, sessionId, t, title])

  return (
    <div className={cn('rounded-[8px] overflow-hidden border bg-muted/10', className)}>
      <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-1.5">
        <AppWindow className="w-3.5 h-3.5 text-muted-foreground/70 shrink-0" />
        <span className="text-[12px] text-muted-foreground font-medium truncate flex-1 min-w-0">{title}</span>
        {typeof version === 'number' && (
          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground/80 tabular-nums">
            {t('genui.app.version', { version })}
          </span>
        )}
        {indexPath && (
          <button
            type="button"
            onClick={handlePin}
            disabled={pinState === 'pending' || pinState === 'pinned'}
            className={cn(
              'shrink-0 inline-flex items-center gap-1 text-[11px] font-medium rounded-[6px] px-2 py-1 border transition-colors',
              pinState === 'pinned'
                ? 'border-success/30 text-success bg-success/[0.06]'
                : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
          >
            <Pin className="w-3 h-3" />
            {pinState === 'pinned' ? t('genui.app.pinned') : t('genui.app.pin')}
          </button>
        )}
        {canPublish && (
          <button
            type="button"
            onClick={handlePublish}
            disabled={publishState === 'pending' || publishState === 'published'}
            title={t('genui.app.publishHint')}
            className={cn(
              'shrink-0 inline-flex items-center gap-1 text-[11px] font-medium rounded-[6px] px-2 py-1 border transition-colors',
              publishState === 'published'
                ? 'border-success/30 text-success bg-success/[0.06]'
                : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
            )}
          >
            <Globe className="w-3 h-3" />
            {publishState === 'published' ? t('genui.app.published') : publishState === 'pending' ? t('genui.app.publishing') : t('genui.app.publish')}
          </button>
        )}
      </div>
      {(pinError || publishError) && (
        <div className="px-3 py-1.5 text-[11px] text-destructive/80 bg-destructive/[0.04] border-b">{publishError ?? pinError}</div>
      )}
      {loadFailed ? (
        <div className="h-[320px] flex items-center justify-center text-[12px] text-muted-foreground/70">
          {t('genui.app.loadError')}
        </div>
      ) : (
        <webview
          ref={webviewRef as React.RefObject<HTMLElement>}
          src={src}
          partition={partition}
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
          className="w-full h-[320px] bg-white"
        />
      )}
    </div>
  )
}

/**
 * Merge successive generate_app calls in one turn by app id: a later call
 * (initial or updateOf rewrite) overrides the earlier entry in place, so the
 * transcript shows one card per app with the newest content.
 */
export function mergeGenUiAppCalls(calls: Array<GenUiAppCardProps>): GenUiAppCardProps[] {
  const byId = new Map<string, GenUiAppCardProps>()
  const order: string[] = []
  for (const call of calls) {
    if (!byId.has(call.appId)) order.push(call.appId)
    byId.set(call.appId, call)
  }
  return order.map(id => byId.get(id)!)
}
