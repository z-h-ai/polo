import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClientColleagueOption,
  ClientColleagueSource,
} from '@polo-ai/shared/admin/client-enterprise-contract'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { membersErrorKey } from './useProjectMembers'

/**
 * POO-196 R3 colleague-directory state hook (adjudication D3).
 *
 * The desktop only pages the restricted projection polo-admin serves for the
 * caller's OWN organization into the committed project — the source
 * enterprise is derived server-side and is NEVER a wire field. `none` and
 * `ambiguous` source states are SUCCESS bodies with their own fallback copy
 * (direct phone/email invitation), not failures.
 *
 * Name search is resolved server-side over the FULL source directory before
 * pagination (D3), so changing `q` invalidates every loaded page: the hook
 * resets to the first page and the previous cursor is never replayed against
 * a different query. Every scope change (account / project / asserted source)
 * clears everything and bumps the generation, so an in-flight response from
 * the previous scope is discarded instead of being published into the wrong
 * panel. Nothing here is persisted — not the directory, not the cursors.
 */

export type ProjectColleaguesScope = {
  accountId: string
  productSpaceId: string
  /** The panel's asserted directory source (from the R3 project view model).
   * Scope-consistency ONLY: a change clears the page. It is not sent to the
   * server — the admin derives the real source from the caller's own
   * membership on every page read. */
  sourceEnterpriseId?: string | null
}

export type ColleagueSourceState = 'none' | 'ambiguous' | 'available' | null

export type ProjectColleaguesState = {
  members: ClientColleagueOption[]
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  /** i18n key of the load failure (first page or a failed continuation). */
  errorKey: string | null
  sourceState: ColleagueSourceState
  source: ClientColleagueSource | null
  /** `none`/`ambiguous` are success faces with their own copy (D3). */
  sourceNoticeKey: string | null
}

export const COLLEAGUES_PAGE_LIMIT = 20

function emptyColleagues(): ProjectColleaguesState {
  return {
    members: [],
    nextCursor: null,
    loading: false,
    loadingMore: false,
    errorKey: null,
    sourceState: null,
    source: null,
    sourceNoticeKey: null,
  }
}

function sourceNoticeKeyOf(state: ProjectColleaguesState['sourceState']): string | null {
  switch (state) {
    case 'none':
      return 'projectMembers.directory.noSource'
    case 'ambiguous':
      return 'projectMembers.directory.ambiguousSource'
    default:
      return null
  }
}

/** i18n key for a directory load failure. The D5 colleague code has its own
 * copy; everything else falls through to the shared pm mapping. */
export function colleaguesErrorKey(code: string | null): string {
  if (code === 'colleague_source_unavailable') {
    return 'projectMembers.directory.sourceUnavailable'
  }
  return membersErrorKey(code)
}

/** Per-member badge key for the server-computed projectState (D3): the
 * server derived it from the real membership and invitation state, the
 * client never re-classifies. `available` renders no badge. */
export function colleagueProjectStateKeyOf(member: ClientColleagueOption): string | null {
  switch (member.projectState) {
    case 'joined':
      return 'projectMembers.directory.joined'
    case 'pending':
      return 'projectMembers.directory.pending'
    case 'unavailable':
      return 'projectMembers.directory.unavailable'
    default:
      return null
  }
}

export function useProjectColleagues(scope: ProjectColleaguesScope | null) {
  const scopeKey = scope
    ? `${scope.accountId}:${scope.productSpaceId}:${scope.sourceEnterpriseId ?? ''}`
    : null

  const [state, setState] = useState<ProjectColleaguesState>(emptyColleagues)
  const [query, setQuery] = useState('')
  /** Per-scope generation: any load/search/scope change invalidates every
   * still-in-flight response, so a slow first page can never land in a
   * panel that has already moved to another account/project/source. */
  const generationRef = useRef(0)
  /** The query the CURRENT pages were loaded with — cursors are bound to it
   * server-side, so loadMore only ever replays `nextCursor` with this q. */
  const loadedQueryRef = useRef('')
  /** Mirrors `state.nextCursor/loading/loadingMore` for guard reads inside
   * callbacks, without putting side effects into state updaters. */
  const cursorRef = useRef<string | null>(null)
  const busyRef = useRef(false)

  const load = useCallback(async (options?: { q?: string; cursor?: string }) => {
    if (!scope) return
    const q = options?.q ?? ''
    const generation = ++generationRef.current
    const first = !options?.cursor
    loadedQueryRef.current = q
    busyRef.current = true
    setState(previous => first
      ? { ...emptyColleagues(), loading: true }
      : { ...previous, loadingMore: true, errorKey: null })
    try {
      const response = await window.electronAPI.pmListColleagueOptions({
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
        ...(q ? { q } : {}),
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        limit: COLLEAGUES_PAGE_LIMIT,
      })
      if (generation !== generationRef.current) return
      cursorRef.current = response.nextCursor
      busyRef.current = false
      setState(previous => ({
        members: first ? response.members : [...previous.members, ...response.members],
        nextCursor: response.nextCursor,
        loading: false,
        loadingMore: false,
        errorKey: null,
        sourceState: response.sourceState,
        source: response.source,
        sourceNoticeKey: sourceNoticeKeyOf(response.sourceState),
      }))
    } catch (error) {
      if (generation !== generationRef.current) return
      // E2-5: pm codes ride the context-bridge message marker; a bare
      // `.code` read would classify every failure as generic. A failed
      // CONTINUATION keeps the already-loaded pages (spread `previous`) so
      // loadMore can be retried with the held cursor.
      busyRef.current = false
      const code = readRpcErrorCode(error)
      setState(previous => ({
        ...previous,
        loading: false,
        loadingMore: false,
        errorKey: colleaguesErrorKey(code),
      }))
    }
  }, [scope])

  // Scope change (account / project / asserted source) clears EVERYTHING and
  // rejects the late responses of the previous scope. 失权即清数据.
  useEffect(() => {
    generationRef.current += 1
    loadedQueryRef.current = ''
    cursorRef.current = null
    busyRef.current = false
    setQuery('')
    setState(emptyColleagues())
    if (scope) void load()
  }, [scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps -- `load` follows `scope`, captured by scopeKey

  /** Server-side name search (D3): a new q restarts from the first page and
   * invalidates the previous pages — the old cursor is never reused. */
  const search = useCallback((nextQuery: string) => {
    const q = nextQuery.trim().slice(0, 128)
    setQuery(q)
    if (!scope) return
    void load({ q })
  }, [load, scope])

  const loadMore = useCallback(() => {
    if (!scope || busyRef.current) return
    const cursor = cursorRef.current
    if (!cursor) return
    void load({ q: loadedQueryRef.current, cursor })
  }, [load, scope])

  /** X2-7-style retry: only meaningful while the load failed, so a retry
   * never duplicates a successful load. */
  const retry = useCallback(() => {
    if (!scope || busyRef.current) return
    if (!state.errorKey) return
    void load({ q: loadedQueryRef.current })
  }, [load, scope, state.errorKey])

  return useMemo(() => ({
    scopeKey,
    query,
    ...state,
    search,
    loadMore,
    retry,
  }), [loadMore, query, retry, scopeKey, search, state])
}
