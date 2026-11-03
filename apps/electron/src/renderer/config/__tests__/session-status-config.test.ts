import { describe, it, expect, afterEach } from 'bun:test'
import {
  getStateLabel,
  getStatusLabel,
  getStateIconStyle,
  getStatusIconStyle,
  type SessionStatus,
} from '../session-status-config'

function makeStatus(overrides: Partial<SessionStatus>): SessionStatus {
  return {
    id: 'todo',
    label: 'Todo',
    resolvedColor: 'var(--foreground)',
    icon: '●',
    iconColorable: true,
    ...overrides,
  }
}

describe('session-status-config icon style helpers', () => {
  it('getStatusIconStyle returns color style for colorable icons', () => {
    const status = makeStatus({ iconColorable: true, resolvedColor: 'var(--accent)' })

    expect(getStatusIconStyle(status)).toEqual({ color: 'var(--accent)' })
  })

  it('getStatusIconStyle returns undefined for non-colorable icons (emoji/images)', () => {
    const status = makeStatus({ icon: '✅', iconColorable: false, resolvedColor: 'var(--foreground)' })

    expect(getStatusIconStyle(status)).toBeUndefined()
  })

  it('getStateIconStyle resolves by id and applies same colorability rule', () => {
    const states: SessionStatus[] = [
      makeStatus({ id: 'todo', icon: '✅', iconColorable: false, resolvedColor: 'var(--foreground)' }),
      makeStatus({ id: 'in-progress', iconColorable: true, resolvedColor: 'var(--success)' }),
    ]

    expect(getStateIconStyle('todo', states)).toBeUndefined()
    expect(getStateIconStyle('in-progress', states)).toEqual({ color: 'var(--success)' })
    expect(getStateIconStyle('missing', states)).toBeUndefined()
  })
})

// Compare the presentation mapping to the authoritative stored defaults.
import { getDefaultStatusConfig } from '@polo-ai/shared/statuses/storage'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
setupI18n()
afterEach(async () => { await i18n.changeLanguage('en') })

describe('status display labels', () => {
  it('localizes all stored defaults at call time without mutating them', async () => {
    const states = getDefaultStatusConfig().statuses.map(s => makeStatus(s))
    const original = JSON.stringify(states)
    await i18n.changeLanguage('zh-Hans')
    expect(states.map(s => getStatusLabel(s))).toEqual(['积压', '待办', '待审查', '完成', '已取消'])
    expect(getStateLabel('cancelled', states)).toBe('已取消')
    await i18n.changeLanguage('en')
    expect(states.map(s => getStatusLabel(s))).toEqual(states.map(s => s.label))
    expect(JSON.stringify(states)).toBe(original)
  })

  it('preserves renamed, custom, same-ID custom and unknown states', async () => {
    await i18n.changeLanguage('zh-Hans')
    for (const state of [
      makeStatus({ id: 'needs-review', label: '财务复核', isDefault: true }),
      makeStatus({ id: 'todo', label: 'Todo', isFixed: false, isDefault: false }),
      makeStatus({ id: 'in-progress', label: 'In Progress', isDefault: true }),
      makeStatus({ id: 'customer-follow-up', label: 'Customer follow-up' }),
      makeStatus({ id: 'unknown', label: 'Legacy state', isDefault: true }),
    ]) expect(getStatusLabel(state)).toBe(state.label)
    expect(getStateLabel('unknown-id', [])).toBe('unknown-id')
    expect(getStatusLabel(makeStatus({ id: 'unknown', label: '' }))).toBe('unknown')
  })
})
