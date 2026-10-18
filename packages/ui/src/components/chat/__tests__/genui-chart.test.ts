/**
 * GenUiChart pure rendering logic (iter/chart): the render plan (horizontal
 * ranking variant, empty/over-limit placeholders, tolerant clipping) and the
 * token-derived slice palette. The recharts views themselves are not mounted
 * here — the plan is what decides everything they draw.
 */

import { describe, expect, it } from 'bun:test'
import {
  GENUI_CHART_HORIZONTAL_MIN_CATEGORIES,
  GENUI_CHART_MAX_SERIES,
  GENUI_CHART_TYPES,
  formatGenUiChartValue,
  genUiChartSliceColor,
  planGenUiChart,
  truncateGenUiChartTick,
} from '../GenUiChart'

function chartPayload(overrides: Record<string, unknown> = {}) {
  return {
    chartType: 'bar',
    categories: ['一月', '二月', '三月', '四月'],
    series: [{ name: '销售额', unit: '万台', values: [12, 18, 15, 22] }],
    ...overrides,
  }
}

describe('GENUI_CHART_TYPES (renderer-side mirror of the closed schema)', () => {
  it('ships exactly the four closed forms', () => {
    expect([...GENUI_CHART_TYPES]).toEqual(['bar', 'line', 'funnel', 'pie'])
  })
})

describe('planGenUiChart — horizontal ranking variant', () => {
  it('flips a single-series bar to horizontal at 4+ categories', () => {
    const plan = planGenUiChart(chartPayload({ categories: ['a', 'b', 'c', 'd'] }))
    expect(plan.kind).toBe('ok')
    if (plan.kind === 'ok') expect(plan.horizontal).toBe(true)
  })

  it('keeps a short single-series bar vertical', () => {
    const plan = planGenUiChart(chartPayload({ categories: ['a', 'b', 'c'], series: [{ name: 's', values: [1, 2, 3] }] }))
    expect(plan.kind).toBe('ok')
    if (plan.kind === 'ok') expect(plan.horizontal).toBe(false)
  })

  it('never flips a multi-series bar (grouped comparison, not a ranking)', () => {
    const plan = planGenUiChart(chartPayload({
      series: [
        { name: 's1', values: [1, 2, 3, 4] },
        { name: 's2', values: [4, 3, 2, 1] },
      ],
    }))
    expect(plan.kind).toBe('ok')
    if (plan.kind === 'ok') expect(plan.horizontal).toBe(false)
  })

  it('never flips line/funnel/pie regardless of category count', () => {
    for (const chartType of ['line', 'funnel', 'pie'] as const) {
      const plan = planGenUiChart(chartPayload({ chartType }))
      expect(plan.kind).toBe('ok')
      if (plan.kind === 'ok') expect(plan.horizontal).toBe(false)
    }
  })

  it('uses exactly the schema-backed threshold (4 categories)', () => {
    expect(GENUI_CHART_HORIZONTAL_MIN_CATEGORIES).toBe(4)
    const atThreshold = planGenUiChart(chartPayload())
    expect(atThreshold.kind).toBe('ok')
  })
})

describe('planGenUiChart — placeholders (empty data / over-limit, fallback style)', () => {
  it('placeholders on empty categories', () => {
    const plan = planGenUiChart(chartPayload({ categories: [], series: [{ name: 's', values: [] }] }))
    expect(plan).toEqual({ kind: 'placeholder', reason: 'empty' })
  })

  it('placeholders when every series is empty', () => {
    const plan = planGenUiChart(chartPayload({ series: [{ name: 's', values: [] }] }))
    expect(plan).toEqual({ kind: 'placeholder', reason: 'empty' })
  })

  it('placeholders when no value survives numeric coercion', () => {
    const plan = planGenUiChart(chartPayload({
      series: [{ name: 's', values: ['NaN-ish', null] as unknown as number[] }],
    }))
    expect(plan).toEqual({ kind: 'placeholder', reason: 'empty' })
  })

  it('placeholders above the series cap', () => {
    const four = [1, 2, 3, 4].map(n => ({ name: `s${n}`, values: [n, n, n, n] }))
    expect(GENUI_CHART_MAX_SERIES).toBe(3)
    const plan = planGenUiChart(chartPayload({ series: four }))
    expect(plan).toEqual({ kind: 'placeholder', reason: 'too-many-series' })
  })

  it('placeholders on an unknown chartType instead of crashing', () => {
    const plan = planGenUiChart(chartPayload({ chartType: 'scatter' }))
    expect(plan).toEqual({ kind: 'placeholder', reason: 'unknown-chart-type' })
  })
})

