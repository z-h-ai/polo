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
  /**
   * Binds the store to the committed context: advances the non-reusable
   * generation AND records the committed live identity. Every committed
   * account/ProductSpace change permanently invalidates every handle sealed
   * under the previous generation — an A→B→A round-trip can never revive a
   * pre-transition launch — and publish/take callers whose captured live
   * context no longer matches the committed one fail closed immediately
   * (stale closures cannot act inside the commit→passive window because the
   * Provider commits at the insertion boundary, before any descendant layout
   * callback).
   */
  commitContext(
    contextKey: string,
    live: ProductSpaceLaunchHandoffLiveContext,
  ): void
  /**
   * Clears all pending launches and listeners; every handler obtained from
   * this store becomes permanently unusable (Provider unmount / sign-out).
   */
  dispose(): void
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
  const pendingLaunches = new Map<string, {
    accountId: string
    launch: ResolveLaunchResponse
    contextGeneration: number
  }>()
  const listeners = new Set<ProductSpaceAppLaunchListener>()
  let committedContextKey: string | null = null
  let committedLive: ProductSpaceLaunchHandoffLiveContext | null = null
  let contextGeneration = 0
  let disposed = false

  function pruneExpired(): void {
    for (const [key, pending] of pendingLaunches) {
      if (Date.parse(pending.launch.expiresAt) <= Date.now()) pendingLaunches.delete(key)
    }
  }

  return {
    publish(live, accountId, launch): ProductSpaceAppLaunchRequest {
      if (disposed) {
        throw new Error('ProductSpace App launch handoff store is disposed')
      }
      // A caller whose captured live context no longer matches the committed
      // one is a stale closure — rejected before anything is sealed.
      if (
        !committedLive
        || committedContextKey === null
        || live.accountId !== committedLive.accountId
        || live.productSpaceId !== committedLive.productSpaceId
      ) {
        throw new Error('ProductSpace App launch handoff belongs to another ProductSpace context')
      }
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
      pendingLaunches.set(request.handoffId, {
        accountId,
        launch,
        contextGeneration,
      })
      while (pendingLaunches.size > MAX_PENDING_LAUNCHES) {
        const oldestKey = pendingLaunches.keys().next().value as string | undefined
        if (!oldestKey) break
        pendingLaunches.delete(oldestKey)
      }
      for (const listener of listeners) listener(request)
      return request
    },

    take(live, handoffId, expected): PendingProductSpaceAppLaunch | null {
      if (disposed) return null
      const pending = pendingLaunches.get(handoffId)
      if (!pending) return null
      // A handle is single-attempt as well as single-use — the deletion
      // happens BEFORE any validation, so a stale or forged consumer cannot
      // probe the tuple and retry later.
      pendingLaunches.delete(handoffId)
      const { launch } = pending
      // Stale-closure guard: the caller's captured live context must still
      // be the committed one (see commitContext).
      if (
        !committedLive
        || committedContextKey === null
        || live.accountId !== committedLive.accountId
        || live.productSpaceId !== committedLive.productSpaceId
      ) return null
      // Generation fence: a handle sealed under a previous committed context
      // is dead even when the context later returns to its sealing identity
      // (A→B→A can never revive it).
      if (pending.contextGeneration !== contextGeneration) return null
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
      if (disposed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    commitContext(
      contextKey: string,
      live: ProductSpaceLaunchHandoffLiveContext,
    ): void {
      // Re-arm is allowed for the SAME provider instance re-running its
      // commit effect (StrictMode double-invocation); a disposed store stays
      // dead for every externally captured handler because re-arm is only
      // reachable through the Provider's own effect.
      if (disposed) {
        disposed = false
        committedContextKey = null
        committedLive = null
      }
      if (contextKey === committedContextKey) return
      // The context key is the shared collision-free versioned tuple
      // (createProductSpaceContextKey) — never a delimiter concatenation.
      committedContextKey = contextKey
      committedLive = { accountId: live.accountId, productSpaceId: live.productSpaceId }
      contextGeneration += 1
      // Every committed context change permanently invalidates handles from
      // all previous generations.
      pendingLaunches.clear()
    },

    dispose(): void {
      disposed = true
      pendingLaunches.clear()
      listeners.clear()
    },
  }
}
