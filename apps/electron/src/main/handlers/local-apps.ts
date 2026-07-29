import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type {
  LocalAppInstallRequest,
  LocalAppLogsOptions,
  LocalAppUninstallOptions,
} from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import { getLocalAppRuntimeManager } from '../local-app-runtime'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.localApps.INSTALL,
  RPC_CHANNELS.localApps.CANCEL_INSTALL,
  RPC_CHANNELS.localApps.START,
  RPC_CHANNELS.localApps.STOP,
  RPC_CHANNELS.localApps.RESTART,
  RPC_CHANNELS.localApps.UNINSTALL,
  RPC_CHANNELS.localApps.GET_INSTALLED_APPS,
  RPC_CHANNELS.localApps.GET_RUNTIME_STATUS,
  RPC_CHANNELS.localApps.GET_LOGS,
] as const

export function registerLocalAppHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.localApps.INSTALL, (_ctx, request: LocalAppInstallRequest) =>
    getLocalAppRuntimeManager().install(request))
  server.handle(RPC_CHANNELS.localApps.CANCEL_INSTALL, (_ctx, appId: string) =>
    getLocalAppRuntimeManager().cancelInstall(appId))
  server.handle(RPC_CHANNELS.localApps.START, (_ctx, appId: string) =>
    getLocalAppRuntimeManager().start(appId))
  server.handle(RPC_CHANNELS.localApps.STOP, (_ctx, appId: string) =>
    getLocalAppRuntimeManager().stop(appId))
  server.handle(RPC_CHANNELS.localApps.RESTART, (_ctx, appId: string) =>
    getLocalAppRuntimeManager().restart(appId))
  server.handle(
    RPC_CHANNELS.localApps.UNINSTALL,
    (_ctx, appId: string, options?: LocalAppUninstallOptions) =>
      getLocalAppRuntimeManager().uninstall(appId, options),
  )
  server.handle(RPC_CHANNELS.localApps.GET_INSTALLED_APPS, () =>
    getLocalAppRuntimeManager().getInstalledApps())
  server.handle(RPC_CHANNELS.localApps.GET_RUNTIME_STATUS, (_ctx, appId: string) =>
    getLocalAppRuntimeManager().getRuntimeStatus(appId))
  server.handle(
    RPC_CHANNELS.localApps.GET_LOGS,
    (_ctx, appId: string, options?: LocalAppLogsOptions) =>
      getLocalAppRuntimeManager().getLogs(appId, options),
  )
}
