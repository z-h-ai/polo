import { describe, expect, it } from 'bun:test'
import { shouldSurfaceAssistantForNavigate } from '../settings-navigate'
import { routes } from '../../../../shared/routes'
import { SETTINGS_PAGES } from '../../../../shared/settings-registry'

describe('TabShell settings navigate gate (POO-103)', () => {
  it('surfaces the assistant tab for every settings subpage of both scopes', () => {
    for (const page of SETTINGS_PAGES) {
      expect(shouldSurfaceAssistantForNavigate(routes.view.settings(page.id))).toBe(true)
    }
  })

  it('surfaces the assistant tab for the bare settings route (legacy deep link)', () => {
    expect(shouldSurfaceAssistantForNavigate(routes.view.settings())).toBe(true)
  })

  it('surfaces the assistant tab for an unknown settings subpage (route-parser falls back to app)', () => {
    expect(shouldSurfaceAssistantForNavigate('settings/does-not-exist')).toBe(true)
  })

  it('leaves non-settings routes to their existing tab behaviour', () => {
    expect(shouldSurfaceAssistantForNavigate(routes.view.allSessions())).toBe(false)
    expect(shouldSurfaceAssistantForNavigate(routes.view.allSessions('sess-1'))).toBe(false)
    expect(shouldSurfaceAssistantForNavigate(routes.view.sources())).toBe(false)
    expect(shouldSurfaceAssistantForNavigate(routes.action.newSession())).toBe(false)
  })

  it('ignores malformed navigate payloads', () => {
    expect(shouldSurfaceAssistantForNavigate(undefined)).toBe(false)
    expect(shouldSurfaceAssistantForNavigate(null)).toBe(false)
    expect(shouldSurfaceAssistantForNavigate({ route: 'settings/app' })).toBe(false)
    expect(shouldSurfaceAssistantForNavigate('')).toBe(false)
  })
})
