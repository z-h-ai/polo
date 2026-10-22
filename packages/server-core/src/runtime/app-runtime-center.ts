import {
  RUNTIME_PROJECTION_CONTRACT_VERSION,
  type AppRuntimeProjection,
  type ProductSpaceAppRuntimeIdentity,
} from '@polo-ai/shared/product-spaces'

export type AppRuntimeProjectionInput = Omit<
  AppRuntimeProjection,
  'contractVersion' | 'revision'
>

export type AppRuntimeProjectionListener = (
  snapshot: ReadonlyArray<AppRuntimeProjection>,
) => void

/**
 * Single owner of the active ProductSpace App runtime projection. Only the
 * non-secret runtime identity, generations, workspace, status and one typed
 * platform error are stored — never prompts, bodies, tokens or payer data.
 * Every mutation is guarded by a runtime-generation CAS so a late event from
 * a replaced (older) generation can never overwrite or delete a newer one.
 */
export class AppRuntimeCenter {
  private readonly projections = new Map<string, AppRuntimeProjection>()
  private readonly listeners = new Set<AppRuntimeProjectionListener>()
  private revisionCounter = 0

  /**
   * Publishes (upserts) one active projection. When `expectedRuntimeGeneration`
   * is provided and a different generation is already stored, the write is
   * rejected and the stored projection is returned untouched.
   */
  publish(
    input: AppRuntimeProjectionInput,
    expectedRuntimeGeneration?: number,
  ): { applied: true; projection: AppRuntimeProjection } | {
    applied: false
    projection: AppRuntimeProjection
  } {
    const identityKey = input.identityKey
    const existing = this.projections.get(identityKey)
    if (
      existing
      && expectedRuntimeGeneration !== undefined
      && existing.runtimeGeneration !== expectedRuntimeGeneration
    ) {
      return { applied: false, projection: existing }
    }
    const projection: AppRuntimeProjection = {
      ...input,
      contractVersion: RUNTIME_PROJECTION_CONTRACT_VERSION,
      revision: ++this.revisionCounter,
    }
    this.projections.set(identityKey, projection)
    this.notify()
    return { applied: true, projection }
  }

  /**
   * Generation-CAS clear: a stale generation's exit callback can only remove
   * its own projection and never a replacement's.
   */
  clear(identityKey: string, expectedRuntimeGeneration: number): boolean {
    const existing = this.projections.get(identityKey)
    if (!existing || existing.runtimeGeneration !== expectedRuntimeGeneration) {
      return false
    }
    this.projections.delete(identityKey)
    this.notify()
    return true
  }

  get(identityKey: string): AppRuntimeProjection | undefined {
    return this.projections.get(identityKey)
  }

  /** Finds the active projection for one account+space+artifact+version tuple. */
  findByIdentity(
    identity: Pick<
      ProductSpaceAppRuntimeIdentity,
      'accountId' | 'productSpaceId' | 'artifactInstanceId' | 'versionId'
    >,
  ): AppRuntimeProjection | undefined {
    for (const projection of this.projections.values()) {
      if (
        projection.identity.accountId === identity.accountId
        && projection.identity.productSpaceId === identity.productSpaceId
        && projection.identity.artifactInstanceId === identity.artifactInstanceId
        && projection.identity.versionId === identity.versionId
      ) {
        return projection
      }
    }
    return undefined
  }

  list(): ReadonlyArray<AppRuntimeProjection> {
    return [...this.projections.values()]
  }

  subscribe(listener: AppRuntimeProjectionListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    const snapshot = this.list()
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot)
      } catch {
        // A faulty subscriber can never break projection ownership.
      }
    }
  }
}

let center: AppRuntimeCenter | null = null

export function getAppRuntimeCenter(): AppRuntimeCenter {
  if (!center) center = new AppRuntimeCenter()
  return center
}

export function resetAppRuntimeCenterForTests(): void {
  center = null
}
