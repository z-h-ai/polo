import { describe, expect, it } from 'bun:test'
import {
  ASSISTANT_SETTINGS_DEFAULT_SUBPAGE,
  DEFAULT_SETTINGS_SUBPAGE,
  SETTINGS_PAGES,
  getSettingsPageScope,
  isValidSettingsSubpage,
  type SettingsScope,
  type SettingsSubpage,
} from '../settings-registry'
import { SETTINGS_ITEMS, getVisibleSettingsItems, getSettingsItemsForScope } from '../menu-schema'
import { parseCompoundRoute, parseRouteToNavigationState } from '../route-parser'

/** Registry order restricted to one scope — what each navigator renders. */
function scopeIds(scope: SettingsScope): SettingsSubpage[] {
  return SETTINGS_PAGES.filter(page => page.scope === scope).map(page => page.id)
}

describe('settings-registry: scope split (POO-103)', () => {
  it('assigns every page to exactly one scope with no orphans', () => {
    const ids = SETTINGS_PAGES.map(page => page.id)
    expect(new Set(ids).size).toBe(ids.length)
    // Every page carries an explicit scope; the union covers the registry.
    const scopedIds = [...scopeIds('assistant'), ...scopeIds('polo')]
    expect(scopedIds.sort()).toEqual([...ids].sort())
  })

  it('lists the 7 assistant categories in registry order', () => {
    expect(scopeIds('assistant')).toEqual([
      'input', 'tools', 'workspace', 'permissions', 'labels', 'messaging', 'preferences',
    ])
  })

  it('lists the Polo categories in registry order (server stays flag-gated)', () => {
    expect(scopeIds('polo')).toEqual([
      'app', 'account-security', 'appearance', 'shortcuts', 'server',
    ])
  })

  it('derives scope from the subpage alone', () => {
    expect(getSettingsPageScope('tools')).toBe('assistant')
    expect(getSettingsPageScope('preferences')).toBe('assistant')
    expect(getSettingsPageScope('app')).toBe('polo')
    expect(getSettingsPageScope('shortcuts')).toBe('polo')
  })

  it('keeps the bare-settings default aligned with the content panel fallback (app → Polo)', () => {
    expect(DEFAULT_SETTINGS_SUBPAGE).toBe('app')
    expect(getSettingsPageScope(DEFAULT_SETTINGS_SUBPAGE)).toBe('polo')
    // Sidebar assistant entry lands on the first assistant category.
    expect(getSettingsPageScope(ASSISTANT_SETTINGS_DEFAULT_SUBPAGE)).toBe('assistant')
  })
})

describe('menu-schema: scope selectors', () => {
  it('returns each scope once the admin gate is satisfied', () => {
    const assistant = getSettingsItemsForScope('assistant', true).map(item => item.id)
    const polo = getSettingsItemsForScope('polo', true).map(item => item.id)

    expect(assistant).toEqual([
      'input', 'tools', 'workspace', 'permissions', 'labels', 'messaging', 'preferences',
    ])
    // account-security requires the admin gate; server is absent unless the
    // embedded-server feature flag was on at module load.
    expect(polo).toContain('app')
    expect(polo).toContain('appearance')
    expect(polo).toContain('shortcuts')
    expect(assistant).not.toContain('account-security')
    expect(polo).not.toContain('input')
    expect(polo).not.toContain('tools')
  })

  it('hides account-security from the Polo scope when logged out', () => {
    const polo = getSettingsItemsForScope('polo', false).map(item => item.id)
    expect(polo).not.toContain('account-security')
    // The rest of the scope stays visible.
    expect(polo).toContain('app')
    expect(getSettingsItemsForScope('assistant', false)).toHaveLength(7)
  })

  it('keeps the full-list selector consistent with the scope selectors', () => {
    const visible = getVisibleSettingsItems(true).map(item => item.id)
    const byScopes = [
      ...getSettingsItemsForScope('polo', true),
      ...getSettingsItemsForScope('assistant', true),
    ].map(item => item.id)
    expect(byScopes.sort()).toEqual([...visible].sort())
    // The new tools page is reachable through the registry-derived union.
    expect(SETTINGS_ITEMS.some(item => item.id === 'tools')).toBe(true)
  })
})

describe('route-parser: tools subpage compatibility', () => {
  it('parses the new tools subpage like any other settings page', () => {
    expect(parseCompoundRoute('settings/tools')).toEqual({
      navigator: 'settings',
      details: { type: 'tools', id: 'tools' },
    })
    expect(parseRouteToNavigationState('settings/tools')).toEqual({
      navigator: 'settings',
      subpage: 'tools',
    })
  })

  it('keeps legacy flat routes and unknown subpages untouched', () => {
    expect(isValidSettingsSubpage('tools')).toBe(true)
    expect(parseRouteToNavigationState('settings/ai')).toEqual({
      navigator: 'settings',
      subpage: 'app',
    })
    expect(parseCompoundRoute('settings')).toEqual({
      navigator: 'settings',
      details: null,
    })
  })
})
