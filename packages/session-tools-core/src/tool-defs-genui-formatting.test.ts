/**
 * render_ui number-formatting and semantics fields (iter/formatting):
 * percent column `semantics`, badge column `badgeColors`, stat-card
 * `format`/`currency`/`goodWhen`. All new fields are optional with defaults —
 * the legacy payloads below must keep parsing unchanged.
 */

import { describe, expect, it } from 'bun:test'
import { getToolDefsAsJsonSchema, RenderUiSchema } from './tool-defs.ts'

function statCard(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'stat-card', id: 's1', label: 'Gross margin', value: 0.093, ...overrides }
}

function dataTable(overrides: Record<string, unknown> = {}, columnOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'data-table',
    id: 't1',
    src: 'data/rows.json',
    columns: [{ key: 'loss_rate', label: '损耗率', type: 'percent', ...columnOverrides }],
    ...overrides,
  }
}

describe('stat-card formatting fields', () => {
  it('legacy payload without the new fields still parses (zero regression)', () => {
    const parsed = RenderUiSchema.safeParse({ components: [statCard({ value: 42, delta: 0.152, trend: 'up' })] })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const stat = parsed.data.components[0]!
      if (stat.type === 'stat-card') {
        expect(stat.format).toBeUndefined()
        expect(stat.currency).toBeUndefined()
        // Declared default: the historical up-is-good coloring.
        expect(stat.goodWhen).toBe('up')
      } else {
        throw new Error('expected a stat-card')
      }
    }
  })

  it('accepts format/currency and applies the goodWhen default', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [statCard({ value: 0.093, format: 'percent' })],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const stat = parsed.data.components[0]!
      if (stat.type === 'stat-card') {
        expect(stat.format).toBe('percent')
        expect(stat.goodWhen).toBe('up')
      }
    }
  })

  it('accepts goodWhen down and neutral (inverted / muted delta color)', () => {
    for (const goodWhen of ['down', 'neutral'] as const) {
      const parsed = RenderUiSchema.safeParse({
        components: [statCard({ delta: 0.45, trend: 'up', goodWhen })],
      })
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        const stat = parsed.data.components[0]!
        if (stat.type === 'stat-card') expect(stat.goodWhen).toBe(goodWhen)
      }
    }
  })

  it('accepts an 8-char currency prefix and rejects a longer one', () => {
    expect(RenderUiSchema.safeParse({ components: [statCard({ format: 'currency', currency: 'USDT' })] }).success).toBe(true)
    expect(RenderUiSchema.safeParse({ components: [statCard({ format: 'currency', currency: '123456789' })] }).success).toBe(false)
  })

  it('rejects unknown enum values for format and goodWhen', () => {
    expect(RenderUiSchema.safeParse({ components: [statCard({ format: 'bananas' })] }).success).toBe(false)
    expect(RenderUiSchema.safeParse({ components: [statCard({ goodWhen: 'sideways' })] }).success).toBe(false)
  })
})

describe('data-table percent semantics and badgeColors', () => {
  it('legacy percent column without semantics still parses and defaults to change (zero regression)', () => {
    const parsed = RenderUiSchema.safeParse({ components: [dataTable()] })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const table = parsed.data.components[0]!
      if (table.type === 'data-table') {
        expect(table.columns[0]!.semantics).toBe('change')
        expect(table.columns[0]!.badgeColors).toBeUndefined()
      }
    }
  })

  it('accepts rate and share semantics on a percent column', () => {
    for (const semantics of ['rate', 'share'] as const) {
      const parsed = RenderUiSchema.safeParse({ components: [dataTable({}, { semantics })] })
      expect(parsed.success).toBe(true)
      if (parsed.success) {
        const table = parsed.data.components[0]!
        if (table.type === 'data-table') expect(table.columns[0]!.semantics).toBe(semantics)
      }
    }
  })

  it('rejects an unknown semantics value', () => {
    expect(RenderUiSchema.safeParse({ components: [dataTable({}, { semantics: 'vibe' })] }).success).toBe(false)
  })

  it('accepts a badgeColors value→color map on a badge column', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [dataTable({ id: 't2' }, {
        key: 'risk', type: 'badge',
        badgeColors: { '高': 'error', '中': 'warning', '低': 'success', 'pending': 'info' },
      })],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const table = parsed.data.components[0]!
      if (table.type === 'data-table') {
        expect(table.columns[0]!.badgeColors).toEqual({ '高': 'error', '中': 'warning', '低': 'success', 'pending': 'info' })
      }
    }
  })

  it('rejects a badgeColors map with an unknown color', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [dataTable({}, { type: 'badge', badgeColors: { '高': 'crimson' } })],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('render_ui tool description documents the semantics fields', () => {
  it('carries the value-semantics guidance to the model-facing description', () => {
    const def = getToolDefsAsJsonSchema({ allowRenderUi: true }).find(d => d.name === 'render_ui')!
    const description = def.description
    for (const needle of ['"semantics"', '"format"', '"goodWhen"', '"badgeColors"']) {
      expect(description).toContain(needle)
    }
  })
})
