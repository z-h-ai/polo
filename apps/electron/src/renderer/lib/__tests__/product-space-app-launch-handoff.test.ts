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

// Collision-shaped ALIASES of the same delimiter concatenation — never the
// real key format, but they document why commitContext takes the shared
// versioned tuple.
const liveB: ProductSpaceLaunchHandoffLiveContext = {
  accountId: 'account-a',
  productSpaceId: 'space-b',
}

const collidingKeyForA = 'a|b|c'

describe('ProductSpace App launch handoff store', () => {
  it('hands credentials to POO-47 once without placing them in tab context', () => {
    const store = createProductSpaceLaunchHandoffStore()
    store.commitContext(collidingKeyForA, liveA, 0)
    const published: unknown[] = []
    const unsubscribe = store.onLaunch(liveA, 0, request => published.push(request))
    const request = store.publish(liveA, 0, 'account-a', launch)
    unsubscribe()
    expect(request.context).not.toHaveProperty('launchToken')
    expect(request).not.toHaveProperty('launch')
    expect(published).toEqual([request])
    expect(store.take(liveA, 0, request.handoffId, context)).toEqual({
      accountId: 'account-a',
      launch,
    })
    expect(store.take(liveA, 0, request.handoffId, context)).toBeNull()
  })

  it('fails closed when a persisted tab names another artifact instance', () => {
    const store = createProductSpaceLaunchHandoffStore()
    store.commitContext(collidingKeyForA, liveA, 0)
    const request = store.publish(liveA, 0, 'account-a', launch)
    expect(store.take(liveA, 0, request.handoffId, {
      ...context,
      artifactInstanceId: 'artifact-b',
    })).toBeNull()
    expect(store.take(liveA, 0, request.handoffId, context)).toBeNull()
  })

  it('refuses to publish without a committed context or for another account/space', () => {
    const store = createProductSpaceLaunchHandoffStore()
    // No commitContext yet: nothing is committed, so nothing may be sealed.
    expect(() => store.publish(liveA, 0, 'account-a', launch)).toThrow(
      'another ProductSpace context',
    )
    store.commitContext(collidingKeyForA, liveA, 0)
    expect(() => store.publish(liveA, 0, 'account-b', launch)).toThrow(
      'another ProductSpace context',
    )
    expect(() => store.publish(liveA, 0, 'account-a', {
      ...launch,
      productSpaceId: 'space-b' as never,
    })).toThrow('another ProductSpace context')
  })

  it('fails closed when the committed context switched after the handoff was sealed', () => {
    const store = createProductSpaceLaunchHandoffStore()
    store.commitContext('account-a|space-a', liveA, 0)
    const request = store.publish(liveA, 0, 'account-a', launch)

    // The committed context is supplied per call — a consumer running under
    // space B (or account B, or signed out) can never take an A handle.
    expect(store.take(
      { accountId: 'account-a', productSpaceId: 'space-b' },
      0,
      request.handoffId,
      context,
    )).toBeNull()
    expect(store.take(
      { accountId: 'account-b', productSpaceId: 'space-a' },
      0,
      request.handoffId,
      context,
    )).toBeNull()
    expect(store.take(
      { accountId: '', productSpaceId: '' },
      0,
      request.handoffId,
      context,
    )).toBeNull()
    // The failed (stale-live) attempts never drain the handle — only the
    // committed caller can consume it, exactly once.
    expect(store.take(liveA, 0, request.handoffId, context)).toEqual({
      accountId: 'account-a',
      launch,
    })
    expect(store.take(liveA, 0, request.handoffId, context)).toBeNull()
  })

  it('keeps provider-owned stores isolated from each other', () => {
    const storeA = createProductSpaceLaunchHandoffStore()
    const storeB = createProductSpaceLaunchHandoffStore()
    storeA.commitContext(collidingKeyForA, liveA, 0)
    storeB.commitContext(collidingKeyForA, liveA, 0)
    const request = storeA.publish(liveA, 0, 'account-a', launch)
    // Another provider instance (fresh mount, another account) can neither
    // see nor drain this handle.
    expect(storeB.take(liveA, 0, request.handoffId, context)).toBeNull()
    expect(storeA.take(liveA, 0, request.handoffId, context)).toEqual({
      accountId: 'account-a',
      launch,
    })
  })

  it('never revives a handle after A→B→A without probing in B', () => {
    const store = createProductSpaceLaunchHandoffStore()
    store.commitContext('account-a|space-a', liveA, 0)
    const request = store.publish(liveA, 0, 'account-a', launch)

    // Switch to B (committed), then back to A — WITHOUT anyone probing the
    // old handle in B. The lease never repeats for a re-entered context.
    store.commitContext('account-a|space-b', liveA, 1)
    store.commitContext('account-a|space-a', liveA, 2)

    expect(store.take(liveA, 2, request.handoffId, context)).toBeNull()
  })

  it('rejects a STALE publisher re-sealing a pre-transition token after A→B→A', () => {
    const store = createProductSpaceLaunchHandoffStore()
    store.commitContext('account-a|space-a', liveA, 0)
    // The old A closure holds a still-unexpired resolve-launch token.
    const staleClosurePublish = (fixture = launch) => store.publish(liveA, 0, 'account-a', fixture)

    // A→B→A: the committed context RETURNS to A, but the old lease (0) can
    // never become current again (B consumed lease 1, re-entered A holds 2).
    store.commitContext('account-a|space-b', liveA, 1)
    store.commitContext('account-a|space-a', liveA, 2)

    expect(() => staleClosurePublish()).toThrow('another ProductSpace context')
    // The current-generation consumer can still publish a FRESH launch and
    // a current-lease consumer can take it.
    const fresh = store.publish(liveA, 2, 'account-a', launch)
    expect(store.take(liveA, 2, fresh.handoffId, context)).not.toBeNull()
  })

  it('never lets a stale A listener observe or burn a B handle after the context commits', () => {
    const store = createProductSpaceLaunchHandoffStore()
    store.commitContext('account-a|space-a', liveA, 0)
    const staleSeen: unknown[] = []
    const unsubscribeStale = store.onLaunch(liveA, 0, request => staleSeen.push(request))

    // B commits: the stale A listener is atomically retired; B's listener
    // subscribes under B's lease.
    store.commitContext('account-a|space-b', liveB, 1)
    const bSeen: unknown[] = []
    store.onLaunch(liveB, 1, request => bSeen.push(request))

    const launchB = {
      ...launch,
      productSpaceId: 'space-b' as never,
      catalogEntryId: 'entry-b' as never,
      subject: {
        kind: 'artifact_instance' as const,
        artifactType: 'app' as const,
        artifactInstanceId: 'artifact-b' as never,
        versionId: 'version-b' as never,
        version: '1.0.0',
      },
    }
    const request = store.publish(liveB, 1, 'account-a', launchB)

    // Exactly ONE delivery — to the current B listener. The stale A listener
    // was neither notified nor able to burn the single-attempt handle.
    unsubscribeStale()
    expect(staleSeen).toEqual([])
    expect(bSeen).toEqual([request])
    expect(store.take(liveB, 1, request.handoffId, {
      ...context,
      accountId: 'account-a',
      productSpaceId: 'space-b',
      catalogEntryId: 'entry-b',
      artifactInstanceId: 'artifact-b',
      versionId: 'version-b',
    })).not.toBeNull()
  })

  it('fails publish and take closed after dispose', () => {
    const store = createProductSpaceLaunchHandoffStore()
    store.commitContext(collidingKeyForA, liveA, 0)
    const request = store.publish(liveA, 0, 'account-a', launch)

    let observed: unknown = 'not-run'
    const unsubscribe = store.onLaunch(liveA, 0, () => {
      observed = 'listener-fired'
    })
    unsubscribe()

    store.dispose()
    expect(store.take(liveA, 0, request.handoffId, context)).toBeNull()
    expect(() => store.publish(liveA, 0, 'account-a', launch)).toThrow('disposed')
    // Listeners were cleared with the dispose: none fire afterwards.
    expect(observed).toBe('not-run')
    const seen: unknown[] = []
    store.onLaunch(liveA, 0, () => seen.push(1))
    expect(() => store.publish(liveA, 0, 'account-a', launch)).toThrow('disposed')
    expect(seen).toEqual([])
  })
})
