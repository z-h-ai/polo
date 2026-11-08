import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MyAppSummary } from '@polo-ai/shared/protocol'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

/**
 * POO-205 (Q7/Q11) — the "我的应用" surface of the ACTIVE ProductSpace.
 *
 * Every space owns ONE my-apps list: the member's own canvas apps (saved from
 * the generate-app card through `myapps:create`), each optionally published
 * into the CURRENT space's shared directory (`myapps:publish`, enterprise
 * spaces only — the renderer hides the entry in personal spaces and the admin
 * wire refuses it anyway) and revertible (`myapps:withdraw`).
 *
 * Scope discipline (same trust posture as the pc_/pm_ families): the renderer
 * supplies the committed scope triple — accountId/workspaceId/active
 * productSpaceId — and the trusted side re-proves the runtime fence on every
 * entry; a scope change mid-flight supersedes the result. A missing context,
 * a missing transport member (isolated mounts, tests) or a failed read deades
 * the surface to an explicit error state, never to fabricated rows.
 */

/** The scope triple every myapps_* RPC carries. */
export interface MyAppsScope {
  accountId: string
  workspaceId: string
  productSpaceId: string
}

export type MyAppsErrorCode =
  | 'myapps_signin_required'
  | 'myapps_scope_changed'
  | 'myapps_service_unavailable'
  | 'myapps_publish_unavailable_in_personal'
  | 'request_failed'

export interface MyAppsState {
  apps: MyAppSummary[]
  loading: boolean
  refreshing: boolean
  errorCode: MyAppsErrorCode | null
  /** AppIds with a publish in flight (per-card busy state). */
  publishingAppIds: ReadonlySet<string>
  /** AppIds with a withdraw in flight (per-card busy state). */
  withdrawingAppIds: ReadonlySet<string>
}

export interface MyAppsApi {
  state: MyAppsState
  /** The committed scope the current state was loaded under; null = idle. */
  scope: MyAppsScope | null
  /** Publish into the CURRENT space is an enterprise-only action. */
  canPublish: boolean
  refresh: () => Promise<void>
  create: (input: { sourcePath: string; name: string; description?: string }) => Promise<MyAppSummary>
  publish: (appId: string) => Promise<void>
  withdraw: (appId: string) => Promise<void>
}

function errorCodeOf(error: unknown): MyAppsErrorCode {
  const code = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'myapps_signin_required':
    case 'myapps_scope_changed':
    case 'myapps_service_unavailable':
    case 'myapps_publish_unavailable_in_personal':
      return code
    default:
      return 'request_failed'
  }
}

function readErrorCode(error: unknown): MyAppsErrorCode {
  // Coded-RPC failures carry the stable myapps_* code in the message (the
  // context bridge preserves only the message — see rpc-error-bridge).
  return errorCodeOf(error instanceof Error ? error : new Error(String(error)))
}

