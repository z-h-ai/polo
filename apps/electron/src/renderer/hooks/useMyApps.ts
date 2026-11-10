import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MyAppSummary } from '@polo-ai/shared/protocol'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { readRpcErrorCode } from '../../shared/rpc-error-bridge'

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
  // POO-205 A3b: the space write gate (governance suspension, closing,
  // billing overdue) refuses saves AND publishes with this 409 code.
  | 'myapps_space_restricted'
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
  /** AppIds with a delete in flight (per-card busy state). */
  deletingAppIds: ReadonlySet<string>
}

export interface MyAppsApi {
  state: MyAppsState
  /** The committed scope the current state was loaded under; null = idle. */
  scope: MyAppsScope | null
  /** Publish into the CURRENT space is an enterprise-only action. */
  canPublish: boolean
  refresh: () => Promise<void>
  /** Saves a bundle into the list; `savedAsNewVersion` distinguishes the
   * A3b idempotent re-save (same sourceKey → HTTP 200) from a new row (201). */
  create: (input: {
    sourcePath: string
    name: string
    description?: string
    sourceKey?: string
  }) => Promise<{ app: MyAppSummary; savedAsNewVersion: boolean }>
  publish: (appId: string) => Promise<void>
  withdraw: (appId: string) => Promise<void>
  /** Removes the app row entirely; a published app is withdrawn by the same
   * server-side transaction (POO-205 C12). */
  delete: (appId: string) => Promise<void>
}

function errorCodeOf(error: unknown): MyAppsErrorCode {
  // Coded-RPC failures carry the stable myapps_* code as a live `code`
  // property (direct path) or inside the bridge marker of the message (the
  // context bridge preserves only the message — see rpc-error-bridge). A bare
  // message compare would ALWAYS degrade to generic under the bridge, so the
  // structured read comes first; the raw-message fallback keeps the direct
  // (non-bridged) callers working.
  const structured = readRpcErrorCode(error)
  if (structured && isMyAppsErrorCode(structured)) return structured
  const message = error instanceof Error ? error.message : String(error)
  return isMyAppsErrorCode(message) ? message : 'request_failed'
}

function isMyAppsErrorCode(code: string): code is MyAppsErrorCode {
  switch (code) {
    case 'myapps_signin_required':
    case 'myapps_scope_changed':
    case 'myapps_service_unavailable':
    case 'myapps_publish_unavailable_in_personal':
    case 'myapps_space_restricted':
      return true
    default:
      return false
  }
}

function readErrorCode(error: unknown): MyAppsErrorCode {
  return errorCodeOf(error instanceof Error ? error : new Error(String(error)))
}

/**
 * Primitive scope identity for the in-flight guards: the scope literal is
 * rebuilt on EVERY render (and a loading/busy setState re-renders mid-flight),
 * so an object-identity check would drop the hook's own in-flight response and
 * dead the list. The reload effect keys on primitive identity (:178) — the
 * response guards must too.
 */
function scopeKeyOf(scope: MyAppsScope | null): string {
  return scope ? `${scope.accountId}\n${scope.workspaceId}\n${scope.productSpaceId}` : ''
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
    deletingAppIds: new Set(),
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
      if (generation !== generationRef.current || scopeKeyOf(scopeRef.current) !== scopeKeyOf(currentScope)) return
      if (response.productSpaceId !== currentScope.productSpaceId) return
      setState(current => ({
        ...current,
        apps: response.apps,
        loading: false,
        refreshing: false,
        errorCode: null,
      }))
    } catch (error) {
      if (generation !== generationRef.current || scopeKeyOf(scopeRef.current) !== scopeKeyOf(currentScope)) return
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
        deletingAppIds: new Set(),
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
    sourceKey?: string
  }): Promise<{ app: MyAppSummary; savedAsNewVersion: boolean }> => {
    const currentScope = scopeRef.current
    if (!currentScope) {
      throw new Error('myapps_scope_changed')
    }
    const response = await window.electronAPI.myAppsCreate({ ...currentScope, ...input })
    if (scopeKeyOf(scopeRef.current) === scopeKeyOf(currentScope)) void refresh()
    // A3b idempotent save: the trusted side flattens the raw HTTP status into
    // the answer — 200 = a NEW VERSION of the sourceKey-addressed row, 201 =
    // a brand-new row. A legacy preload without the field simply reports
    // "new app".
    return {
      app: response.app,
      savedAsNewVersion: response.status === 200,
    }
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
    if (scopeKeyOf(scopeRef.current) === scopeKeyOf(currentScope)) void refresh()
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
    if (scopeKeyOf(scopeRef.current) === scopeKeyOf(currentScope)) void refresh()
  }, [refresh])

  const deleteApp = useCallback(async (appId: string): Promise<void> => {
    const currentScope = scopeRef.current
    if (!currentScope) {
      throw new Error('myapps_scope_changed')
    }
    setState(current => ({
      ...current,
      deletingAppIds: new Set([...current.deletingAppIds, appId]),
    }))
    try {
      await window.electronAPI.myAppsDelete({ ...currentScope, appId })
    } finally {
      setState(current => {
        const next = new Set(current.deletingAppIds)
        next.delete(appId)
        return { ...current, deletingAppIds: next }
      })
    }
    if (scopeKeyOf(scopeRef.current) === scopeKeyOf(currentScope)) void refresh()
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
    delete: deleteApp,
  }), [canPublish, create, deleteApp, publish, refresh, scope, state, withdraw])
}
