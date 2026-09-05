import { beforeEach, describe, expect, it } from 'bun:test'
import {
  resetProductSpaceAppLaunchHandoffsForTests,
  onProductSpaceAppLaunch,
  publishProductSpaceAppLaunch,
  syncProductSpaceLaunchHandoffContext,
  takeProductSpaceAppLaunch,
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

beforeEach(() => {
  resetProductSpaceAppLaunchHandoffsForTests()
  syncProductSpaceLaunchHandoffContext({
    accountId: 'account-a',
    productSpaceId: 'space-a',
  })
})

describe('ProductSpace App launch handoff', () => {
  it('hands credentials to POO-47 once without placing them in tab context', () => {
    const published: unknown[] = []
    const unsubscribe = onProductSpaceAppLaunch(request => published.push(request))
    const request = publishProductSpaceAppLaunch('account-a', launch)
    unsubscribe()
    expect(request.context).not.toHaveProperty('launchToken')
    expect(request).not.toHaveProperty('launch')
    expect(published).toEqual([request])
    expect(takeProductSpaceAppLaunch(request.handoffId, context)).toEqual({
      accountId: 'account-a',
      launch,
    })
    expect(takeProductSpaceAppLaunch(request.handoffId, context)).toBeNull()
  })

  it('fails closed when a persisted tab names another artifact instance', () => {
    const request = publishProductSpaceAppLaunch('account-a', launch)
    expect(takeProductSpaceAppLaunch(request.handoffId, {
      ...context,
      artifactInstanceId: 'artifact-b',
    })).toBeNull()
    expect(takeProductSpaceAppLaunch(request.handoffId, context)).toBeNull()
  })

  it('refuses to publish without an active ProductSpace context', () => {
    syncProductSpaceLaunchHandoffContext(null)
    expect(() => publishProductSpaceAppLaunch('account-a', launch)).toThrow(
      'requires an active ProductSpace',
    )
  })

  it('refuses to publish for another account or ProductSpace than the live context', () => {
    expect(() => publishProductSpaceAppLaunch('account-b', launch)).toThrow(
      'another ProductSpace context',
    )
    const otherSpaceLaunch = {
      ...launch,
      productSpaceId: 'space-b' as never,
    }
    expect(() => publishProductSpaceAppLaunch('account-a', otherSpaceLaunch)).toThrow(
      'another ProductSpace context',
    )
  })

  it('fails closed when the live context switched spaces after the handoff was sealed', () => {
    const request = publishProductSpaceAppLaunch('account-a', launch)
    syncProductSpaceLaunchHandoffContext({
      accountId: 'account-a',
      productSpaceId: 'space-b',
    })
    // The old sealed handoff is dropped outright: the stale consumer cannot
    // probe the tuple and the exact old context replay must not succeed.
    expect(takeProductSpaceAppLaunch(request.handoffId, context)).toBeNull()
  })

  it('fails closed when the live context switched accounts after the handoff was sealed', () => {
    const request = publishProductSpaceAppLaunch('account-a', launch)
    syncProductSpaceLaunchHandoffContext({
      accountId: 'account-b',
      productSpaceId: 'space-a',
    })
    expect(takeProductSpaceAppLaunch(request.handoffId, context)).toBeNull()
  })

  it('fails closed while signed out after the handoff was sealed', () => {
    const request = publishProductSpaceAppLaunch('account-a', launch)
    syncProductSpaceLaunchHandoffContext(null)
    expect(takeProductSpaceAppLaunch(request.handoffId, context)).toBeNull()
  })

  it('seals a new handoff after returning to the original context', () => {
    const request = publishProductSpaceAppLaunch('account-a', launch)
    syncProductSpaceLaunchHandoffContext({
      accountId: 'account-a',
      productSpaceId: 'space-b',
    })
    expect(takeProductSpaceAppLaunch(request.handoffId, context)).toBeNull()
    syncProductSpaceLaunchHandoffContext({
      accountId: 'account-a',
      productSpaceId: 'space-a',
    })
    const resealed = publishProductSpaceAppLaunch('account-a', launch)
    expect(takeProductSpaceAppLaunch(resealed.handoffId, context)).toEqual({
      accountId: 'account-a',
      launch,
    })
  })
})
