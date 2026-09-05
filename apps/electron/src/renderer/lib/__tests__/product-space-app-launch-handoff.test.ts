import { beforeEach, describe, expect, it } from 'bun:test'
import {
  resetProductSpaceAppLaunchHandoffsForTests,
  stageProductSpaceAppLaunch,
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

beforeEach(resetProductSpaceAppLaunchHandoffsForTests)

describe('ProductSpace App launch handoff', () => {
  it('hands credentials to POO-47 once without placing them in tab context', () => {
    stageProductSpaceAppLaunch('app-a', 'account-a', launch)
    expect(context).not.toHaveProperty('launchToken')
    expect(takeProductSpaceAppLaunch('app-a', context)).toEqual({
      accountId: 'account-a',
      launch,
    })
    expect(takeProductSpaceAppLaunch('app-a', context)).toBeNull()
  })

  it('fails closed when a persisted tab names another artifact instance', () => {
    stageProductSpaceAppLaunch('app-a', 'account-a', launch)
    expect(takeProductSpaceAppLaunch('app-a', {
      ...context,
      artifactInstanceId: 'artifact-b',
    })).toBeNull()
  })
})
