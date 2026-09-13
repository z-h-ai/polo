import { describe, expect, it } from 'bun:test'
import {
  AppRuntimeCenter,
  getAppRuntimeCenter,
  resetAppRuntimeCenterForTests,
} from './app-runtime-center.ts'
import { createProductSpaceAppRuntimeIdentityKey } from '@polo-ai/shared/product-spaces'

const identity = {
  accountId: 'account-a',
  productSpaceId: 'space-a',
  artifactInstanceId: 'artifact-a',
  versionId: 'version-a',
  version: '1.0.0',
}

function projectionInput(overrides: Partial<Parameters<AppRuntimeCenter['publish']>[0]> = {}) {
  return {
    identityKey: createProductSpaceAppRuntimeIdentityKey(identity),
    identity,
    workspaceId: 'ws-a',
    executionId: 'local-app:space-a:artifact-a:1',
    runtimeGeneration: 1,
    scopeGeneration: 1,
    runtimeKind: 'python' as const,
    status: 'running' as const,
    ...overrides,
  }
}

describe('AppRuntimeCenter (POO-54)', () => {
  it('isolates personal-A vs enterprise-B same-named apps and versions', () => {
    const center = new AppRuntimeCenter()
    const a = center.publish(projectionInput()).projection
    const b = center.publish(projectionInput({
      identityKey: createProductSpaceAppRuntimeIdentityKey({
        ...identity,
        accountId: 'account-b',
        productSpaceId: 'space-b',
      }),
      identity: { ...identity, accountId: 'account-b', productSpaceId: 'space-b' },
      workspaceId: 'ws-b',
      executionId: 'local-app:space-b:artifact-a:2',
    })).projection
    expect(center.list()).toHaveLength(2)
    expect(a.identityKey).not.toBe(b.identityKey)
    expect(center.findByIdentity(identity)?.executionId).toBe(a.executionId)
    // Same artifact, different version never shares a projection row.
    expect(center.findByIdentity({ ...identity, versionId: 'version-b' })).toBeUndefined()
  })

  it('rejects late writes from a replaced generation via generation CAS', () => {
    const center = new AppRuntimeCenter()
    center.publish(projectionInput({ runtimeGeneration: 1 }))
    // Replacement publishes generation 2.
    const replacement = center.publish(projectionInput({
      runtimeGeneration: 2,
      executionId: 'local-app:space-a:artifact-a:9',
    }))
    expect(replacement.applied).toBe(true)
    // A late event from generation 1 must not overwrite or delete it.
    const late = center.publish(projectionInput({
      runtimeGeneration: 1,
      status: 'failed',
      error: { code: 'PROCESS_CRASHED' },
    }), 1)
    expect(late.applied).toBe(false)
    expect(late.projection.runtimeGeneration).toBe(2)
    expect(center.clear(
      createProductSpaceAppRuntimeIdentityKey(identity),
      1,
    )).toBe(false)
    expect(center.list()).toHaveLength(1)
    // Only the exact current generation can clear itself.
    expect(center.clear(createProductSpaceAppRuntimeIdentityKey(identity), 2)).toBe(true)
    expect(center.list()).toHaveLength(0)
  })

  it('never stores prompts, tokens or secrets in the projection', () => {
    const center = new AppRuntimeCenter()
    const { projection } = center.publish(projectionInput({
      error: { code: 'START_FAILED' },
    }))
    const serialized = JSON.stringify(projection)
    for (const canary of [
      'POLO_APP_API_TOKEN',
      'bearer',
      'capability',
      'prompt',
      'payer',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(canary)
    }
    expect(Object.keys(projection).sort()).toEqual([
      'contractVersion',
      'error',
      'executionId',
      'identity',
      'identityKey',
      'revision',
      'runtimeGeneration',
      'runtimeKind',
      'scopeGeneration',
      'status',
      'workspaceId',
    ].sort())
  })

  it('subscribers observe mutations and faulty subscribers never break ownership', () => {
    resetAppRuntimeCenterForTests()
    const center = getAppRuntimeCenter()
    const seen: number[] = []
    center.subscribe(() => {
      throw new Error('subscriber fault')
    })
    center.subscribe(snapshot => seen.push(snapshot.length))
    center.publish(projectionInput())
    center.clear(createProductSpaceAppRuntimeIdentityKey(identity), 1)
    expect(seen).toEqual([1, 0])
    // The singleton is stable; reset gives a fresh instance.
    resetAppRuntimeCenterForTests()
    expect(getAppRuntimeCenter()).not.toBe(center)
    expect(getAppRuntimeCenter().list()).toHaveLength(0)
  })
})
