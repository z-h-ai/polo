/**
 * Tests for platformMode-based UI filtering logic.
 *
 * AC1: Hidden UI elements in platform mode
 * AC2: Non-platform mode — unchanged
 * AC3: Platform mode detection
 */
import { describe, expect, it } from 'bun:test'
import {
  filterSettingsItemsForPlatformMode,
  isLlmConfigHiddenInPlatformMode,
  PLATFORM_HIDDEN_SETTINGS,
} from '../platform-mode-filter'

describe('filterSettingsItemsForPlatformMode', () => {
  const allSettings = [
    { id: 'app', labelKey: 'settings.app.title', descriptionKey: 'settings.app.description' },
    { id: 'ai', labelKey: 'settings.ai.title', descriptionKey: 'settings.ai.description' },
    { id: 'appearance', labelKey: 'settings.appearance.title', descriptionKey: 'settings.appearance.description' },
    { id: 'workspace', labelKey: 'settings.workspace.title', descriptionKey: 'settings.workspace.description' },
  ]

  it('hides AI settings when platformMode=true', () => {
    const result = filterSettingsItemsForPlatformMode(allSettings, true)
    const ids = result.map(s => s.id)
    expect(ids).not.toContain('ai')
  })

  it('keeps all non-AI settings visible when platformMode=true', () => {
    const result = filterSettingsItemsForPlatformMode(allSettings, true)
    const ids = result.map(s => s.id)
    expect(ids).toContain('app')
    expect(ids).toContain('appearance')
    expect(ids).toContain('workspace')
  })

  it('shows all settings when platformMode=false', () => {
    const result = filterSettingsItemsForPlatformMode(allSettings, false)
    expect(result).toHaveLength(allSettings.length)
  })

  it('shows all settings when platformMode=false (explicitly)', () => {
    const result = filterSettingsItemsForPlatformMode(allSettings, false)
    const ids = result.map(s => s.id)
    expect(ids).toContain('ai')
  })
})

describe('isLlmConfigHiddenInPlatformMode', () => {
  it('returns true for AI settings page in platform mode', () => {
    expect(isLlmConfigHiddenInPlatformMode('ai', true)).toBe(true)
  })

  it('returns false for AI settings page when not in platform mode', () => {
    expect(isLlmConfigHiddenInPlatformMode('ai', false)).toBe(false)
  })

  it('returns false for non-AI settings pages in platform mode', () => {
    expect(isLlmConfigHiddenInPlatformMode('app', true)).toBe(false)
    expect(isLlmConfigHiddenInPlatformMode('appearance', true)).toBe(false)
    expect(isLlmConfigHiddenInPlatformMode('workspace', true)).toBe(false)
  })
})

describe('PLATFORM_HIDDEN_SETTINGS', () => {
  it('contains the ai settings page', () => {
    expect(PLATFORM_HIDDEN_SETTINGS).toContain('ai')
  })

  it('does not contain non-LLM-config pages', () => {
    expect(PLATFORM_HIDDEN_SETTINGS).not.toContain('app')
    expect(PLATFORM_HIDDEN_SETTINGS).not.toContain('appearance')
    expect(PLATFORM_HIDDEN_SETTINGS).not.toContain('workspace')
  })
})
