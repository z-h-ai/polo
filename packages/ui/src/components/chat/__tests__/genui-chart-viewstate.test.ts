/**
 * GenUiChart client-side view-state interactions (P0-1b): series legend
 * toggle and x-axis range filter. Same doctrine as the plan tests — the
 * exported interaction helpers decide everything the interactive layer does,
 * so the pure functions are what get tested: visibility computation, range
 * resolution/clamping, and the fact that none of this mutates the plan or
 * the payload (view state is ephemeral; nothing round-trips to the model).
 */

import { describe, expect, it } from 'bun:test'
import {
  GENUI_CHART_RANGE_MIN_CATEGORIES,
  genUiChartRangeFilterEnabled,
  resolveGenUiChartRange,
  toggleGenUiChartSeriesHidden,
  visibleGenUiChartSeries,
  planGenUiChart,
} from '../GenUiChart'

const SERIES = [
  { name: '销售额', unit: '万台', values: [12, 18, 15, 22] },
  { name: '利润', values: [3, 5, 4, 7] },
  { name: '成本', values: [9, 13, 11, 15] },
]

describe('genUiChartRangeFilterEnabled (brush earns its space only on long axes)', () => {
  it('is off below the threshold and on from it', () => {
    expect(GENUI_CHART_RANGE_MIN_CATEGORIES).toBe(8)
    expect(genUiChartRangeFilterEnabled(GENUI_CHART_RANGE_MIN_CATEGORIES - 1)).toBe(false)
    expect(genUiChartRangeFilterEnabled(GENUI_CHART_RANGE_MIN_CATEGORIES)).toBe(true)
  })

  it('degenerates safely on empty and negative row counts', () => {
    expect(genUiChartRangeFilterEnabled(0)).toBe(false)
    expect(genUiChartRangeFilterEnabled(-3)).toBe(false)
  })
})

describe('resolveGenUiChartRange (garbage in, no filter — never a bad window)', () => {
  const rowCount = 12

  it('passes a real narrowed window through (clamped to bounds)', () => {
    expect(resolveGenUiChartRange({ startIndex: 2, endIndex: 5 }, rowCount)).toEqual({ startIndex: 2, endIndex: 5 })
    expect(resolveGenUiChartRange({ startIndex: -4, endIndex: 8 }, rowCount)).toEqual({ startIndex: 0, endIndex: 8 })
    expect(resolveGenUiChartRange({ startIndex: 10, endIndex: 10 }, rowCount)).toEqual({ startIndex: 10, endIndex: 10 })
  })

  it('a window clamped to the full range counts as no filter', () => {
    expect(resolveGenUiChartRange({ startIndex: -4, endIndex: 99 }, rowCount)).toBeNull()
  })

  it('returns null for a full-width window (no active filter, status hidden)', () => {
    expect(resolveGenUiChartRange({ startIndex: 0, endIndex: rowCount - 1 }, rowCount)).toBeNull()
  })

  it('returns null on missing/garbage input instead of inventing a window', () => {
    expect(resolveGenUiChartRange(null, rowCount)).toBeNull()
    expect(resolveGenUiChartRange(undefined, rowCount)).toBeNull()
    expect(resolveGenUiChartRange({ startIndex: Number.NaN, endIndex: 5 }, rowCount)).toBeNull()
    expect(resolveGenUiChartRange({ startIndex: 0, endIndex: Number.POSITIVE_INFINITY }, rowCount)).toBeNull()
  })

  it('floors fractional indices from pointer math', () => {
    expect(resolveGenUiChartRange({ startIndex: 1.8, endIndex: 4.2 }, rowCount)).toEqual({ startIndex: 1, endIndex: 4 })
  })

  it('collapses a reversed window onto the start index', () => {
    expect(resolveGenUiChartRange({ startIndex: 5, endIndex: 2 }, rowCount)).toEqual({ startIndex: 5, endIndex: 5 })
  })

  it('returns null for an empty plot (nothing to narrow)', () => {
    expect(resolveGenUiChartRange({ startIndex: 0, endIndex: 0 }, 0)).toBeNull()
  })

  it('degrades against shrunken data: a stale window clamps or vanishes, never crashes', () => {
    // Card updated in place with fewer categories while a brush window was set.
    expect(resolveGenUiChartRange({ startIndex: 6, endIndex: 9 }, 4)).toEqual({ startIndex: 3, endIndex: 3 })
    expect(resolveGenUiChartRange({ startIndex: 0, endIndex: 99 }, 4)).toBeNull()
  })
})

