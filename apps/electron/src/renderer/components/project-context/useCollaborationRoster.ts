import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClientCollaborationRosterMember,
  ClientMemberRole,
} from '@polo-ai/shared/admin/client-enterprise-contract'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'
import { membersErrorKey } from './useProjectMembers'

/**
 * POO-196 R3 collaboration-roster state hook (adjudication D4).
 *
 * The single SAFE roster surface every active role reads (owner/manager/
 * member alike — a member 403 is a real authority change, not a success
 * path). The projection carries NO contact and NO governance fields, and
 * `totalActiveMembers` is the server's unfiltered count from the same
 * snapshot as the page: the client never derives a count from the loaded
 * rows and never reports 0 for an empty search match.
 *
 * Name search passes `q` straight through (server-side filter over the full
 * roster); the loaded pages, the viewer role and the total are reset on a
 * query change exactly like on a scope change. Every scope change (account /
 * project) clears everything and bumps the generation, so a roster response
 * from a previous account or project is discarded, never published — 失权即
 * 清数据. Nothing here is persisted; the count a header shows dies with the
 * scope.
 */

export type CollaborationRosterScope = {
  accountId: string
  productSpaceId: string
}

export type CollaborationRosterState = {
  members: ClientCollaborationRosterMember[]
  /** The server's unfiltered active-member count; `null` means unknown —
   * the UI keeps a "members" affordance instead of showing a fabricated 0. */
  totalActiveMembers: number | null
  viewerRole: ClientMemberRole | null
  enterpriseName: string | null
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  /** i18n key of the load failure, when the FIRST page failed. */
  errorKey: string | null
}

export const ROSTER_PAGE_LIMIT = 20

function emptyRoster(): CollaborationRosterState {
  return {
    members: [],
    totalActiveMembers: null,
    viewerRole: null,
    enterpriseName: null,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    errorKey: null,
  }
}

export function useCollaborationRoster(scope: CollaborationRosterScope | null) {
  const scopeKey = scope ? `${scope.accountId}:${scope.productSpaceId}` : null

  const [state, setState] = useState<CollaborationRosterState>(emptyRoster)
  const [query, setQuery] = useState('')
  const generationRef = useRef(0)
  /** The query the CURRENT pages were loaded with (roster cursors are
   * (normalizedDisplayName,userId) pages of the q-filtered list). */
  const loadedQueryRef = useRef('')
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
      ? { ...emptyRoster(), loading: true }
      : { ...previous, loadingMore: true, errorKey: null })
    try {
      const response = await window.electronAPI.pmListCollaborationRoster({
        accountId: scope.accountId,
        productSpaceId: scope.productSpaceId,
        ...(q ? { q } : {}),
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        limit: ROSTER_PAGE_LIMIT,
      })
      if (generation !== generationRef.current) return
      cursorRef.current = response.nextCursor
      busyRef.current = false
      setState(previous => ({
        members: first ? response.members : [...previous.members, ...response.members],
        // The count is the server's UNFILTERED total from the same snapshot —
        // a q-filtered page still reports it; the client never counts rows.
        totalActiveMembers: response.totalActiveMembers,
        viewerRole: response.viewerRole,
        enterpriseName: response.enterpriseName,
        nextCursor: response.nextCursor,
        loading: false,
        loadingMore: false,
        errorKey: null,
      }))
    } catch (error) {
      if (generation !== generationRef.current) return
      // E2-5: pm codes ride the context-bridge message marker; a bare
      // `.code` read would classify every failure as generic. A failed
      // CONTINUATION keeps the already-loaded pages. A 403 is a real
      // authority loss: the pages stay cleared (a failed first page has
      // none), and the header count falls back to unknown — never a stale
      // roster behind the error.
      busyRef.current = false
      const code = readRpcErrorCode(error)
      setState(previous => ({
        ...previous,
        loading: false,
        loadingMore: false,
        errorKey: membersErrorKey(code),
        ...(code === 'forbidden' ? { totalActiveMembers: null, viewerRole: null } : {}),
      }))
    }
  }, [scope])

  // Scope change (account or project) clears EVERYTHING and rejects the late
  // responses of the previous scope.
  useEffect(() => {
    generationRef.current += 1
    loadedQueryRef.current = ''
    cursorRef.current = null
    busyRef.current = false
    setQuery('')
    setState(emptyRoster())
    if (scope) void load()
  }, [scopeKey]) // eslint-disable-line react-hooks/exhaustive-deps -- `load` follows `scope`, captured by scopeKey

  /** Server-side search (D4): a new q restarts from the first page; the
   * previous pages are invalidated with it. */
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

  /** X2-7-style retry: only meaningful while the FIRST page failed. */
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
