/**
 * POO-172: dedicated opener for citation sources rendered in assistant
 * markdown (CITE-01/CITE-02).
 *
 * The existing `onOpenUrl` channel stays the business channel (error-card
 * `open_url` actions, settings/payment handoffs, user messages, global
 * PlatformActions). Assistant markdown sources route through THIS module
 * instead so a plain https citation opens in Polo's built-in browser while
 * every other URL class keeps its existing behavior:
 *
 * - http/https  → the in-app browserPane (create hidden → navigate → focus;
 *                 the existing sidebar sync presents it via `onOpenRequested`)
 * - file paths / file: URLs → the existing file preview (onOpenFile)
 * - poloai:     → the existing deep-link channel (onExternalUrl)
 * - other registered external schemes (mailto:, obsidian:, …) → the existing
 *   external channel (onExternalUrl) — general external-link behavior is NOT
 *   re-routed by this card
 * - dangerous / unparseable targets → rejected with a reason; they never
 *   reach browserPane and never fall back to an external open
 *
 * Scope discipline: every async step re-checks the session/workspace the
 * click started in. A late response for session A must not steal the browser
 * pane from session B, and a freshly created instance is only destroyed when
 * it was created by this call AND never delivered — a user's existing browser
 * is never torn down because a navigation into it failed.
 */

import { classifyExternalUrl } from '@polo-ai/shared/utils/url-safety'
import { resolveMarkdownLinkTarget } from '@polo-ai/ui/markdown/link-target'
import type { BrowserInstanceInfo } from '../../shared/types'

/** Where a clicked citation target should go. */
export type CitationSourceTarget =
  | { kind: 'browser'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'deeplink'; url: string }
  | { kind: 'external'; url: string }
  | { kind: 'blocked'; reason: string }

const INTERNAL_DEEPLINK_SCHEME = 'poloai:'

/**
 * Classify one citation target. Only parsable http/https URLs are allowed
 * into the built-in browser — the plan forbids guessing search links from
 * bare text, and dangerous schemes are rejected outright.
 */
export function resolveCitationSourceTarget(rawUrl: string): CitationSourceTarget {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!trimmed) {
    return { kind: 'blocked', reason: 'Citation source URL is empty.' }
  }

  const linkTarget = resolveMarkdownLinkTarget(trimmed)
  if (linkTarget.kind === 'file') {
    return { kind: 'file', path: linkTarget.path }
  }

  const classification = classifyExternalUrl(trimmed)
  if (classification.kind === 'dangerous') {
    return { kind: 'blocked', reason: classification.reason }
  }
  if (classification.kind === 'internal-deeplink') {
    return { kind: 'deeplink', url: trimmed }
  }

  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { kind: 'browser', url: parsed.toString() }
    }
  } catch {
    return { kind: 'blocked', reason: 'Citation source URL is malformed and cannot be parsed.' }
  }

  // Registered non-web scheme (mailto:, obsidian:, vscode:, …): keep the
  // pre-existing external behavior instead of inventing a browser tab for it.
  return { kind: 'external', url: trimmed }
}

/** The session/workspace a citation click belongs to. */
export interface CitationSourceScope {
  sessionId: string | null
  workspaceId: string | null
}

/** Terminal outcome of one `openCitationSource` call (assertion-friendly). */
export type CitationSourceOutcome =
  | { status: 'opened-in-browser'; instanceId: string; reused: boolean }
  | { status: 'opened-file'; path: string }
  | { status: 'opened-deeplink'; url: string }
  | { status: 'opened-external'; url: string }
  | { status: 'blocked'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'stale' }

export interface CitationSourceOpenerOptions {
  /** Latest session/workspace identity — re-read after every await. */
  getSessionScope: () => CitationSourceScope
  /** Existing in-app file preview channel (file targets keep using it). */
  onOpenFile: (path: string) => void
  /** Existing external/deep-link channel — NOT replaced or re-routed. */
  onExternalUrl: (url: string) => void
  /** User-facing feedback for rejected targets (dangerous schemes etc.). */
  onBlocked?: (reason: string) => void
  /**
   * Observability hook: the one-shot startup-race retry fired for a fresh
   * instance (the first navigate was aborted by Main's empty-state load).
   */
  onStartupRetry?: (firstError: string) => void
}

export interface CitationSourceOpener {
  (url: string): Promise<CitationSourceOutcome>
}

interface BrowserPaneApi {
  create(input?: { show?: boolean; bindToSessionId?: string }): Promise<string>
  destroy(id: string): Promise<void>
  list(): Promise<BrowserInstanceInfo[]>
  navigate(id: string, url: string): Promise<unknown>
  focus(id: string): Promise<void>
}

function getBrowserPaneApi(): BrowserPaneApi | null {
  const api = (window as { electronAPI?: { browserPane?: BrowserPaneApi } }).electronAPI?.browserPane
  return api ?? null
}

function sameScope(a: CitationSourceScope, b: CitationSourceScope): boolean {
  return a.sessionId === b.sessionId && a.workspaceId === b.workspaceId
}

