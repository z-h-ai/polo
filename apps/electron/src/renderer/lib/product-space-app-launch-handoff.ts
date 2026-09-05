import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { ProductSpaceAppLaunchContext } from '../../shared/tab-browser-types'

export type { ProductSpaceAppLaunchContext }

export interface PendingProductSpaceAppLaunch {
  accountId: string
  launch: ResolveLaunchResponse
}

/** Non-secret message published to the POO-47 Runtime boundary. */
export interface ProductSpaceAppLaunchRequest {
  handoffId: string
  context: ProductSpaceAppLaunchContext
}

export type ProductSpaceAppLaunchListener = (request: ProductSpaceAppLaunchRequest) => void

/**
 * The committed ProductSpace identity a publish/take is validated against.
 * It is ALWAYS supplied per call from the committed ProductSpace React
 * context — never from module state — so speculative renders cannot mutate
 * anything and a consumer mounted under another context can never take.
 */
export interface ProductSpaceLaunchHandoffLiveContext {
  accountId: string
  productSpaceId: string
}

/**
 * Provider-owned launch handoff store. A fresh instance is created per
 * mounted ProductSpaceProvider; it holds no static state, dies with the
 * provider, and enforces liveness against the per-call committed context.
 */
export interface ProductSpaceLaunchHandoffStore {
  publish(
    live: ProductSpaceLaunchHandoffLiveContext,
    accountId: string,
    launch: ResolveLaunchResponse,
  ): ProductSpaceAppLaunchRequest
  take(
    live: ProductSpaceLaunchHandoffLiveContext,
    handoffId: string,
    expected: ProductSpaceAppLaunchContext,
  ): PendingProductSpaceAppLaunch | null
  onLaunch(listener: ProductSpaceAppLaunchListener): () => void
}

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

export function createProductSpaceLaunchHandoffStore(): ProductSpaceLaunchHandoffStore {
  const pendingLaunches = new Map<string, { accountId: string; launch: ResolveLaunchResponse }>()
  const listeners = new Set<ProductSpaceAppLaunchListener>()

  function pruneExpired(): void {
    for (const [key, pending] of pendingLaunches) {
      if (Date.parse(pending.launch.expiresAt) <= Date.now()) pendingLaunches.delete(key)
    }
  }

  return {
    publish(live, accountId, launch): ProductSpaceAppLaunchRequest {
      if (!live.accountId || !live.productSpaceId) {
        throw new Error('ProductSpace App launch handoff requires an active ProductSpace')
      }
      if (!accountId || !isAppLaunch(launch)) {
        throw new Error('Invalid ProductSpace App launch handoff')
      }
      // Fail closed: a caller may only seal inside the committed context it
      // reached us through — never for another account or space.
      if (live.accountId !== accountId || live.productSpaceId !== launch.productSpaceId) {
        throw new Error('ProductSpace App launch handoff belongs to another ProductSpace context')
      }
      pruneExpired()
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
    },

    take(live, handoffId, expected): PendingProductSpaceAppLaunch | null {
      const pending = pendingLaunches.get(handoffId)
      if (!pending) return null
      // A handle is single-attempt as well as single-use. A stale or forged
      // consumer must not be able to probe the tuple and retry later.
      pendingLaunches.delete(handoffId)
      const { launch } = pending
      // Liveness is the COMMITTED context supplied by the consumer's React
      // context read — a handle sealed under another account or space can
      // never be taken, and no module state had to be mutated for it.
      if (
        !live.accountId
        || !live.productSpaceId
        || pending.accountId !== live.accountId
        || launch.productSpaceId !== live.productSpaceId
      ) return null
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
      return { accountId: pending.accountId, launch }
    },

    onLaunch(listener: ProductSpaceAppLaunchListener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
