import { describe, it, expect } from 'bun:test'
import {
  parseGenUiComponents,
  mergeGenUiComponents,
  hasGenUiRenderer,
} from '../GenUICard'

describe('parseGenUiComponents', () => {
  it('accepts the { components: [...] } tool-input shape', () => {
    const parsed = parseGenUiComponents({
      components: [
        { type: 'stat-card', id: 's1', label: 'Revenue', value: 42 },
        { type: 'alert', id: 'a1', severity: 'info', message: 'hi' },
      ],
    })
    expect(parsed.length).toBe(2)
    expect(parsed[0]!.type).toBe('stat-card')
    expect(parsed[1]!.type).toBe('alert')
  })

  it('accepts a bare component array', () => {
    const parsed = parseGenUiComponents([
      { type: 'progress', id: 'p1', status: 'running', label: 'Working' },
    ])
    expect(parsed.length).toBe(1)
    expect(parsed[0]!.id).toBe('p1')
  })

  it('drops entries with unknown types instead of throwing', () => {
    const parsed = parseGenUiComponents({
      components: [
        { type: 'chart', id: 'c1' },
        { type: 'stat-card', id: 's1', label: 'Keep', value: 1 },
      ],
    })
    expect(parsed.length).toBe(1)
    expect(parsed[0]!.id).toBe('s1')
  })

  it('drops entries without a usable id', () => {
    const parsed = parseGenUiComponents({
      components: [
        { type: 'alert', severity: 'info', message: 'no id' },
        { type: 'alert', id: '', severity: 'info', message: 'empty id' },
        { type: 'alert', id: 'ok', severity: 'info', message: 'fine' },
      ],
    })
    expect(parsed.length).toBe(1)
    expect(parsed[0]!.id).toBe('ok')
  })

  it('returns empty for garbage input', () => {
    expect(parseGenUiComponents(undefined)).toEqual([])
    expect(parseGenUiComponents(null)).toEqual([])
    expect(parseGenUiComponents('nope')).toEqual([])
    expect(parseGenUiComponents({ components: 'not-an-array' })).toEqual([])
    expect(parseGenUiComponents({ components: [null, 42, 'x'] })).toEqual([])
  })
})

describe('mergeGenUiComponents', () => {
  it('keeps first-seen order across calls', () => {
    const merged = mergeGenUiComponents([
      [
        { type: 'stat-card', id: 'b', label: 'B', value: 1 },
        { type: 'stat-card', id: 'a', label: 'A', value: 2 },
      ],
      [{ type: 'alert', id: 'c', severity: 'info', message: 'C' }],
    ])
    expect(merged.map(c => c.id)).toEqual(['b', 'a', 'c'])
  })

  it('overrides same-id components in place (update semantics)', () => {
    const merged = mergeGenUiComponents([
      [
        { type: 'stat-card', id: 's1', label: 'Old label', value: 1 },
        { type: 'alert', id: 'a1', severity: 'info', message: 'kept' },
      ],
      [{ type: 'stat-card', id: 's1', label: 'New label', value: 2 }],
    ])
    expect(merged.length).toBe(2)
    expect(merged[0]!.id).toBe('s1')
    const stat = merged[0] as { label: string; value: number }
    expect(stat.label).toBe('New label')
    expect(stat.value).toBe(2)
    expect(merged[1]!.id).toBe('a1')
  })

  it('skips empty groups', () => {
    const merged = mergeGenUiComponents([
      [],
      [{ type: 'progress', id: 'p1', status: 'success', label: 'Done' }],
      [],
    ])
    expect(merged.length).toBe(1)
    expect(merged[0]!.id).toBe('p1')
  })
})

describe('hasGenUiRenderer (fallback decision)', () => {
  it('registers all five P0 component types', () => {
    expect(hasGenUiRenderer('stat-card')).toBe(true)
    expect(hasGenUiRenderer('data-table')).toBe(true)
    expect(hasGenUiRenderer('alert')).toBe(true)
    expect(hasGenUiRenderer('progress')).toBe(true)
    expect(hasGenUiRenderer('action-buttons')).toBe(true)
  })

  it('falls back to the read-only JSON view for unknown types', () => {
    expect(hasGenUiRenderer('chart')).toBe(false)
    expect(hasGenUiRenderer('')).toBe(false)
  })
})