/**
 * Ownership filter for reusing an existing browser for a citation: only an
 * instance bound to the citing session, or a workspace-level window of the
 * citing workspace, qualifies. Another session's bound browser and another
 * workspace's window are never reused (and never detached).
 */
export function canReuseForCitationSource(
  info: BrowserInstanceInfo,
  scope: CitationSourceScope,
): boolean {
  if (!info) return false
  if (scope.sessionId && info.ownerSessionId === scope.sessionId) return true
  if (!info.ownerSessionId && scope.workspaceId && info.workspaceId === scope.workspaceId) return true
  return false
}

/**
 * Build the assistant-markdown citation opener. The returned callback keeps
 * `options` in a ref so its identity stays stable across renders (same
 * discipline as useLinkInterceptor) while always reading the CURRENT scope.
 */
export function createCitationSourceOpener(options: CitationSourceOpenerOptions): CitationSourceOpener {
  const optionsRef = { current: options }

  const opener = async (url: string): Promise<CitationSourceOutcome> => {
    const target = resolveCitationSourceTarget(url)

    if (target.kind === 'blocked') {
      optionsRef.current.onBlocked?.(target.reason)
      return { status: 'blocked', reason: target.reason }
    }
    if (target.kind === 'file') {
      optionsRef.current.onOpenFile(target.path)
      return { status: 'opened-file', path: target.path }
    }
    if (target.kind === 'deeplink') {
      optionsRef.current.onExternalUrl(target.url)
      return { status: 'opened-deeplink', url: target.url }
    }
    if (target.kind === 'external') {
      optionsRef.current.onExternalUrl(target.url)
      return { status: 'opened-external', url: target.url }
    }

    const api = getBrowserPaneApi()
    if (!api) {
      return { status: 'failed', reason: 'Browser pane API is unavailable.' }
    }

    const startScope = optionsRef.current.getSessionScope()
    if (!startScope.sessionId && !startScope.workspaceId) {
      return { status: 'failed', reason: 'No session or workspace context for this citation.' }
    }

    // Reuse: an existing visible-for-us instance is navigated in place. A
    // navigation failure on a pre-existing browser never destroys it and is
    // never retried against a fresh instance (same URL, same risk).
    let instances: BrowserInstanceInfo[]
    try {
      instances = await api.list()
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
    if (!sameScope(optionsRef.current.getSessionScope(), startScope)) {
      return { status: 'stale' }
    }
    const reusable = instances.find((info) => canReuseForCitationSource(info, startScope))
    if (reusable) {
      try {
        await api.navigate(reusable.id, target.url)
      } catch (error) {
        return {
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        }
      }
      if (!sameScope(optionsRef.current.getSessionScope(), startScope)) {
        // Delivered to an instance the user may already see — leave it be.
        return { status: 'stale' }
      }
      try {
        await api.focus(reusable.id)
      } catch (error) {
        // Content is already in place; a focus failure is not worth tearing
        // down a browser the user owns.
        console.warn('[open-citation-source] focus failed on reused instance:', error)
      }
      return { status: 'opened-in-browser', instanceId: reusable.id, reused: true }
    }

    // Fresh instance: hidden create → navigate → focus. `focus` hands
    // presentation to the existing sidebar sync (`onOpenRequested`).
    //
    // `create` resolves while Main is still settling the new view's
    // empty-state page, so the very first navigate can be aborted by that
    // load (an ERR_ABORTED → about:blank chain). One retry covers that
    // startup race on an instance THIS call created; anything still failing
    // afterwards falls through to the recycle below. A pre-existing browser
    // (the reuse path above) is never retried.
    let createdId: string | null = null
    try {
      createdId = await api.create({
        show: false,
        bindToSessionId: startScope.sessionId ?? undefined,
      })
      if (!sameScope(optionsRef.current.getSessionScope(), startScope)) {
        // Never navigated, never delivered — recycle immediately.
        await api.destroy(createdId).catch(() => {})
        return { status: 'stale' }
      }
      try {
        await api.navigate(createdId, target.url)
      } catch (startupError) {
        await new Promise((resolve) => setTimeout(resolve, 700))
        if (!sameScope(optionsRef.current.getSessionScope(), startScope)) {
          await api.destroy(createdId).catch(() => {})
          return { status: 'stale' }
        }
        optionsRef.current.onStartupRetry?.(
          startupError instanceof Error ? startupError.message : String(startupError)
        )
        await api.navigate(createdId, target.url)
      }
      if (!sameScope(optionsRef.current.getSessionScope(), startScope)) {
        // Never delivered — the user moved on mid-flight. Recycle ONLY this
        // not-yet-delivered instance so no hidden orphan survives.
        await api.destroy(createdId).catch(() => {})
        return { status: 'stale' }
      }
      await api.focus(createdId)
      return { status: 'opened-in-browser', instanceId: createdId, reused: false }
    } catch (error) {
      if (createdId) {
        // Creation/navigate/focus failed before delivery — recycle this
        // call's own instance; a user-facing browser is never touched here.
        await api.destroy(createdId).catch(() => {})
      }
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  return opener
}