describe('planGenUiChart — tolerant clipping and row shape', () => {
  it('clips every series to the shortest of categories/values (schema-violating replays degrade, not crash)', () => {
    const plan = planGenUiChart(chartPayload({
      series: [
        { name: 'full', values: [1, 2, 3, 4, 5] },
        { name: 'short', values: [9, 8] },
      ],
    }))
    expect(plan.kind).toBe('ok')
    if (plan.kind === 'ok') {
      expect(plan.rows.length).toBe(2)
      expect(plan.rows[0]).toEqual({ __category: '一月', full: 1, short: 9 })
      expect(plan.series[0]!.values.length).toBe(2)
    }
  })

  it('namespaces the category key so a series named "category" cannot collide', () => {
    const plan = planGenUiChart(chartPayload({
      series: [{ name: 'category', values: [1, 2, 3, 4] }],
    }))
    expect(plan.kind).toBe('ok')
    if (plan.kind === 'ok') {
      expect(plan.rows[0]).toEqual({ __category: '一月', category: 1 })
    }
  })

  it('drops non-finite values from rows but keeps the plottable rest', () => {
    const plan = planGenUiChart(chartPayload({
      series: [{ name: 's', values: [1, Number.NaN, 3, 4] }],
    }))
    expect(plan.kind).toBe('ok')
    if (plan.kind === 'ok') {
      expect(plan.rows[0]).toEqual({ __category: '一月', s: 1 })
      expect(plan.rows[1]).toEqual({ __category: '二月' })
      expect(plan.rows[2]).toEqual({ __category: '三月', s: 3 })
    }
  })
})

describe('genUiChartSliceColor (token-derived categorical palette)', () => {
  it('hands out raw theme tokens for the first cycle', () => {
    expect(genUiChartSliceColor(0)).toBe('var(--accent)')
    expect(genUiChartSliceColor(1)).toBe('var(--info)')
    expect(genUiChartSliceColor(2)).toBe('var(--success)')
    expect(genUiChartSliceColor(3)).toBe('var(--destructive)')
  })

  it('mixes repeats toward the background so later cycles stay distinguishable', () => {
    const repeated = genUiChartSliceColor(4)
    expect(repeated).not.toBe('var(--accent)')
    expect(repeated).toContain('color-mix(in oklab, var(--accent)')
    // Deterministic, and never an exact repeat within a base cycle.
    expect(genUiChartSliceColor(4)).toBe(repeated)
    expect(genUiChartSliceColor(5)).not.toBe(repeated)
  })
})

describe('formatGenUiChartValue and truncateGenUiChartTick', () => {
  it('formats thousands separators and appends the unit', () => {
    expect(formatGenUiChartValue(1234.5)).toBe('1,234.5')
    expect(formatGenUiChartValue(1234.5, '万台')).toBe('1,234.5 万台')
    expect(formatGenUiChartValue(0)).toBe('0')
  })

  it('keeps malformed values visible instead of blanking them', () => {
    expect(formatGenUiChartValue(Number.NaN)).toBe('NaN')
    expect(formatGenUiChartValue(undefined)).toBe('')
  })

  it('truncates long category labels and keeps short ones verbatim', () => {
    expect(truncateGenUiChartTick('一季度')).toBe('一季度')
    expect(truncateGenUiChartTick('x'.repeat(60))).toBe(`${'x'.repeat(13)}…`)
    expect(truncateGenUiChartTick(null)).toBe('')
  })
})
