/**
 * Main-process canvas popup host, consumed by the Electron GUI handlers the
 * same way `IBrowserPaneManager` is (POO-135 验收修复 SB-CANVAS-OUT). Headless
 * hosts and tests may omit the dependency — the handlers degrade to no-ops.
 */

import type { CanvasPaneApp } from '@polo-ai/shared/protocol'

export interface ICanvasPopupManager {
  /**
   * Move the session's canvas out of the right sidebar into a dedicated
   * BrowserWindow. `workspaceId` is the calling (main) window's workspace —
   * the popup inherits it so the webview scope resolution treats the popup
   * renderer as a member of the same fence.
   */
  detachToPopup(sessionId: string, app: CanvasPaneApp, workspaceId: string | null | undefined): void
  /** Return the canvas to the sidebar: close the popup window. */
  attachFromPopup(sessionId: string): void
  /** Show + focus the popup window (sidebar「显示窗口」affordance). */
  focus(sessionId: string): void
  /** Whether a live popup window currently hosts this session's canvas. */
  isPoppedOut(sessionId: string): boolean
}
