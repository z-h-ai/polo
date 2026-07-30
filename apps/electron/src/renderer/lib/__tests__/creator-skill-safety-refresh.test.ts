import { beforeEach, describe, expect, it } from 'bun:test'
import {
  invalidateCreatorSkillSafetyRefresh,
  refreshCreatorSkillSafetyStatus,
  type CreatorSkillSafetyRefreshIdentity,
} from '../creator-skill-safety-refresh'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const identity: CreatorSkillSafetyRefreshIdentity = {
  workspaceId: 'workspace-one',
  artifactId: 'artifact-one',
  version: '1.0.0',
  archiveChecksum: 'a'.repeat(64),
}

let getSafetyStatus: () => Promise<Record<string, unknown>>
let persistedStatuses: string[]
const api = {
  getSafetyStatus: async () => getSafetyStatus() as never,
  updateSafetyStatus: async (input: {
    status: { status: string }
  }) => {
    persistedStatuses.push(input.status.status)
    return { success: true as const }
  },
}

beforeEach(() => {
  invalidateCreatorSkillSafetyRefresh(identity)
  persistedStatuses = []
})

describe('refreshCreatorSkillSafetyStatus', () => {
  it('shares one in-flight request and one Ledger update per exact identity', async () => {
    const response = deferred<Record<string, unknown>>()
    let requests = 0
    getSafetyStatus = () => {
      requests += 1
      return response.promise
    }

    const first = refreshCreatorSkillSafetyStatus(identity, api)
    const second = refreshCreatorSkillSafetyStatus(identity, api)
    expect(first).toBe(second)
    expect(requests).toBe(1)

    response.resolve({
      success: true,
      artifactId: identity.artifactId,
      version: identity.version,
      archiveChecksum: identity.archiveChecksum,
      status: 'revoked',
    })
    expect((await first).persisted).toBe(true)
    expect(await second).toMatchObject({ current: true, persisted: true })
    expect(persistedStatuses).toEqual(['revoked'])
  })

  it('discards an older active response after a newer revoked generation', async () => {
    const oldActive = deferred<Record<string, unknown>>()
    const newRevoked = deferred<Record<string, unknown>>()
    let requests = 0
    getSafetyStatus = () => {
      requests += 1
      return requests === 1 ? oldActive.promise : newRevoked.promise
    }

    const stale = refreshCreatorSkillSafetyStatus(identity, api)
    invalidateCreatorSkillSafetyRefresh(identity)
    const current = refreshCreatorSkillSafetyStatus(identity, api)
    newRevoked.resolve({
      success: true,
      artifactId: identity.artifactId,
      version: identity.version,
      archiveChecksum: identity.archiveChecksum,
      status: 'revoked',
    })
    expect(await current).toMatchObject({ current: true, persisted: true })

    oldActive.resolve({
      success: true,
      artifactId: identity.artifactId,
      version: identity.version,
      archiveChecksum: identity.archiveChecksum,
      status: 'active',
    })
    expect(await stale).toMatchObject({ current: false, persisted: false })
    expect(persistedStatuses).toEqual(['revoked'])
  })
})
