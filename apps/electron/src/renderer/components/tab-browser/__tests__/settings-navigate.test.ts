import { describe, expect, it } from 'bun:test'
import { getGlobalSettingsSubpageFromRoute, shouldSurfaceAssistantForNavigate } from '../settings-navigate'
import { routes } from '../../../../shared/routes'
import { SETTINGS_PAGES } from '../../../../shared/settings-registry'

const POLO_SCOPE_PAGES = SETTINGS_PAGES.filter((page) => page.scope === 'polo')
const ASSISTANT_SCOPE_PAGES = SETTINGS_PAGES.filter((page) => page.scope === 'assistant')

describe('TabShell settings navigate gate (POO-103 / POO-125)', () => {
  it('resolves every Polo-scope settings subpage to the global surface', () => {
    for (const page of POLO_SCOPE_PAGES) {
      expect(getGlobalSettingsSubpageFromRoute(routes.view.settings(page.id))).toBe(page.id)
    }
  })

  it('never surfaces the assistant tab for a Polo-scope settings route', () => {
    for (const page of POLO_SCOPE_PAGES) {
      expect(shouldSurfaceAssistantForNavigate(routes.view.settings(page.id))).toBe(false)
    }
  })

  it('keeps assistant-scope settings routes on the assistant tab', () => {
    for (const page of ASSISTANT_SCOPE_PAGES) {
      expect(shouldSurfaceAssistantForNavigate(routes.view.settings(page.id))).toBe(true)
      expect(getGlobalSettingsSubpageFromRoute(routes.view.settings(page.id))).toBeNull()
    }
  })

  it('lands the bare settings route (legacy deep link) on the global surface default', () => {
    expect(getGlobalSettingsSubpageFromRoute(routes.view.settings())).toBe('app')
    expect(shouldSurfaceAssistantForNavigate(routes.view.settings())).toBe(false)
  })

  it('lands an unknown settings subpage on the global surface default (route-parser fallback)', () => {
    expect(getGlobalSettingsSubpageFromRoute('settings/does-not-exist')).toBe('app')
    expect(shouldSurfaceAssistantForNavigate('settings/does-not-exist')).toBe(false)
  })

  it('leaves non-settings routes to their existing tab behaviour', () => {
    expect(shouldSurfaceAssistantForNavigate(routes.view.allSessions())).toBe(false)
    expect(shouldSurfaceAssistantForNavigate(routes.view.allSessions('sess-1'))).toBe(false)
    expect(shouldSurfaceAssistantForNavigate(routes.view.sources())).toBe(false)
    expect(getGlobalSettingsSubpageFromRoute(routes.view.allSessions())).toBeNull()
  })

  it('surfaces the assistant tab for the new-session action (POO-117 P117-04)', () => {
    // Avatar menu, Cmd+N and the native-menu broadcast all dispatch this route
    // from above NavigationProvider. Without surfacing, the session is created
    // inside the hidden Polo tab and the user sees no visible change.
    expect(shouldSurfaceAssistantForNavigate(routes.action.newSession())).toBe(true)
    expect(shouldSurfaceAssistantForNavigate('action/new-session?input=hi&send=true')).toBe(true)
  })

  it('does not surface for other action routes', () => {
    expect(shouldSurfaceAssistantForNavigate(routes.action.copyToClipboard('x'))).toBe(false)
    expect(shouldSurfaceAssistantForNavigate('action/oauth/github')).toBe(false)
  })

  it('ignores malformed navigate payloads', () => {
    expect(shouldSurfaceAssistantForNavigate(undefined)).toBe(false)
    expect(shouldSurfaceAssistantForNavigate(null)).toBe(false)
    expect(shouldSurfaceAssistantForNavigate({ route: 'settings/app' })).toBe(false)
    expect(shouldSurfaceAssistantForNavigate('')).toBe(false)
    expect(getGlobalSettingsSubpageFromRoute(undefined)).toBeNull()
    expect(getGlobalSettingsSubpageFromRoute({ route: 'settings/app' })).toBeNull()
    expect(getGlobalSettingsSubpageFromRoute('')).toBeNull()
  })
})
