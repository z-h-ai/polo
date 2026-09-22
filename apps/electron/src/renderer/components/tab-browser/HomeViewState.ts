import { useCallback, useReducer, useMemo } from 'react'

/** Where a directory entry came from (drives inspector data resolution). */
export type HomeInspectorSource = 'organization' | 'circle'

/**
 * Local view state of the home tab surface (POO-70 WS-HOME-APPS):
 * the tab itself stays put while the content switches between the home
 * hub, the full app directory, the app inspector, and the frequent/hidden
 * management pages.
 */
export type HomeSurfaceView =
  | { kind: 'home' }
  | { kind: 'all-apps' }
  | { kind: 'inspector'; id: string; source: HomeInspectorSource }
  | { kind: 'manage' }
  | { kind: 'hidden' }

export type HomeSurfaceViewAction =
  | { type: 'go-home' }
  | { type: 'open-all-apps' }
  | { type: 'inspect'; id: string; source: HomeInspectorSource }
  | { type: 'open-manage' }
  | { type: 'open-hidden' }
  | { type: 'reset' }

export function homeSurfaceViewReducer(
  view: HomeSurfaceView,
  action: HomeSurfaceViewAction,
): HomeSurfaceView {
  switch (action.type) {
    case 'go-home':
    case 'reset':
      // 返回原引用：no-op 重置不得改变状态身份（effect 依赖会无限循环）。
      return view.kind === 'home' ? view : { kind: 'home' }
    case 'open-all-apps':
      return view.kind === 'all-apps' ? view : { kind: 'all-apps' }
    case 'inspect':
      return view.kind === 'inspector' && view.id === action.id
        && view.source === action.source
        ? view
        : { kind: 'inspector', id: action.id, source: action.source }
    case 'open-manage':
      return view.kind === 'manage' ? view : { kind: 'manage' }
    case 'open-hidden':
      return view.kind === 'hidden' ? view : { kind: 'hidden' }
  }
}

export interface UseHomeView {
  view: HomeSurfaceView
  goHome: () => void
  openAllApps: () => void
  inspectApp: (id: string, source: HomeInspectorSource) => void
  openManage: () => void
  openHidden: () => void
  reset: () => void
}

/**
 * useHomeView — local home-surface navigation. The account/space context key
 * changes must call `reset()` so a stale inspector/management page never
 * survives a space switch.
 */
export function useHomeView(): UseHomeView {
  const [view, dispatch] = useReducer(homeSurfaceViewReducer, { kind: 'home' })
  const goHome = useCallback(() => dispatch({ type: 'go-home' }), [])
  const openAllApps = useCallback(
    () => dispatch({ type: 'open-all-apps' }),
    [],
  )
  const inspectApp = useCallback(
    (id: string, source: HomeInspectorSource) => dispatch({
      type: 'inspect',
      id,
      source,
    }),
    [],
  )
  const openManage = useCallback(() => dispatch({ type: 'open-manage' }), [])
  const openHidden = useCallback(() => dispatch({ type: 'open-hidden' }), [])
  const reset = useCallback(() => dispatch({ type: 'reset' }), [])
  // Stable identity: consumers legitimately list this object in effect deps.
  return useMemo(() => ({
    view,
    goHome,
    openAllApps,
    inspectApp,
    openManage,
    openHidden,
    reset,
  }), [goHome, inspectApp, openAllApps, openHidden, openManage, reset, view])
}
