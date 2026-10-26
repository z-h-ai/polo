import { RPC_CHANNELS, type CanvasPaneApp } from '../../shared/types'
import { pushTyped, type RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.canvasPane.DETACH_TO_POPUP,
  RPC_CHANNELS.canvasPane.ATTACH_FROM_POPUP,
  RPC_CHANNELS.canvasPane.FOCUS,
] as const

/**
 * POO-135 验收修复 (SB-CANVAS-OUT): canvas popout control channels.
 *
 * The manager is desktop-only — headless hosts and tests without it degrade
 * to no-ops (the renderer treats an unanswered detach as "stay embedded").
 * State changes broadcast to all renderers with renderer-side session
 * filtering, the same contract as browser pane STATE_CHANGED.
 */
export function registerCanvasPaneHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { canvasPopupManager } = deps
  if (!canvasPopupManager) return

  server.handle(RPC_CHANNELS.canvasPane.DETACH_TO_POPUP, (ctx, sessionId: string, app: CanvasPaneApp) => {
    // The popup inherits the calling (main) window's workspace so the
    // webview attach gate resolves the same trusted scope for the popup
    // renderer.
    canvasPopupManager.detachToPopup(sessionId, app, ctx.workspaceId)
  })

  server.handle(RPC_CHANNELS.canvasPane.ATTACH_FROM_POPUP, (_ctx, sessionId: string) => {
    canvasPopupManager.attachFromPopup(sessionId)
  })

  server.handle(RPC_CHANNELS.canvasPane.FOCUS, (_ctx, sessionId: string) => {
    canvasPopupManager.focus(sessionId)
  })

  canvasPopupManager.onStateChanged((state) => {
    pushTyped(server, RPC_CHANNELS.canvasPane.STATE_CHANGED, { to: 'all' }, state)
  })
}
