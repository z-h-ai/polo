import { ipcMain } from 'electron'
import { join } from 'node:path'
import { SDK_CHANNEL } from '../../../../packages/sdk/src/protocol'
import { AppSdkBridge } from './app-sdk-bridge'
import { getLocalAppRuntimeCoordinator, getScopedLocalAppRuntimeRegistry } from './local-app-runtime'
import { getRuntimeActiveProductSpace, isRuntimeFenceBoundToAccount, isRuntimeOfflineReadOnly, isRuntimeProductSpaceRestricted, isSwitchInProgress } from '@polo-ai/server-core/runtime/product-space-executions'
let bridge: AppSdkBridge | undefined
let workspaceForHost: (id: number) => string | null = () => null
export function setAppSdkWorkspaceResolver(resolver: typeof workspaceForHost): void { workspaceForHost = resolver }
export function getAppSdkBridge(): AppSdkBridge {
  if (!bridge) {
    bridge = new AppSdkBridge({
      coordinator: getLocalAppRuntimeCoordinator(),
      preloadPath: join(__dirname, 'app-sdk-preload.cjs'),
      workspaceForHost: id => workspaceForHost(id),
      scopeCurrent: runtime => !isSwitchInProgress() && !isRuntimeOfflineReadOnly() && !isRuntimeProductSpaceRestricted(runtime.identity.productSpaceId)
        && isRuntimeFenceBoundToAccount(runtime.identity.accountId) && getRuntimeActiveProductSpace() === runtime.identity.productSpaceId
        && getScopedLocalAppRuntimeRegistry().getScopeGeneration({ kind: 'catalog', accountId: runtime.identity.accountId, organizationId: runtime.identity.productSpaceId, catalogAppId: runtime.identity.artifactInstanceId }) === runtime.scopeGeneration,
    })
    ipcMain.handle(SDK_CHANNEL, (event, request, attachNonce) => bridge!.invoke(event, request, attachNonce).catch(() => ({ ok: false, error: { code: 'host_failed' } })))
  }
  return bridge
}
