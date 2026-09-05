import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { ProductSpaceAppLaunchContext } from '../../shared/tab-browser-types'

export interface PendingProductSpaceAppLaunch {
  accountId: string
  launch: ResolveLaunchResponse
}

const pendingLaunches = new Map<string, PendingProductSpaceAppLaunch>()
const MAX_PENDING_LAUNCHES = 64

function isAppLaunch(launch: ResolveLaunchResponse) {
  return launch.subject.kind === 'artifact_instance'
    && launch.subject.artifactType === 'app'
    && launch.delivery.kind !== 'built_in'
    && Date.parse(launch.expiresAt) > Date.now()
}

/**
 * Stages the credential-bearing resolve-launch response for POO-47 without
 * putting launch tokens or signed bundle URLs into localStorage/tab state.
 */
export function stageProductSpaceAppLaunch(
  appId: string,
  accountId: string,
  launch: ResolveLaunchResponse,
): void {
  if (!appId || !accountId || !isAppLaunch(launch)) {
    throw new Error('Invalid ProductSpace App launch handoff')
  }
  for (const [key, pending] of pendingLaunches) {
    if (Date.parse(pending.launch.expiresAt) <= Date.now()) {
      pendingLaunches.delete(key)
    }
  }
  pendingLaunches.set(appId, { accountId, launch })
  while (pendingLaunches.size > MAX_PENDING_LAUNCHES) {
    const oldestKey = pendingLaunches.keys().next().value as string | undefined
    if (!oldestKey) break
    pendingLaunches.delete(oldestKey)
  }
}

/**
 * One-shot POO-47 consumer. Every persisted identity must still match the
 * staged response; mismatch or expiry consumes nothing and returns null.
 */
export function takeProductSpaceAppLaunch(
  appId: string,
  expected: ProductSpaceAppLaunchContext,
): PendingProductSpaceAppLaunch | null {
  const pending = pendingLaunches.get(appId)
  if (!pending) return null
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
  pendingLaunches.delete(appId)
  return pending
}

export function resetProductSpaceAppLaunchHandoffsForTests(): void {
  pendingLaunches.clear()
}
