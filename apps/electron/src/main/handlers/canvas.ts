import { BrowserWindow } from 'electron'
import { RPC_CHANNELS, type BrowserEmbedBounds, type CanvasPaneApp } from '../../shared/types'
import { pushTyped, type RpcServer } from '@polo-ai/server-core/transport'
import { resolve } from 'path'
import { resolveTrustedSessionContext } from './genui'
import type { HandlerDeps } from './handler-deps'

export const HANDLED_CHANNELS = [RPC_CHANNELS.canvasPane.EMBED, RPC_CHANNELS.canvasPane.UNEMBED, RPC_CHANNELS.canvasPane.HIDE, RPC_CHANNELS.canvasPane.DESTROY, RPC_CHANNELS.canvasPane.RELEASE, RPC_CHANNELS.canvasPane.DETACH_TO_POPUP, RPC_CHANNELS.canvasPane.ATTACH_FROM_POPUP, RPC_CHANNELS.canvasPane.FOCUS] as const

export function registerCanvasPaneHandlers(server: RpcServer, deps: HandlerDeps): void {
  const manager = deps.canvasPopupManager
  if (!manager) return
  server.handle(RPC_CHANNELS.canvasPane.EMBED, (ctx, sessionId: string, app: CanvasPaneApp, bounds: BrowserEmbedBounds) => {
    const host = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.id === ctx.webContentsId)
    if (!host || deps.windowManager?.getWorkspaceForWindow(host.webContents.id) !== ctx.workspaceId) throw new Error('Canvas owner window is unavailable')
    if (!sessionId || !app?.appId || !app.indexPath || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error('Invalid canvas embed request')
    const { dataPath } = resolveTrustedSessionContext(ctx, deps, sessionId)
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(app.appId) || resolve(app.indexPath) !== resolve(dataPath, 'genui-apps', app.appId, 'index.html')) throw new Error('Canvas bundle identity mismatch')
    return manager.embed(sessionId, app, host, ctx.workspaceId, bounds)
  })
  server.handle(RPC_CHANNELS.canvasPane.RELEASE, ctx => { if (ctx.webContentsId) manager.releaseForHost(ctx.webContentsId) })
  const guard = (ctx: { webContentsId?: number | null; workspaceId?: string | null }, id: string) => manager.assertOwner(id, ctx.webContentsId, ctx.workspaceId)
  server.handle(RPC_CHANNELS.canvasPane.UNEMBED, (ctx, id: string) => { guard(ctx, id); manager.unembed(id) })
  server.handle(RPC_CHANNELS.canvasPane.HIDE, (ctx, id: string) => { guard(ctx, id); manager.hide(id) })
  server.handle(RPC_CHANNELS.canvasPane.DESTROY, async (ctx, id: string) => { const original = guard(ctx, id); const session = await deps.sessionManager?.getSession(id); if (guard(ctx, id) !== original) return false; return manager.requestDestroy(id, Boolean(session?.isProcessing)) })
  server.handle(RPC_CHANNELS.canvasPane.DETACH_TO_POPUP, (ctx, id: string, app: CanvasPaneApp) => { guard(ctx, id); manager.detachToPopup(id, app, ctx.workspaceId) })
  server.handle(RPC_CHANNELS.canvasPane.ATTACH_FROM_POPUP, (ctx, id: string) => { guard(ctx, id); manager.attachFromPopup(id) })
  server.handle(RPC_CHANNELS.canvasPane.FOCUS, (ctx, id: string) => { guard(ctx, id); manager.focus(id) })
  manager.onStateChanged(state => pushTyped(server, RPC_CHANNELS.canvasPane.STATE_CHANGED, { to: 'all' }, state))
}
