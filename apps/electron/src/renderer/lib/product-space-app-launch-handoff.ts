import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { ProductSpaceAppLaunchContext } from '../../shared/tab-browser-types'

export interface PendingProductSpaceAppLaunch {
  accountId: string
  launch: ResolveLaunchResponse
}

/** Non-secret message published to the POO-47 Runtime boundary. */
export interface ProductSpaceAppLaunchRequest {
  handoffId: string
  context: ProductSpaceAppLaunchContext
}

type ProductSpaceAppLaunchListener = (request: ProductSpaceAppLaunchRequest) => void

const pendingLaunches = new Map<string, PendingProductSpaceAppLaunch>()
const listeners = new Set<ProductSpaceAppLaunchListener>()
const MAX_PENDING_LAUNCHES = 64

function isAppLaunch(launch: ResolveLaunchResponse) {
  return launch.subject.kind === 'artifact_instance'
    && launch.subject.artifactType === 'app'
    && launch.delivery.kind !== 'built_in'
    && Date.parse(launch.expiresAt) > Date.now()
}

function createHandoffId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `product-space-launch:${crypto.randomUUID()}`
  }
  return `product-space-launch:${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createLaunchContext(
  accountId: string,
  launch: ResolveLaunchResponse,
): ProductSpaceAppLaunchContext {
  if (launch.subject.kind !== 'artifact_instance' || launch.delivery.kind === 'built_in') {
    throw new Error('Invalid ProductSpace App launch handoff')
  }
  return {
    accountId,
    productSpaceId: launch.productSpaceId,
    catalogEntryId: launch.catalogEntryId,
    artifactInstanceId: launch.subject.artifactInstanceId,
    versionId: launch.subject.versionId,
    version: launch.subject.version,
    deliveryKind: launch.delivery.kind,
    resolvedAt: launch.resolvedAt,
    expiresAt: launch.expiresAt,
  }
}

/**
 * Seals credentials in memory and publishes only an opaque handle plus the
 * immutable identity to POO-47. POO-43 deliberately does not create a Tab or
 * consume runtime state.
 */
export function publishProductSpaceAppLaunch(
  accountId: string,
  launch: ResolveLaunchResponse,
): ProductSpaceAppLaunchRequest {
  if (!accountId || !isAppLaunch(launch)) {
    throw new Error('Invalid ProductSpace App launch handoff')
  }
  for (const [key, pending] of pendingLaunches) {
    if (Date.parse(pending.launch.expiresAt) <= Date.now()) pendingLaunches.delete(key)
  }
  const request = {
    handoffId: createHandoffId(),
    context: createLaunchContext(accountId, launch),
  }
  pendingLaunches.set(request.handoffId, { accountId, launch })
  while (pendingLaunches.size > MAX_PENDING_LAUNCHES) {
    const oldestKey = pendingLaunches.keys().next().value as string | undefined
    if (!oldestKey) break
    pendingLaunches.delete(oldestKey)
  }
  for (const listener of listeners) listener(request)
  return request
}

/** POO-47 subscribes here and consumes the sealed launch by opaque handle. */
export function onProductSpaceAppLaunch(
  listener: ProductSpaceAppLaunchListener,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function takeProductSpaceAppLaunch(
  handoffId: string,
  expected: ProductSpaceAppLaunchContext,
): PendingProductSpaceAppLaunch | null {
  const pending = pendingLaunches.get(handoffId)
  if (!pending) return null
  // A handle is single-attempt as well as single-use. A stale or forged
  // consumer must not be able to probe the tuple and retry later.
  pendingLaunches.delete(handoffId)
  const { launch } = pending
  if (
    !isAppLaunch(launch)
    || pending.accountId !== expected.accountId
    || launch.productSpaceId !== expected.productSpaceId
    || launch.catalogEntryId !== expected.catalogEntryId
    || launch.subject.kind !== 'artifact_instance'
    || launch.subject.artifactInstanceId !== expected.artifactInstanceId
    || launch.subject.versionId !== expected.versionId
    || launch.subject.version !== expected.version
    || launch.delivery.kind !== expected.deliveryKind
    || launch.resolvedAt !== expected.resolvedAt
    || launch.expiresAt !== expected.expiresAt
  ) return null
  return pending
}

export function resetProductSpaceAppLaunchHandoffsForTests(): void {
  pendingLaunches.clear()
  listeners.clear()
}
