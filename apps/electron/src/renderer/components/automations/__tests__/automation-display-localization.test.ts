import { describe, it, expect, beforeAll } from 'bun:test'
import {
  getEventDisplayName,
  getPermissionDisplayName,
  flattenConditions,
  type AutomationConditionUI,
  type AutomationTrigger,
} from '../types'
import { setupI18n, i18n } from '@polo-ai/shared/i18n'

// The automation display helpers resolve at call time, so they are asserted
// against two live locales. The stored event/permission/condition values are
// protocol data and must survive verbatim.
beforeAll(() => {
  setupI18n().changeLanguage('en')
})

describe('getEventDisplayName', () => {
  it('localizes known events and keeps unknown raw values as-is', () => {
    i18n.changeLanguage('en')
    expect(getEventDisplayName('LabelAdd' as AutomationTrigger)).toBe('Label Added')
    expect(getEventDisplayName('PreToolUse' as AutomationTrigger)).toBe('Before Tool Runs')

    // Unknown trigger falls through to the raw value (protocol data).
    expect(getEventDisplayName('BrandNewEvent' as AutomationTrigger)).toBe('BrandNewEvent')
  })

  it('re-resolves after a language switch without remounting anything', () => {
    i18n.changeLanguage('en')
    i18n.changeLanguage('zh-Hans')
    expect(getEventDisplayName('LabelAdd' as AutomationTrigger)).toBe('标签已添加')
    expect(getEventDisplayName('SchedulerTick' as AutomationTrigger)).toBe('已调度')
    i18n.changeLanguage('en')
    expect(getEventDisplayName('LabelAdd' as AutomationTrigger)).toBe('Label Added')
  })
})

describe('getPermissionDisplayName', () => {
  it('maps stored mode values to localized labels and never rewrites them', () => {
    i18n.changeLanguage('en')
    expect(getPermissionDisplayName('safe')).toBe('Explore')
    expect(getPermissionDisplayName('ask')).toBe('Ask')
    expect(getPermissionDisplayName('allow-all')).toBe('Execute')
    expect(getPermissionDisplayName(undefined)).toBe('Explore')

    i18n.changeLanguage('zh-Hans')
    expect(getPermissionDisplayName('safe')).toBe('计划模式')
    expect(getPermissionDisplayName('allow-all')).toBe('完全访问')
    i18n.changeLanguage('en')
  })
})

describe('flattenConditions', () => {
  it('localizes templates while raw field/timezone/weekday values stay verbatim', () => {
    i18n.changeLanguage('en')
    const conditions: AutomationConditionUI[] = [
      {
        condition: 'state',
        field: 'permissionMode',
        from: 'safe',
        to: 'allow-all',
      },
      {
        condition: 'time',
        weekday: ['mon', 'fri'],
        after: '09:00',
        timezone: 'Asia/Shanghai',
      },
    ]
    const rows = flattenConditions(conditions)

    expect(rows[0]!.label).toBe('State')
    expect(rows[0]!.description).toBe('permission mode changed from safe to allow-all')
    expect(rows[1]!.label).toBe('Time')
    expect(rows[1]!.description).toBe('mon, fri after 09:00 (Asia/Shanghai)')

    i18n.changeLanguage('zh-Hans')
    const zh = flattenConditions(conditions)
    expect(zh[0]!.label).toBe('状态')
    expect(zh[0]!.description).toBe('权限模式 从 safe 变为 allow-all')
    // weekday enums, timezone and stored mode values stay untouched
    expect(zh[1]!.description).toContain('mon, fri')
    expect(zh[1]!.description).toContain('(Asia/Shanghai)')
    i18n.changeLanguage('en')
  })

  it('localizes flagged and membership leaves in both directions', () => {
    i18n.changeLanguage('en')
    const flagged: AutomationConditionUI = { condition: 'state', field: 'isFlagged', value: true }
    const labels: AutomationConditionUI = { condition: 'state', field: 'labels', contains: 'urgent' }
    const logical: AutomationConditionUI = { condition: 'and', conditions: [flagged, labels] }

    const rows = flattenConditions([flagged, labels, logical])
    expect(rows[0]!.description).toBe('is flagged')
    expect(rows[1]!.description).toBe('has label "urgent"')
    expect(rows[2]!.description).toBe('is flagged and has label "urgent"')

    i18n.changeLanguage('zh-Hans')
    const zh = flattenConditions([flagged, logical])
    expect(zh[0]!.description).toBe('已设旗标')
    expect(zh[1]!.description).toBe('已设旗标 且 含有标签「urgent」')
    i18n.changeLanguage('en')
  })
})
