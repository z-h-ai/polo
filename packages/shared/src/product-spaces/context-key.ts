import type {
  AccountId,
  DeviceId,
  ProductSpaceId,
  SessionId,
  WorkspaceId,
} from './ids.ts'
import type { ProductSpaceExecutionScope } from './types.ts'

export const PRODUCT_SPACE_CONTRACT_VERSION = 1 as const

/** All persisted identities are collision-free, versioned JSON tuples. */
export function createProductSpaceContextKey(
  accountId: AccountId,
  productSpaceId: ProductSpaceId,
): string {
  return JSON.stringify(['product-space', PRODUCT_SPACE_CONTRACT_VERSION, accountId, productSpaceId])
}

export function createProductSpaceListKey(accountId: AccountId): string {
  return JSON.stringify(['product-space-list', PRODUCT_SPACE_CONTRACT_VERSION, accountId])
}

export function createProductSpaceCatalogKey(
  accountId: AccountId,
  productSpaceId: ProductSpaceId,
): string {
  return JSON.stringify(['product-space-catalog', PRODUCT_SPACE_CONTRACT_VERSION, accountId, productSpaceId])
}

export function createProductSpaceWorkspaceKey(
  accountId: AccountId,
  productSpaceId: ProductSpaceId,
  workspaceId: WorkspaceId,
): string {
  return JSON.stringify([
    'product-space-workspace', PRODUCT_SPACE_CONTRACT_VERSION,
    accountId, productSpaceId, workspaceId,
  ])
}

export function createProductSpaceRuntimeKey(scope: ProductSpaceExecutionScope): string {
  return JSON.stringify([
    'product-space-runtime', scope.contractVersion, scope.accountId,
    scope.productSpaceId, scope.workspaceId, scope.executionId,
  ])
}

export function createProductSpaceSessionKey(
  scope: ProductSpaceExecutionScope,
  sessionId: SessionId,
): string {
  return JSON.stringify([
    'product-space-session', scope.contractVersion, scope.accountId,
    scope.productSpaceId, scope.workspaceId, scope.executionId, sessionId,
  ])
}

export function createActiveProductSpaceSelectionKey(
  accountId: AccountId,
  deviceId: DeviceId,
): string {
  return JSON.stringify(['active-product-space', PRODUCT_SPACE_CONTRACT_VERSION, accountId, deviceId])
}
