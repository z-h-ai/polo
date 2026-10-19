/**
 * Datatable cell formatting semantics (iter/formatting): percent columns with
 * `semantics: 'rate' | 'share'` must render unsigned and neutral (a 6.8% loss
 * rate is not "good news"), while the default `change` keeps the historical
 * signed + green/red rendering; badge columns accept a declared
 * `badgeColors` value→color map with neutral fallback.
 */

import { describe, it, expect } from 'bun:test'
import {
  formatNeutralPercent,
  resolveBadgeChipClass,
} from '../MarkdownDatatableBlock'

const SUCCESS_CLASS = 'bg-success/10 text-success'
const ERROR_CLASS = 'bg-destructive/10 text-destructive'
const WARNING_CLASS = 'bg-info/10 text-info'
const INFO_CLASS = 'bg-accent/10 text-accent'
const NEUTRAL_CLASS = 'bg-muted text-muted-foreground'

describe('formatNeutralPercent (rate/share cell rendering)', () => {
  it('renders unsigned with the % suffix', () => {
    expect(formatNeutralPercent(0.068)).toBe('6.8%')
    expect(formatNeutralPercent(0.093)).toBe('9.3%')
    expect(formatNeutralPercent(2.5)).toBe('250%')
    expect(formatNeutralPercent(0)).toBe('0%')
  })

  it('keeps the number’s own minus sign but never adds a +', () => {
    expect(formatNeutralPercent(-0.068)).toBe('-6.8%')
    expect(formatNeutralPercent(0.068)).not.toContain('+')
  })

  it('scales precision with magnitude (small rates keep their digits)', () => {
    expect(formatNeutralPercent(0.0004)).toBe('0.04%')
    expect(formatNeutralPercent(0.15234)).toBe('15.23%')
    expect(formatNeutralPercent(1.5234)).toBe('152.34%')
  })

  it('adds thousands separators past 1000%', () => {
    expect(formatNeutralPercent(12.34567)).toBe('1,234.6%')
  })
})

describe('resolveBadgeChipClass with a declared badgeColors map', () => {
  const legal = { '高': 'error', '中': 'warning', '低': 'success' } as const

  it('maps declared values to their color chips', () => {
    expect(resolveBadgeChipClass('高', legal)).toBe(ERROR_CLASS)
    expect(resolveBadgeChipClass('中', legal)).toBe(WARNING_CLASS)
    expect(resolveBadgeChipClass('低', legal)).toBe(SUCCESS_CLASS)
  })

  it('renders unmapped values neutral, even ones the builtin map would color', () => {
    // The declared map replaces the builtin status-word guesses.
    expect(resolveBadgeChipClass('failed', legal)).toBe(NEUTRAL_CLASS)
    expect(resolveBadgeChipClass('unknown-value', legal)).toBe(NEUTRAL_CLASS)
  })

  it('matches case-insensitively', () => {
    expect(resolveBadgeChipClass('Active', { active: 'success' })).toBe(SUCCESS_CLASS)
    expect(resolveBadgeChipClass('INFO', { info: 'info' })).toBe(INFO_CLASS)
  })
})

describe('resolveBadgeChipClass without badgeColors (zero regression)', () => {
  it('keeps the builtin status-word mapping', () => {
    expect(resolveBadgeChipClass('active')).toBe(SUCCESS_CLASS)
    expect(resolveBadgeChipClass('passing')).toBe(SUCCESS_CLASS)
    expect(resolveBadgeChipClass('done')).toBe(SUCCESS_CLASS)
    expect(resolveBadgeChipClass('revoked')).toBe(ERROR_CLASS)
    expect(resolveBadgeChipClass('failed')).toBe(ERROR_CLASS)
    expect(resolveBadgeChipClass('error')).toBe(ERROR_CLASS)
    expect(resolveBadgeChipClass('Active')).toBe(SUCCESS_CLASS)
  })

  it('keeps unknown status words neutral', () => {
    expect(resolveBadgeChipClass('pending')).toBe(NEUTRAL_CLASS)
  })
})