export function useMyApps(): MyAppsApi {
  const spaceContext = useOptionalProductSpaceContext()
  const appShell = useOptionalAppShellContext()
  const accountId = spaceContext?.accountId ?? null
  const productSpaceId = spaceContext?.activeProductSpaceId ?? null
  const workspaceId = appShell?.activeWorkspaceId ?? null
  const spaceKind = spaceContext?.activeProductSpace?.kind ?? null
  const scope: MyAppsScope | null = accountId && workspaceId && productSpaceId
    ? { accountId, workspaceId, productSpaceId }
    : null

  const [state, setState] = useState<MyAppsState>({
    apps: [],
    loading: false,
    refreshing: false,
    errorCode: null,
    publishingAppIds: new Set(),
    withdrawingAppIds: new Set(),
  })
  // Single-flight per context: the latest scope's read wins, an in-flight
  // mutation re-reads afterwards, and a superseded response never commits.
  const scopeRef = useRef<MyAppsScope | null>(scope)
  scopeRef.current = scope
  const generationRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const currentScope = scopeRef.current
    const generation = ++generationRef.current
    // The transport member lookup stays INSIDE the guard: a strict fixture
    // proxy (or a legacy preload) may throw on the property access itself,
    // and a missing myapps surface must dead the hook, never break the page.
    try {
      const api = window.electronAPI?.myAppsList
      if (!currentScope || typeof api !== 'function') {
        setState(current => ({
          ...current,
          apps: [],
          loading: false,
          refreshing: false,
          errorCode: null,
        }))
        return
      }
      setState(current => ({
        ...current,
        loading: current.apps.length === 0,
        refreshing: current.apps.length > 0,
        errorCode: null,
      }))
      const response = await api(currentScope)
      if (generation !== generationRef.current || scopeRef.current !== currentScope) return
      if (response.productSpaceId !== currentScope.productSpaceId) return
      setState(current => ({
        ...current,
        apps: response.apps,
        loading: false,
        refreshing: false,
        errorCode: null,
      }))
    } catch (error) {
      if (generation !== generationRef.current || scopeRef.current !== currentScope) return
      setState(current => ({
        ...current,
        apps: [],
        loading: false,
        refreshing: false,
        errorCode: readErrorCode(error),
      }))
    }
  }, [])

  // Reload on every scope change (primitive identity — never the per-render
  // scope object); a scope gap empties the surface.
  useEffect(() => {
    generationRef.current += 1
    if (!scopeRef.current) {
      setState(current => ({
        ...current,
        apps: [],
        loading: false,
        refreshing: false,
        errorCode: null,
        publishingAppIds: new Set(),
        withdrawingAppIds: new Set(),
      }))
      return
    }
    void refresh()
    return () => {
      generationRef.current += 1
    }
  }, [accountId, productSpaceId, workspaceId, refresh])

  const create = useCallback(async (input: {
    sourcePath: string
    name: string
    description?: string
  }): Promise<MyAppSummary> => {
    const currentScope = scopeRef.current
    if (!currentScope) {
      throw new Error('myapps_scope_changed')
    }
    const response = await window.electronAPI.myAppsCreate({ ...currentScope, ...input })
    if (scopeRef.current === currentScope) void refresh()
    return response.app
  }, [refresh])

  const publish = useCallback(async (appId: string): Promise<void> => {
    const currentScope = scopeRef.current
    if (!currentScope) {
      throw new Error('myapps_scope_changed')
    }
    setState(current => ({
      ...current,
      publishingAppIds: new Set([...current.publishingAppIds, appId]),
    }))
    try {
      await window.electronAPI.myAppsPublish({ ...currentScope, appId })
    } finally {
      setState(current => {
        const next = new Set(current.publishingAppIds)
        next.delete(appId)
        return { ...current, publishingAppIds: next }
      })
    }
    if (scopeRef.current === currentScope) void refresh()
  }, [refresh])

  const withdraw = useCallback(async (appId: string): Promise<void> => {
    const currentScope = scopeRef.current
    if (!currentScope) {
      throw new Error('myapps_scope_changed')
    }
    setState(current => ({
      ...current,
      withdrawingAppIds: new Set([...current.withdrawingAppIds, appId]),
    }))
    try {
      await window.electronAPI.myAppsWithdraw({ ...currentScope, appId })
    } finally {
      setState(current => {
        const next = new Set(current.withdrawingAppIds)
        next.delete(appId)
        return { ...current, withdrawingAppIds: next }
      })
    }
    if (scopeRef.current === currentScope) void refresh()
  }, [refresh])

  // A scope change during any in-flight command re-proves the fence server-
  // side (myapps_scope_changed); the caller surfaces it like any failure.
  const canPublish = spaceKind === 'enterprise'
  return useMemo(() => ({
    state,
    scope,
    canPublish,
    refresh,
    create,
    publish,
    withdraw,
  }), [canPublish, create, publish, refresh, scope, state, withdraw])
}

/* ------------------------------------------------------------------ */
/* Correlation: my-apps rows ↔ catalog member entries                   */
/* ------------------------------------------------------------------ */

export interface MyAppsCorrelation {
  /** catalogEntryId → the app powering it (published pairing, exact id). */
  byPublishedEntryId: ReadonlyMap<string, MyAppSummary>
  /** Unpublished apps paired to member entries by unique display name. */
  unpublishedByName: ReadonlyMap<string, MyAppSummary>
}

/**
 * Pairs the my-apps list with the space catalog's member entries WITHOUT
 * treating a display name as an identity where an id exists:
 *
 * - A published app names its catalog entry explicitly (`publishedEntryId`) —
 *   the only authoritative pairing.
 * - An unpublished app has no entry id on either side, so the fallback keys on
 *   the display name and only commits UNIQUE matches; an ambiguous name wires
 *   no mutation buttons rather than risking the wrong app.
 */
export function correlateMyAppsWithCatalogEntries(
  apps: ReadonlyArray<MyAppSummary>,
): MyAppsCorrelation {
  const byPublishedEntryId = new Map<string, MyAppSummary>()
  const unpublishedByName = new Map<string, MyAppSummary>()
  const ambiguousNames = new Set<string>()
  for (const app of apps) {
    if (app.publishedEntryId) {
      byPublishedEntryId.set(app.publishedEntryId, app)
      continue
    }
    const name = app.name.trim()
    if (!name) continue
    if (unpublishedByName.has(name)) ambiguousNames.add(name)
    else unpublishedByName.set(name, app)
  }
  for (const name of ambiguousNames) unpublishedByName.delete(name)
  return { byPublishedEntryId, unpublishedByName }
}
