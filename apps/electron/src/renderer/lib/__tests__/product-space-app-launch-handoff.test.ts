import { describe, expect, it } from 'bun:test'
import {
  createProductSpaceLaunchHandoffStore,
  type ProductSpaceLaunchHandoffLiveContext,
} from '../product-space-app-launch-handoff'

const launch = {
  contractVersion: 1 as const,
  productSpaceId: 'space-a' as never,
  catalogEntryId: 'entry-a' as never,
  resolvedAt: '2099-01-01T00:00:00.000Z',
  expiresAt: '2099-01-01T00:10:00.000Z',
  subject: {
    kind: 'artifact_instance' as const,
    artifactType: 'app' as const,
    artifactInstanceId: 'artifact-a' as never,
    versionId: 'version-a' as never,
    version: '1.0.0',
  },
  payer: { kind: 'account' as const },
  delivery: {
    kind: 'web_url' as const,
    url: 'https://app.example.test',
    launchToken: 'fresh-launch-token',
  },
}

const context = {
  accountId: 'account-a',
  productSpaceId: 'space-a',
  catalogEntryId: 'entry-a',
  artifactInstanceId: 'artifact-a',
  versionId: 'version-a',
  version: '1.0.0',
  deliveryKind: 'web_url' as const,
  resolvedAt: launch.resolvedAt,
  expiresAt: launch.expiresAt,
}

const liveA: ProductSpaceLaunchHandoffLiveContext = {
  accountId: 'account-a',
  productSpaceId: 'space-a',
}

describe('ProductSpace App launch handoff store', () => {
  it('hands credentials to POO-47 once without placing them in tab context', () => {
    const store = createProductSpaceLaunchHandoffStore()
    const published: unknown[] = []
    const unsubscribe = store.onLaunch(request => published.push(request))
    const request = store.publish(liveA, 'account-a', launch)
    unsubscribe()
    expect(request.context).not.toHaveProperty('launchToken')
    expect(request).not.toHaveProperty('launch')
    expect(published).toEqual([request])
    expect(store.take(liveA, request.handoffId, context)).toEqual({
      accountId: 'account-a',
      launch,
    })
    expect(store.take(liveA, request.handoffId, context)).toBeNull()
  })

  it('fails closed when a persisted tab names another artifact instance', () => {
    const store = createProductSpaceLaunchHandoffStore()
    const request = store.publish(liveA, 'account-a', launch)
    expect(store.take(liveA, request.handoffId, {
      ...context,
      artifactInstanceId: 'artifact-b',
    })).toBeNull()
    expect(store.take(liveA, request.handoffId, context)).toBeNull()
  })

  it('refuses to publish without an active context or for another account/space', () => {
    const store = createProductSpaceLaunchHandoffStore()
    expect(() => store.publish(
      { accountId: '', productSpaceId: '' },
      'account-a',
      launch,
    )).toThrow('requires an active ProductSpace')
    expect(() => store.publish(liveA, 'account-b', launch)).toThrow(
      'another ProductSpace context',
    )
    expect(() => store.publish(liveA, 'account-a', {
      ...launch,
      productSpaceId: 'space-b' as never,
    })).toThrow('another ProductSpace context')
  })

  it('fails closed when the committed context switched after the handoff was sealed', () => {
    const store = createProductSpaceLaunchHandoffStore()
    const request = store.publish(liveA, 'account-a', launch)

    // The committed context is supplied per call — a consumer running under
    // space B (or account B, or signed out) can never take an A handle.
    expect(store.take(
      { accountId: 'account-a', productSpaceId: 'space-b' },
      request.handoffId,
      context,
    )).toBeNull()
    expect(store.take(
      { accountId: 'account-b', productSpaceId: 'space-a' },
      request.handoffId,
      context,
    )).toBeNull()
    expect(store.take(
      { accountId: '', productSpaceId: '' },
      request.handoffId,
      context,
    )).toBeNull()
    // The failed attempts stay single-attempt: no probing and retrying.
    expect(store.take(liveA, request.handoffId, context)).toBeNull()
  })

  it('keeps provider-owned stores isolated from each other', () => {
    const storeA = createProductSpaceLaunchHandoffStore()
    const storeB = createProductSpaceLaunchHandoffStore()
    const request = storeA.publish(liveA, 'account-a', launch)
    // Another provider instance (fresh mount, another account) can neither
    // see nor drain this handle.
    expect(storeB.take(liveA, request.handoffId, context)).toBeNull()
    expect(storeA.take(liveA, request.handoffId, context)).toEqual({
      accountId: 'account-a',
      launch,
    })
  })
})
