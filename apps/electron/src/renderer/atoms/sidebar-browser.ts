/**
 * POO-135: right-sidebar browser state — which browser occupies the sidebar's
 * browser slot, which of canvas/browser the pane shows when both are open,
 * the armed element picker, and the per-session draft of picked web element
 * references.
 *
 * Process-local by design (same discipline as atoms/canvas-pane.ts): the
 * sidebar is a workspace affordance, browser instance truth lives in Main
 * (mirrored here via browser-pane.ts), and draft references die with the
 * session unless the user sends them.
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { BrowserInstanceInfo, WebElementReference } from '../../shared/types'

/** Which content the unified right pane shows when both types are open. */
export type RightPaneTab = 'canvas' | 'browser'

/**
 * Whether the sidebar's browser slot is open at all. Opening it without any
 * browser shows the empty state (the sidebar's own「新建浏览器」entry — the
 * header never gains a browser entry, per the locked spec).
 */
export const sidebarBrowserOpenAtom = atom(false)

/**
 * Which browser instance the sidebar slot shows. Null = let the UI fall back
 * to the first visible instance (display-only; writing back happens on
 * explicit user selection).
 */
export const sidebarBrowserInstanceIdAtom = atom<string | null>(null)

/** Canvas/browser tab selection for the unified pane header. */
export const rightPaneTabAtom = atom<RightPaneTab>('canvas')

export interface ElementPickingActivity {
  instanceId: string
  /** Chat the picked elements will be added to (fixed at arm time). */
  targetSessionId: string
  /** Session that was selected when picking started (for cancel toasts). */
  originSessionId: string
}

/** The one armed element picker, or null. Arming a second picker cancels none implicitly — Main owns per-instance state. */
export const activeElementPickingAtom = atom<ElementPickingActivity | null>(null)

/** Per-session draft of picked web element references (point-in-time snapshots). */
export const elementDraftRefsAtomFamily = atomFamily((_sessionId: string) =>
  atom<WebElementReference[]>([]),
)

/**
 * Browser instances visible in the sidebar for a session: workspace-scoped
 * (same filter as the tab strip) plus ownership — a session-owned browser is
 * only visible in its own session; workspace (manual) browsers are visible
 * everywhere in their workspace.
 *
 * product-closure U12: an instance WITHOUT a workspaceId no longer leaks
 * across workspaces. It previously passed every workspace's filter (legacy
 * compatibility); now a workspace-scoped viewer only sees instances stamped
 * with one of ITS workspace ids. When no workspace context is resolved at
 * all (both ids null) the list stays unfiltered — there is nothing to scope
 * against.
 */
export function filterSidebarBrowserInstances(
  all: BrowserInstanceInfo[],
  sessionId: string | null,
  activeWorkspaceId: string | null,
  remoteWorkspaceId: string | null,
): BrowserInstanceInfo[] {
  let visible = all
  if (activeWorkspaceId || remoteWorkspaceId) {
    visible = visible.filter(
      (i) =>
        // An unbound instance must not slip through via `null === null` when
        // one of the context ids is also null — only real ids match.
        !!i.workspaceId &&
        (i.workspaceId === activeWorkspaceId ||
          i.workspaceId === remoteWorkspaceId),
    )
  }
  if (sessionId) {
    visible = visible.filter((i) => !i.ownerSessionId || i.ownerSessionId === sessionId)
  }
  return visible
}

/**
 * Resolve the sidebar's selected instance for display: the explicit pick when
 * it is still visible, otherwise the first visible instance, else null.
 */
export function resolveSidebarBrowserInstance(
  visible: BrowserInstanceInfo[],
  selectedId: string | null,
): BrowserInstanceInfo | null {
  if (selectedId) {
    const selected = visible.find((i) => i.id === selectedId)
    if (selected) return selected
  }
  return visible[0] ?? null
}

/**
 * The chat a picker run targets, fixed at arm time: a session-owned browser
 * always targets its owning session; a workspace browser targets the session
 * selected when picking started. Null when there is no usable target (the
 * picker entry must be disabled with「请先选择目标会话」).
 */
export function resolvePickTargetSessionId(
  instance: BrowserInstanceInfo | null,
  currentSessionId: string | null,
): string | null {
  if (!instance) return null
  return instance.ownerSessionId ?? currentSessionId
}
