import { beforeEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import {
  KEYS,
  set as setLocalStorage,
} from '../local-storage'
import {
  createHomeRecentContextKey,
  loadHomeRecentApps,
  saveHomeRecentApps,
  SIGNED_OUT_HOME_RECENT_CONTEXT_KEY,
} from '../home-recent-apps'

GlobalRegistrator.register()

const stored = new Map<string, Array<{
  id: string
  kind: 'builtin' | 'external' | 'organization'
  openedAt: number
}>>()
const getHomeRecentApps = jest.fn(async (contextKey: string) =>
  stored.get(contextKey) ?? [])
const setHomeRecentApps = jest.fn(async (
  contextKey: string,
  apps: Array<{
    id: string
    kind: 'builtin' | 'external' | 'organization'
    openedAt: number
  }>,
) => {
  stored.set(contextKey, apps)
  return apps
})

beforeEach(() => {
  localStorage.clear()
  stored.clear()
  getHomeRecentApps.mockClear()
  setHomeRecentApps.mockClear()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      getHomeRecentApps,
      setHomeRecentApps,
    },
  })
})

describe('config-backed Home recent Apps', () => {
  it('uses collision-free versioned organization contexts', () => {
    const first = createHomeRecentContextKey(JSON.stringify(['a:b', 'c']))
    const second = createHomeRecentContextKey(JSON.stringify(['a', 'b:c']))

    expect(first).not.toBe(second)
    expect(createHomeRecentContextKey(null))
      .toBe(SIGNED_OUT_HOME_RECENT_CONTEXT_KEY)
  })

  it('persists account and organization histories independently', async () => {
    const accountA = createHomeRecentContextKey(
      JSON.stringify(['account-a', '组织:a']),
    )
    const accountB = createHomeRecentContextKey(
      JSON.stringify(['account-b', '组织:a']),
    )
    await saveHomeRecentApps(accountA, [{
      id: 'app-a',
      kind: 'organization',
      openedAt: 2,
    }])
    await saveHomeRecentApps(accountB, [{
      id: 'app-b',
      kind: 'organization',
      openedAt: 3,
    }])

    expect(await loadHomeRecentApps(accountA))
      .toEqual([{ id: 'app-a', kind: 'organization', openedAt: 2 }])
    expect(await loadHomeRecentApps(accountB))
      .toEqual([{ id: 'app-b', kind: 'organization', openedAt: 3 }])
  })

  it('passes maximum NUL scope identities through the renderer RPC intact', async () => {
    const entityId = '\0'.repeat(512)
    const contextKey = createHomeRecentContextKey(
      JSON.stringify([entityId, entityId]),
    )
    const recentAppId = JSON.stringify([
      'catalog',
      entityId,
      entityId,
      entityId,
    ])
    const recent = {
      id: recentAppId,
      kind: 'organization' as const,
      openedAt: 7,
    }

    expect(contextKey).toHaveLength(6_154)
    expect(recentAppId).toHaveLength(9_236)
    await saveHomeRecentApps(contextKey, [recent])
    expect(setHomeRecentApps).toHaveBeenCalledWith(contextKey, [recent])
    expect(await loadHomeRecentApps(contextKey)).toEqual([recent])
    expect(getHomeRecentApps).toHaveBeenCalledWith(contextKey)
  })

  it('migrates the legacy localStorage value once after a durable write', async () => {
    const organizationContext = createHomeRecentContextKey(
      JSON.stringify(['legacy-account', 'legacy-organization']),
    )
    setLocalStorage(KEYS.homeRecentApps, [{
      id: 'legacy-app',
      kind: 'external' as const,
      openedAt: 5,
    }, {
      id: JSON.stringify([
        'catalog',
        'legacy-account',
        'legacy-organization',
        'legacy-catalog-app',
      ]),
      kind: 'organization' as const,
      openedAt: 4,
    }])

    expect(await loadHomeRecentApps(SIGNED_OUT_HOME_RECENT_CONTEXT_KEY))
      .toEqual([{ id: 'legacy-app', kind: 'external', openedAt: 5 }])
    expect(setHomeRecentApps).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem('craft-home-recent-apps')).toBeNull()

    expect(await loadHomeRecentApps(organizationContext)).toEqual([{
      id: JSON.stringify([
        'catalog',
        'legacy-account',
        'legacy-organization',
        'legacy-catalog-app',
      ]),
      kind: 'organization',
      openedAt: 4,
    }])
    expect(await loadHomeRecentApps(SIGNED_OUT_HOME_RECENT_CONTEXT_KEY))
      .toEqual([{ id: 'legacy-app', kind: 'external', openedAt: 5 }])
    expect(setHomeRecentApps).toHaveBeenCalledTimes(2)
  })
})
