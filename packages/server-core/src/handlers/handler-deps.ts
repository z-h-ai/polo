import type { PlatformServices } from '../runtime/platform'
import type { ISessionManager } from './session-manager-interface'
import type { IOAuthFlowStore } from './oauth-flow-store-interface'
import type { IBrowserPaneManager } from './browser-pane-manager-interface'
import type { IWindowManager } from './window-manager-interface'
import type { IMessagingGatewayRegistry } from './messaging-registry-interface'

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
   * Host-owned session-ending hook invoked inside the trusted transition lock.
   * It must synchronously fence new and in-flight lifecycle result commits,
   * then return the promise for slow stop/cancel cleanup. The promise is awaited
   * outside the lock and before credentials are deleted.
   */
  onAdminSessionEnding?: (accountId: string) => Promise<void>
  /**
   * Re-enables host lifecycle operations only after a fresh trusted login has
   * completed any prior account cleanup.
   */
  onAdminSessionStarted?: (accountId: string) => Promise<void> | void
  /**
   * Host-owned organization authorization fence. Invocation must synchronously
   * invalidate in-flight lifecycle commits before returning the slow
   * organization-scoped stop/cancel cleanup promise.
   */
  onAdminCatalogScopeDenied?: (
    accountId: string,
    organizationId: string,
  ) => Promise<void>
  /**
   * Returns Catalog business ids that still have local installation or
   * runtime data and therefore must survive withdrawn tombstone pruning.
   */
  getRetainedCatalogAppIds?: (
    accountId: string,
    organizationId: string,
  ) => Promise<ReadonlySet<string>>
}