describe('toggleGenUiChartSeriesHidden (legend chip click)', () => {
  it('adds a hidden name, then removes it on the second click', () => {
    let hidden = toggleGenUiChartSeriesHidden(new Set<string>(), '利润')
    expect([...hidden]).toEqual(['利润'])
    hidden = toggleGenUiChartSeriesHidden(hidden, '利润')
    expect(hidden.size).toBe(0)
  })

  it('is pure: the input set is never mutated (ephemeral state swaps by reference)', () => {
    const hidden = new Set(['销售额'])
    const next = toggleGenUiChartSeriesHidden(hidden, '利润')
    expect([...hidden]).toEqual(['销售额'])
    expect([...next]).toEqual(['销售额', '利润'])
    expect(next).not.toBe(hidden)
  })

  it('toggling an unknown name is still a well-formed set (stale names stay inert)', () => {
    const hidden = toggleGenUiChartSeriesHidden(new Set<string>(), '不存在的系列')
    expect([...hidden]).toEqual(['不存在的系列'])
  })
})

describe('visibleGenUiChartSeries (what the chips, plot elements, and tooltip render)', () => {
  it('keeps only series whose name is not hidden, in declaration order', () => {
    const visible = visibleGenUiChartSeries(SERIES, new Set(['利润']))
    expect(visible.map(s => s.name)).toEqual(['销售额', '成本'])
  })

  it('keeps everything when nothing is hidden — including an empty hidden set', () => {
    expect(visibleGenUiChartSeries(SERIES, new Set())).toHaveLength(3)
    expect(visibleGenUiChartSeries(SERIES, new Set(['没有这个系列']))).toHaveLength(3)
  })

  it('can hide every series (axes stay, plot empties until the user restores one)', () => {
    const allHidden = SERIES.reduce((acc, s) => toggleGenUiChartSeriesHidden(acc, s.name), new Set<string>() as ReadonlySet<string>)
    expect(visibleGenUiChartSeries(SERIES, allHidden)).toHaveLength(0)
  })

  it('returns a new array and leaves the plan untouched (view-only filter)', () => {
    const plan = planGenUiChart({ chartType: 'bar', categories: ['一', '二', '三', '四'], series: SERIES })
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    const visible = visibleGenUiChartSeries(plan.series, new Set(['成本']))
    expect(plan.series).toHaveLength(3)
    expect(plan.rows.every(row => '成本' in row)).toBe(true)
    expect(visible.map(s => s.name)).toEqual(['销售额', '利润'])
  })
})

describe('view-state boundary (P0-1 contract: client-side only)', () => {
  it('hiding series never changes the horizontal-ranking decision or the rows', () => {
    const plan = planGenUiChart({
      chartType: 'bar',
      categories: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'],
      series: [
        { name: 's1', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
        { name: 's2', values: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1] },
      ],
    })
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    const visible = visibleGenUiChartSeries(plan.series, new Set(['s2']))
    expect(visible).toHaveLength(1)
    // The plan itself is untouched: same rows, same shape decision.
    expect(plan.rows).toHaveLength(10)
    expect(plan.horizontal).toBe(false)
  })

  it('the range filter is render-only: rows data is never sliced by the helpers', () => {
    const rows = [{ __category: 'a', s: 1 }, { __category: 'b', s: 2 }, { __category: 'c', s: 3 }]
    const range = resolveGenUiChartRange({ startIndex: 1, endIndex: 2 }, rows.length)
    expect(range).toEqual({ startIndex: 1, endIndex: 2 })
    // resolveGenUiChartRange computes a window; slicing happens only in the
    // renderer (recharts brush) — the input rows array stays whole.
    expect(rows).toHaveLength(3)
  })
})
