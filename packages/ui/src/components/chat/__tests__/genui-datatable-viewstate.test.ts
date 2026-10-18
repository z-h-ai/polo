/**
 * GenUI data-table client-side column filters (P0-1 view-state boundary):
 * pure filter helpers exported from MarkdownDatatableBlock. View-state
 * operations (filter/sort/group) are the table's own concern — they never
 * round-trip through the model, never enter the datatable spec, and are never
 * persisted (ephemeral component state). The markdown ```datatable rich block
 * keeps enableColumnFilters unset (default false) — its behavior contract is
 * covered by the existing datatable tests staying green.
 */

import { describe, it, expect } from 'bun:test'
import {
  DATATABLE_FILTER_CHIP_MAX_DISTINCT,
  activeColumnFilterEntries,
  applyColumnFilters,
  computeTextFilterChips,
  isNumericFilterColumnType,
  parseFilterBound,
  type ColumnFilters,
} from '../../markdown/MarkdownDatatableBlock'

describe('computeTextFilterChips', () => {
  const rows = [
    { region: 'EMEA', tier: '高' },
    { region: 'APAC', tier: '中' },
    { region: 'EMEA', tier: '低' },
    { region: 'AMER' },
  ]

  it('returns distinct values in first-appearance order', () => {
    expect(computeTextFilterChips(rows, 'region')).toEqual(['EMEA', 'APAC', 'AMER'])
  })

  it('serializes non-string values via String', () => {
    expect(computeTextFilterChips([{ v: 1 }, { v: 2 }, { v: 1 }], 'v')).toEqual(['1', '2'])
  })

  it('skips null and undefined cell values', () => {
    expect(computeTextFilterChips([{ v: null }, { v: 'x' }, { v: undefined }, { v: 'x' }], 'v')).toEqual(['x'])
  })

  it('returns null past the distinct-value cap (no chip explosion)', () => {
    expect(computeTextFilterChips(rows, 'region', 2)).toBeNull()
    const many = Array.from({ length: DATATABLE_FILTER_CHIP_MAX_DISTINCT + 1 }, (_, i) => ({ v: `v${i}` }))
    expect(computeTextFilterChips(many, 'v')).toBeNull()
    const exactlyAtCap = many.slice(0, DATATABLE_FILTER_CHIP_MAX_DISTINCT)
    expect(computeTextFilterChips(exactlyAtCap, 'v')).toHaveLength(DATATABLE_FILTER_CHIP_MAX_DISTINCT)
  })

  it('returns an empty list for an all-null column (rendered but no chips)', () => {
    expect(computeTextFilterChips([{ v: null }], 'v')).toEqual([])
  })
})

describe('parseFilterBound (invalid input is ignored, not applied)', () => {
  it('parses integers and decimals, tolerating whitespace', () => {
    expect(parseFilterBound('42')).toBe(42)
    expect(parseFilterBound(' 3.5 ')).toBe(3.5)
    expect(parseFilterBound('-7')).toBe(-7)
  })

  it('drops empty and non-numeric input', () => {
    expect(parseFilterBound('')).toBeUndefined()
    expect(parseFilterBound('   ')).toBeUndefined()
    expect(parseFilterBound('abc')).toBeUndefined()
    expect(parseFilterBound('12abc')).toBeUndefined()
  })
})

describe('applyColumnFilters', () => {
  const rows = [
    { region: 'EMEA', revenue: 100, growth: 0.1 },
    { region: 'APAC', revenue: 300, growth: 0.5 },
    { region: 'AMER', revenue: 200, growth: -0.2 },
    { region: 'EMEA', revenue: 250, growth: 0.05 },
  ]

  it('returns the input rows unchanged when no filters are active', () => {
    expect(applyColumnFilters(rows, {})).toEqual(rows)
    // Non-concrete filters (empty text / no bounds) are inert too
    expect(applyColumnFilters(rows, { region: { kind: 'text', value: '' }, revenue: { kind: 'range' } })).toEqual(rows)
  })

  it('filters text columns by display-value equality', () => {
    const filtered = applyColumnFilters(rows, { region: { kind: 'text', value: 'EMEA' } })
    expect(filtered).toHaveLength(2)
    expect(filtered.every(r => r.region === 'EMEA')).toBe(true)
  })

  it('filters numeric columns by min/max range (inclusive)', () => {
    expect(applyColumnFilters(rows, { revenue: { kind: 'range', min: 150 } }).map(r => r.region))
      .toEqual(['APAC', 'AMER', 'EMEA'])
    expect(applyColumnFilters(rows, { revenue: { kind: 'range', max: 200 } }).map(r => r.region))
      .toEqual(['EMEA', 'AMER'])
    expect(applyColumnFilters(rows, { revenue: { kind: 'range', min: 100, max: 250 } }).map(r => r.region))
      .toEqual(['EMEA', 'AMER', 'EMEA'])
  })

  it('combines filters across columns conjunctively (AND)', () => {
    const filtered = applyColumnFilters(rows, {
      region: { kind: 'text', value: 'EMEA' },
      revenue: { kind: 'range', min: 200 },
    })
    expect(filtered).toEqual([{ region: 'EMEA', revenue: 250, growth: 0.05 }])
  })

  it('excludes non-numeric values while a range filter is active', () => {
    const mixed = [
      { v: 10 }, { v: 'n/a' }, { v: 30 }, { v: null },
    ]
    expect(applyColumnFilters(mixed, { v: { kind: 'range', min: 0 } })).toEqual([{ v: 10 }, { v: 30 }])
  })

  it('matches numeric-column text equality via String (chip semantics)', () => {
    const filtered = applyColumnFilters(rows, { growth: { kind: 'text', value: '0.1' } })
    expect(filtered).toEqual([{ region: 'EMEA', revenue: 100, growth: 0.1 }])
  })
})

describe('activeColumnFilterEntries (status-bar accounting)', () => {
  it('lists only concrete filters, in key insertion order', () => {
    const filters: ColumnFilters = {
      region: { kind: 'text', value: 'EMEA' },
      empty: { kind: 'text', value: '' },
      revenue: { kind: 'range', min: 100 },
      blank: { kind: 'range' },
    }
    expect(activeColumnFilterEntries(filters)).toEqual([
      ['region', { kind: 'text', value: 'EMEA' }],
      ['revenue', { kind: 'range', min: 100 }],
    ])
  })
})

describe('isNumericFilterColumnType (numeric columns get range inputs, not chips)', () => {
  it('treats number/currency/percent as numeric', () => {
    expect(isNumericFilterColumnType('number')).toBe(true)
    expect(isNumericFilterColumnType('currency')).toBe(true)
    expect(isNumericFilterColumnType('percent')).toBe(true)
  })

  it('treats text/badge/boolean/date as chip columns', () => {
    expect(isNumericFilterColumnType('text')).toBe(false)
    expect(isNumericFilterColumnType('badge')).toBe(false)
    expect(isNumericFilterColumnType('boolean')).toBe(false)
    expect(isNumericFilterColumnType('date')).toBe(false)
    expect(isNumericFilterColumnType(undefined)).toBe(false)
  })
})
