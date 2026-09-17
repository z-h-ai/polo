import { describe, expect, it } from 'bun:test'
import type { CatalogApp } from '@polo-ai/shared/admin'
import {
  createLocalAppScopeKey,
} from '@polo-ai/shared/protocol'
import {
  createHomeQuickAccessContextKey,
  resolveHomeQuickAccessApps,
  toggleHomeQuickAccessApp,
} from '../home-quick-access'

function catalogApp(id: string, overrides: Partial<CatalogApp> = {}): CatalogApp {
  return {
    id,
    organizationId: 'space-a',
    name: `App ${id}`,
    description: '',
    deliveryMode: 'remote_url',
    sortOrder: 0,
    availability: 'available',
    ...overrides,
  }
}

function scopeKeyForSpace(spaceId: string, appId: string): string {
  return createLocalAppScopeKey({
    kind: 'catalog',
    accountId: 'account-a',
    organizationId: spaceId,
    catalogAppId: appId,
  })
}

describe('home quick-access lib', () => {
  it('scopes the context key to the ProductSpace identity', () => {
    expect(
      createHomeQuickAccessContextKey('["account-a","space:personal"]'),
    ).toBe('v1:["account-a","space:personal"]')
    expect(createHomeQuickAccessContextKey(null)).toBe('v1:["signed-out"]')
    expect(createHomeQuickAccessContextKey(undefined))
      .toBe('v1:["signed-out"]')
  })

  it('toggles entries and appends additions in explicit order', () => {
    const first = toggleHomeQuickAccessApp([], 'scope-1', true, 100)
    expect(first).toEqual({
      next: [{ id: 'scope-1', addedAt: 100 }],
      rejected: false,
    })
    const second = toggleHomeQuickAccessApp(first.next, 'scope-2', true, 200)
    expect(second.next.map(entry => entry.id)).toEqual(['scope-1', 'scope-2'])
    const removed = toggleHomeQuickAccessApp(second.next, 'scope-1', false)
    expect(removed).toEqual({
      next: [{ id: 'scope-2', addedAt: 200 }],
      rejected: false,
    })
    // Toggling an existing entry off then on re-appends at the end.
    const reAdded = toggleHomeQuickAccessApp(removed.next, 'scope-1', true, 300)
    expect(reAdded.next.map(entry => entry.id)).toEqual(['scope-2', 'scope-1'])
  })

  it('rejects additions beyond five slots instead of evicting entries', () => {
    let current: ReturnType<typeof toggleHomeQuickAccessApp>['next'] = []
    for (let index = 1; index <= 5; index += 1) {
      current = toggleHomeQuickAccessApp(current, `scope-${index}`, true, index).next
    }
    const overflow = toggleHomeQuickAccessApp(current, 'scope-6', true, 6)
    expect(overflow.rejected).toBe(true)
    expect(overflow.next.map(entry => entry.id)).toEqual([
      'scope-1',
      'scope-2',
      'scope-3',
      'scope-4',
      'scope-5',
    ])
    // Removals always succeed, even at capacity.
    const removed = toggleHomeQuickAccessApp(current, 'scope-3', false)
    expect(removed.rejected).toBe(false)
    expect(removed.next.map(entry => entry.id)).toEqual([
      'scope-1',
      'scope-2',
      'scope-4',
      'scope-5',
    ])
  })

  it('resolves persisted ids only against available Apps of the active space', () => {
    const apps = [
      catalogApp('app-1'),
      catalogApp('app-2'),
      catalogApp('app-3', { availability: 'withdrawn' }),
      catalogApp('app-4', { organizationId: 'space-b' }),
    ]
    // Mirrors useAppCatalog's scopeForCatalogApp: a foreign-space App makes
    // the scope resolution throw (stale context) instead of resolving.
    const scopeKeyForApp = (app: CatalogApp) => {
      if (app.organizationId !== 'space-a') {
        throw new Error('stale context')
      }
      return scopeKeyForSpace('space-a', app.id)
    }
    const persisted = [
      { id: scopeKeyForSpace('space-a', 'app-1'), addedAt: 1 },
      { id: scopeKeyForSpace('space-a', 'app-3'), addedAt: 2 },
      { id: scopeKeyForSpace('space-b', 'app-4'), addedAt: 3 },
      { id: scopeKeyForSpace('space-a', 'missing'), addedAt: 4 },
      { id: 'legacy-local-app-id', addedAt: 5 },
    ]
    const resolved = resolveHomeQuickAccessApps(persisted, apps, scopeKeyForApp)
    expect(resolved.map(app => app.id)).toEqual(['app-1'])
  })

  it('never merges same-named artifacts: every scope key stays distinct', () => {
    const apps = [
      catalogApp('instance-a', { name: '_same_', creatorName: 'Circle A' }),
      catalogApp('instance-b', { name: '_same_', creatorName: 'Circle B' }),
    ]
    const scopeKeyForApp = (app: CatalogApp) =>
      scopeKeyForSpace(app.organizationId, app.id)
    const persisted = apps.map((app, index) => ({
      id: scopeKeyForApp(app),
      addedAt: index,
    }))
    const resolved = resolveHomeQuickAccessApps(persisted, apps, scopeKeyForApp)
    expect(resolved).toHaveLength(2)
    expect(new Set(resolved.map(app => app.id))).toEqual(
      new Set(['instance-a', 'instance-b']),
    )
  })
})
