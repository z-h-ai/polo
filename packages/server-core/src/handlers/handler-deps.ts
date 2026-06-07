import type { PlatformServices } from '../runtime/platform'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'
import type { AdminApiClient } from '@polo-ai/shared/admin-api'
import type { PendingUsageStore } from '@polo-ai/shared/admin-api'
import type { getCredentialManager } from '@polo-ai/shared/credentials'

/**
 * Generic handler dependency bag.
 * Concrete hosts specialize these generics to their runtime implementations.
 *
 * TSessionManager defaults to ISessionManager, TOAuthFlowStore
 * defaults to IOAuthFlowStore, TWindowManager defaults to IWindowManager,
 * and TBrowserPaneManager defaults to IBrowserPaneManager so core handlers
 * get typed access without specialization.  Electron narrows all to their
 * concrete implementations.
 */
export interface HandlerDeps<
  TSessionManager extends ISessionManager = ISessionManager,
  TOAuthFlowStore extends IOAuthFlowStore = IOAuthFlowStore,
  TWindowManager extends IWindowManager = IWindowManager,
  TBrowserPaneManager extends IBrowserPaneManager = IBrowserPaneManager,
> {
  sessionManager: TSessionManager
  platform: PlatformServices
  windowManager?: TWindowManager
  browserPaneManager?: TBrowserPaneManager
  oauthFlowStore: TOAuthFlowStore
  messagingRegistry?: IMessagingGatewayRegistry
  /**
   * Admin API client for quota enforcement (platform mode only).
   * Optional: only present when PLATFORM_ANTHROPIC_API_KEY is set.
   */
  adminApiClient?: AdminApiClient
  /**
   * Pending usage store for effective remaining calculation (platform mode only).
   * Optional: only present when PLATFORM_ANTHROPIC_API_KEY is set.
   */
  pendingUsageStore?: PendingUsageStore
  /**
   * Admin auth logout client. Hosts can inject one that reads the cached
   * platform JWT without exposing it to the renderer.
   */
  authLogout?: {
    logout(token?: string | null): Promise<void>
  }
  /**
   * Host-specific cached auth cleanup, such as Electron's encrypted
   * admin-session.json file.
   */
  clearCachedAuthData?: () => void | Promise<void>
  /**
   * Injectable credential manager for focused auth tests.
   */
  credentialManager?: Pick<ReturnType<typeof getCredentialManager>, 'list' | 'delete'>
  /**
   * Resolve the ownerUserId for a given workspaceId.
   * Optional injectable for testing; production code uses loadWorkspaceConfig.
   * Returns null if workspace not found or no owner set (legacy workspace).
   */
  resolveWorkspaceOwner?: (workspaceId: string) => string | null | undefined
}
