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
 * pane from session B. Reuse is workspace-scoped first (a session id is only
 * unique within its workspace; both local and remote-mirror aliases of the
 * citing workspace count). Opens sharing one scope are serialized because
 * `api.create` is get-or-create, and an instance is only ever destroyed while
 * the call can still prove it obtained it from `create` AND never delivered
 * it — a user's existing browser is never torn down because a navigation
 * into it failed.
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
  /**
   * The remote-mirror workspace id of the SAME conceptual workspace (read
   * from `activeWorkspace.remoteServer.remoteWorkspaceId` — the same
   * authoritative alias `filterInstancesForWorkspace` consumes). A remote
   * agent stamps its tabs with this id, so an instance of this workspace may
   * legitimately carry either id. Optional/nullable = unknown.
   */
  remoteWorkspaceId?: string | null
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
  return (
    a.sessionId === b.sessionId &&
    a.workspaceId === b.workspaceId &&
    (a.remoteWorkspaceId ?? null) === (b.remoteWorkspaceId ?? null)
  )
}

/**
 * Workspace ids that count as "ours" for reuse: the local workspace id plus
 * the remote-mirror alias of the same conceptual workspace, when known.
 */
function ownedWorkspaceIds(scope: CitationSourceScope): string[] {
  return [scope.workspaceId, scope.remoteWorkspaceId ?? null].filter(
    (id): id is string => !!id
  )
}

/**
 * Ownership filter for reusing an existing browser for a citation.
 *
 * Workspace ownership is checked FIRST, for session-bound and unbound
 * instances alike: a session id is only unique WITHIN its workspace, so the
 * same id can legally exist in two workspaces (`storage.ts` dedupes per
 * workspace) — a name match alone must never adopt another workspace's
 * window. Both aliases of the citing workspace count; an instance with no
 * workspace stamp, a scope with no workspace context, or a stamp outside the
 * alias set is of unknown/foreign ownership and is NEVER reused.
 */
export function canReuseForCitationSource(
  info: BrowserInstanceInfo,
  scope: CitationSourceScope,
): boolean {
  if (!info) return false

  const ourWorkspaces = ownedWorkspaceIds(scope)
  if (!info.workspaceId || ourWorkspaces.length === 0) return false
  if (!ourWorkspaces.includes(info.workspaceId)) return false

  if (scope.sessionId && info.ownerSessionId === scope.sessionId) return true
  // A workspace-level (unbound) window of OUR workspace may be adopted.
  return !info.ownerSessionId
}

/**
 * One open-at-a-time per citation scope, shared by every opener in this
 * renderer process. `api.create` is get-or-create (Main's `createForSession`
 * returns an already-bound instance or adopts an existing manual one), so
 * two interleaved opens for the same scope resolve to the SAME instance id —
 * interleaved create/navigate/focus/destroy steps could then recycle a
 * browser another call had already delivered. Serializing per scope removes
 * that race inside this renderer; the ownership checks below cover what
 * remains across windows.
 */
const scopeOpenQueues = new Map<string, Promise<CitationSourceOutcome>>()

/**
 * Instance ids THIS renderer obtained from `create` and has not delivered
 * yet. An id that was already present in the `list()` snapshot taken before
 * the call (adopted via get-or-create) is never registered here, and a
 * registered id leaves the set the moment it is delivered (focused) — so an
 * instance is only ever destroyed while this call can still prove it created
 * it AND never presented it to the user.
 */
const undeliveredOwnCreations = new Set<string>()

function scopeQueueKey(scope: CitationSourceScope): string {
  return `${scope.sessionId ?? ''}|${scope.workspaceId ?? ''}|${scope.remoteWorkspaceId ?? ''}`
}

function enqueueScopedOpen(
  key: string,
  run: () => Promise<CitationSourceOutcome>,
): Promise<CitationSourceOutcome> {
  const previous = scopeOpenQueues.get(key)
  // A failed predecessor must not block the next open for the same scope.
  const next = (previous ?? Promise.resolve()).then(run, run)
  scopeOpenQueues.set(key, next)
  void next.catch(() => {}).finally(() => {
    if (scopeOpenQueues.get(key) === next) scopeOpenQueues.delete(key)
  })
  return next
}

