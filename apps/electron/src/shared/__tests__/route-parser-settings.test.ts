import { describe, expect, it } from 'bun:test'
import { parseCompoundRoute, parseRouteToNavigationState } from '../route-parser'

describe('route-parser: settings routes', () => {
  it('falls back removed settings subpages to app settings', () => {
    expect(parseCompoundRoute('settings/ai')).toEqual({
      navigator: 'settings',
      details: { type: 'app', id: 'app' },
    })

    expect(parseRouteToNavigationState('settings/ai')).toEqual({
      navigator: 'settings',
      subpage: 'app',
    })
  })
})
