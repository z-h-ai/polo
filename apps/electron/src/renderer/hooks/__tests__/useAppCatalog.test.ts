import { describe, expect, it } from 'bun:test'
import type { CatalogApp } from '@z-h-ai/shared/admin'
import { createLocalAppScopeKey } from '@z-h-ai/shared/protocol'
import {
  BUSY_RUNTIME_STATUS_LIMIT,
  CATALOG_RUNTIME_STATUS_LIMIT,
  compareCatalogVersions,
  createBusyStatusPoller,
  isNewerCatalogVersion,
  selectRuntimeStatusApps,
} from '../useAppCatalog'

describe('organization app catalog version comparison', () => {
  it('only marks higher semantic versions as updates', () => {
    expect(isNewerCatalogVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerCatalogVersion('1.10.0', '1.9.9')).toBe(true)
    expect(isNewerCatalogVersion('1.0.0', '1.0.0')).toBe(false)
    expect(isNewerCatalogVersion('1.0.0', '2.0.0')).toBe(false)
  })

  it('supports a leading v and does not guess for opaque versions', () => {
    expect(isNewerCatalogVersion('v2.0.0', '1.0.0')).toBe(true)
    expect(isNewerCatalogVersion('release-b', 'release-a')).toBe(false)
    expect(isNewerCatalogVersion('release-a', 'release-a')).toBe(false)
  })

  it('uses SemVer prerelease precedence', () => {
    expect(isNewerCatalogVersion('1.0.0', '1.0.0-rc.1')).toBe(true)
    expect(isNewerCatalogVersion('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true)
    expect(isNewerCatalogVersion('1.0.0-beta.1', '1.0.0')).toBe(false)
  })

  it('orders numeric identifiers beyond JavaScript safe integers', () => {
    expect(isNewerCatalogVersion(
      '90071992547409931234567890.0.0',
      '9007199254740993123456789.0.0',
    )).toBe(true)
    expect(isNewerCatalogVersion(
      '1.0.0-90071992547409931234567890',
      '1.0.0-9007199254740993123456789',
    )).toBe(true)
  })

  it('returns an explicit invalid fallback for fourth segments and invalid versions', () => {
    expect(compareCatalogVersions('1.2.3.4', '1.2.3')).toEqual({
      strategy: 'invalid',
      order: null,
      reason: 'invalid_semver',
    })
    expect(compareCatalogVersions('release-b', 'release-a')).toEqual({
      strategy: 'invalid',
      order: null,
      reason: 'invalid_semver',
    })
    expect(compareCatalogVersions(' 2.0.0', '1.0.0')).toEqual({
      strategy: 'invalid',
      order: null,
      reason: 'invalid_semver',
    })
    expect(compareCatalogVersions('2.0.0 ', '1.0.0')).toEqual({
      strategy: 'invalid',
      order: null,
      reason: 'invalid_semver',
    })
    expect(compareCatalogVersions('V2.0.0', '1.0.0')).toEqual({
      strategy: 'invalid',
      order: null,
      reason: 'invalid_semver',
    })
  })
})

function bundleApp(id: string): CatalogApp {
  return {
    id,
    organizationId: 'organization-1',
    name: id,
    description: '',
    deliveryMode: 'local_bundle',
    currentRelease: {
      version: '1.0.0',
      runtime: 'static',
      downloadUrl: 'https://example.com/app.zip',
      checksum: 'a'.repeat(64),
      sizeBytes: 1,
    },
    sortOrder: 0,
  }
}

describe('organization app runtime status selection', () => {
  it('keeps the complete catalog selection and leaves RPC chunking to the caller', () => {
    for (const count of [
      1_000,
      1_001,
      CATALOG_RUNTIME_STATUS_LIMIT,
      CATALOG_RUNTIME_STATUS_LIMIT + 1,
    ]) {
      const apps = Array.from(
        { length: count },
        (_, index) => bundleApp(`app-${index}`),
      )
      expect(selectRuntimeStatusApps(apps)).toHaveLength(count)
    }
  })

  it('polls only complete busy scope keys and applies the busy ceiling', () => {
    const apps = Array.from(
      { length: BUSY_RUNTIME_STATUS_LIMIT + 10 },
      (_, index) => bundleApp(`app-${index}`),
    )
    const scopeKey = (app: CatalogApp) => createLocalAppScopeKey({
      kind: 'catalog',
      accountId: 'account-1',
      organizationId: app.organizationId,
      catalogAppId: app.id,
    })
    const busyIds = new Set(apps.map(scopeKey))
    const selected = selectRuntimeStatusApps(apps, busyIds, scopeKey)

    expect(selected).toHaveLength(BUSY_RUNTIME_STATUS_LIMIT)
    expect(selected.every(app => busyIds.has(scopeKey(app)))).toBe(true)
    expect(selectRuntimeStatusApps(
      apps,
      new Set([scopeKey(apps[3]!)]),
      scopeKey,
    )).toEqual([
      apps[3],
    ])
  })
})

describe('busy runtime status polling', () => {
  it('keeps one request in flight and prevents an invalidated response from committing', async () => {
    let nextTimerId = 0
    const scheduled = new Map<number, () => void>()
    const timers = {
      set(callback: () => void) {
        const id = ++nextTimerId
        scheduled.set(id, callback)
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clear(timer: ReturnType<typeof setTimeout>) {
        scheduled.delete(timer as unknown as number)
      },
    }
    const runNextTimer = () => {
      const entry = [...scheduled.entries()]
        .sort(([left], [right]) => left - right)[0]
      expect(entry).toBeDefined()
      scheduled.delete(entry![0])
      entry![1]()
    }
    const flushMicrotasks = async () => {
      for (let index = 0; index < 8; index += 1) {
        await Promise.resolve()
      }
    }
    let resolveFirst!: () => void
    let resolveSecond!: () => void
    const first = new Promise<void>(resolve => {
      resolveFirst = resolve
    })
    const second = new Promise<void>(resolve => {
      resolveSecond = resolve
    })
    let active = 0
    let maxActive = 0
    const requestGenerations: number[] = []
    const committed: string[] = []
    const poller = createBusyStatusPoller(500, timers)

    poller.replace(async request => {
      active += 1
      maxActive = Math.max(maxActive, active)
      requestGenerations.push(request.requestGeneration)
      await first
      if (request.isCurrent()) committed.push('stale')
      active -= 1
    })
    runNextTimer()
    await flushMicrotasks()
    expect(active).toBe(1)

    poller.replace(async request => {
      active += 1
      maxActive = Math.max(maxActive, active)
      requestGenerations.push(request.requestGeneration)
      await second
      if (request.isCurrent()) committed.push('current')
      active -= 1
    })
    runNextTimer()
    await flushMicrotasks()
    expect(requestGenerations).toEqual([1])
    expect(maxActive).toBe(1)

    resolveFirst()
    await flushMicrotasks()
    expect(requestGenerations).toEqual([1, 2])
    expect(committed).toEqual([])
    expect(maxActive).toBe(1)

    resolveSecond()
    await flushMicrotasks()
    expect(committed).toEqual(['current'])
    expect(maxActive).toBe(1)
    poller.stop()
  })
})