/**
 * Destroy an instance ONLY while this call can still prove it (a) obtained
 * it from `create` in THIS renderer and (b) never delivered it. Every proof
 * is re-checked after each await — `create` is get-or-create, another window
 * may have presented the same id in the meantime, and a visible instance is
 * by definition already the user's — and any doubt leaves it alone.
 */
async function recycleUndeliveredCreation(api: BrowserPaneApi, id: string): Promise<void> {
  if (!undeliveredOwnCreations.has(id)) return
  try {
    const info = (await api.list()).find((candidate) => candidate?.id === id)
    if (!undeliveredOwnCreations.has(id)) return
    if (info?.isVisible) {
      // Already presented to the user somewhere — ownership is lost.
      undeliveredOwnCreations.delete(id)
      return
    }
  } catch {
    // Cannot verify state — never destroy on doubt.
    return
  }
  undeliveredOwnCreations.delete(id)
  await api.destroy(id).catch(() => {})
}

/**
 * Build the assistant-markdown citation opener. The returned callback keeps
 * `options` in a ref so its identity stays stable across renders (same
 * discipline as useLinkInterceptor) while always reading the CURRENT scope.
 */
export function createCitationSourceOpener(options: CitationSourceOpenerOptions): CitationSourceOpener {
  const optionsRef = { current: options }

  const openNow = async (url: string, startScope: CitationSourceScope): Promise<CitationSourceOutcome> => {
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
    //
    // `create` is get-or-create: the id it resolves with may be an instance
    // that ALREADY existed (already bound, or an adopted manual window). The
    // `instances` snapshot above is the pre-create list, so a returned id
    // that is already in it was adopted, NOT created by this call — an
    // adopted instance is never registered as ours and never destroyed.
    const preCreateIds = new Set(instances.map((info) => info.id))
    let createdId: string | null = null
    try {
      createdId = await api.create({
        show: false,
        bindToSessionId: startScope.sessionId ?? undefined,
      })
      if (!preCreateIds.has(createdId)) undeliveredOwnCreations.add(createdId)
      if (!sameScope(optionsRef.current.getSessionScope(), startScope)) {
        // Never navigated, never delivered — recycle immediately.
        await recycleUndeliveredCreation(api, createdId)
        return { status: 'stale' }
      }
      try {
        await api.navigate(createdId, target.url)
      } catch (startupError) {
        await new Promise((resolve) => setTimeout(resolve, 700))
        if (!sameScope(optionsRef.current.getSessionScope(), startScope)) {
          await recycleUndeliveredCreation(api, createdId)
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
        await recycleUndeliveredCreation(api, createdId)
        return { status: 'stale' }
      }
      await api.focus(createdId)
      // Delivered: the sidebar sync now presents this instance to the user.
      // Ownership is released — a delivered browser is never torn down by
      // this module, whatever fails later.
      undeliveredOwnCreations.delete(createdId)
      return { status: 'opened-in-browser', instanceId: createdId, reused: false }
    } catch (error) {
      if (createdId) {
        // Creation/navigate/focus failed before delivery — recycle it ONLY
        // while this call can still prove it created and never delivered it.
        await recycleUndeliveredCreation(api, createdId)
      }
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const opener: CitationSourceOpener = (url: string) => {
    // Serialize opens that share the click's scope (double-clicks, a burst of
    // citations in one chat) so their get-or-create calls cannot interleave.
    // The scope is captured SYNCHRONOUSLY at the click: it is both the queue
    // key and the stale-check baseline, so a switch that happens before the
    // queued open runs is still detected as stale.
    const startScope = optionsRef.current.getSessionScope()
    return enqueueScopedOpen(scopeQueueKey(startScope), () => openNow(url, startScope))
  }

  return opener
}
