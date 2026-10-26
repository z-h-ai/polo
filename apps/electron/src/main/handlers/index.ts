import type { HandlerDeps } from './handler-deps'
import type { RpcServer } from '@polo-ai/server-core/transport'
import { registerCoreRpcHandlers, type ServerHandlerContext } from '@polo-ai/server-core/handlers/rpc'
export { registerCoreRpcHandlers }

// GUI-only handlers remain local (Electron-specific imports)
import { registerSystemGuiHandlers } from './system'
import { registerWorkspaceGuiHandlers } from './workspace'
import { registerBrowserHandlers } from './browser'
import { registerCanvasPaneHandlers } from './canvas'
import { registerSettingsGuiHandlers } from './settings'
import { registerTabBrowserHandlers } from './tab-browser'
import { registerGenUiHandlers } from './genui'
import { registerLocalAppHandlers } from './local-apps'

export function registerGuiRpcHandlers(server: RpcServer, deps: HandlerDeps): void {
  registerSystemGuiHandlers(server, deps)
  registerWorkspaceGuiHandlers(server, deps)
  registerBrowserHandlers(server, deps)
  registerCanvasPaneHandlers(server, deps)
  registerSettingsGuiHandlers(server, deps)
  registerTabBrowserHandlers(server, deps)
  registerGenUiHandlers(server, deps)
  registerLocalAppHandlers(server, deps)
}

export function registerAllRpcHandlers(server: RpcServer, deps: HandlerDeps, serverCtx?: ServerHandlerContext): void {
  registerCoreRpcHandlers(server, deps, serverCtx)
  registerGuiRpcHandlers(server, deps)
}
