/**
 * render_ui chart component (iter/chart): the closed-form sixth component.
 * Covers the four chartType payloads, the categories/values equal-length rule
 * (which lives on the components ARRAY superRefine — a refine on the chart
 * member itself would wrap it in ZodEffects and break the discriminated
 * union, the same constraint that keeps the form rules there), the shape
 * bounds, strict-mode rejection of a `src` escape hatch, and the model-side
 * description. All pre-existing payloads must keep parsing unchanged.
 */

import { describe, expect, it } from 'bun:test'
import { getToolDefsAsJsonSchema, RenderUiSchema } from './tool-defs.ts'

function chart(overrides: Record<string, unknown> = {}, series: unknown = undefined): Record<string, unknown> {
  return {
    type: 'chart',
    id: 'c1',
    chartType: 'bar',
    categories: ['一月', '二月', '三月', '四月'],
    series: series ?? [{ name: '销售额', unit: '万台', values: [12, 18, 15, 22] }],
    ...overrides,
  }
}

/**
 * Typed views of the first parsed component/series. The package's declared
 * zod ^3 does not match the hoisted zod 4 install, so
 * `parsed.data.components[0]` infers as `{}` here; asserting through these
 * local views keeps the file typecheck-clean (same pattern as the
 * action-buttons test).
 */
function firstComponent(parsed: { success: boolean; data?: unknown }): Record<string, unknown> {
  const component = ((parsed as { data?: { components?: unknown[] } }).data?.components ?? [])[0] as unknown
  return (component ?? {}) as Record<string, unknown>
}

function firstSeries(parsed: { success: boolean; data?: unknown }): Record<string, unknown> {
  const series = (firstComponent(parsed).series as Array<Record<string, unknown>> | undefined)?.[0] as unknown
  return (series ?? {}) as Record<string, unknown>
}

/** Loose view of the safeParse error issues (path/message only — zod-version-proof). */
function issues(parsed: unknown): Array<{ path: string; message: string }> {
  const error = (parsed as { error?: { issues?: Array<{ path?: unknown[]; message?: string }> } }).error
  return (error?.issues ?? []).map(issue => ({
    path: (issue.path ?? []).map(String).join('.'),
    message: issue.message ?? '',
  }))
}

describe('chart schema — the four closed chartTypes parse', () => {
  for (const chartType of ['bar', 'line', 'funnel', 'pie'] as const) {
    it(`accepts a ${chartType} payload with series/unit/categories intact`, () => {
      const parsed = RenderUiSchema.safeParse({ components: [chart({ chartType })] })
      expect(parsed.success).toBe(true)
      const component = firstComponent(parsed)
      expect(component['type']).toBe('chart')
      expect(component['chartType']).toBe(chartType)
      expect(component['categories']).toEqual(['一月', '二月', '三月', '四月'])
      const series = firstSeries(parsed)
      expect(series['name']).toBe('销售额')
      expect(series['unit']).toBe('万台')
      expect(series['values']).toEqual([12, 18, 15, 22])
      // All-optional contract: goodWhen is not implied by a default.
      expect(component['goodWhen']).toBeUndefined()
    })
  }

  it('accepts goodWhen up/down/neutral and up to 3 series', () => {
    const series = [
      { name: 's1', unit: '%', values: [1, 2, 3, 4] },
      { name: 's2', values: [4, 3, 2, 1] },
      { name: 's3', values: [2, 2, 2, 2] },
    ]
    for (const goodWhen of ['up', 'down', 'neutral'] as const) {
      const parsed = RenderUiSchema.safeParse({ components: [chart({ goodWhen }, series)] })
      expect(parsed.success).toBe(true)
      expect(firstComponent(parsed)['goodWhen']).toBe(goodWhen)
    }
  })

  it('rejects an unknown chartType', () => {
    expect(RenderUiSchema.safeParse({ components: [chart({ chartType: 'scatter' })] }).success).toBe(false)
  })
})

describe('chart schema — categories/values equal length (array superRefine)', () => {
  it('accepts exactly matching lengths', () => {
    expect(RenderUiSchema.safeParse({ components: [chart()] }).success).toBe(true)
  })

  it('rejects a series whose values do not match the category count', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [chart({}, [
        { name: 'full', values: [1, 2, 3, 4] },
        { name: 'short', values: [1, 2, 3] },
      ])],
    })
    expect(parsed.success).toBe(false)
    const match = issues(parsed).find(issue => issue.path.endsWith('series.1.values'))
    expect(match).toBeDefined()
    expect(match!.message).toContain('must match')
  })

  it('reports the equal-length issue without crashing the payload-cap rule', () => {
    // A mismatch AND a duplicate id: both array-level rules fire independently.
    const parsed = RenderUiSchema.safeParse({
      components: [
        chart({ id: 'dup' }),
        chart({ id: 'dup', type: 'chart', chartType: 'line' }, [{ name: 's', values: [1, 2] }]),
      ],
    })
    expect(parsed.success).toBe(false)
    const paths = issues(parsed).map(issue => issue.path)
    expect(paths.some(path => path.endsWith('series.0.values'))).toBe(true)
    expect(paths.some(path => path.endsWith('.id'))).toBe(true)
  })
})

describe('chart schema — closed-form bounds', () => {
  it('rejects fewer than 2 or more than 24 categories', () => {
    expect(RenderUiSchema.safeParse({ components: [chart({ categories: ['仅一档'] }, [{ name: 's', values: [1] }])] }).success).toBe(false)
    expect(RenderUiSchema.safeParse({ components: [chart({ categories: Array.from({ length: 25 }, (_, i) => `c${i}`) }, [{ name: 's', values: Array.from({ length: 25 }, (_, i) => i) }])] }).success).toBe(false)
  })

  it('bounds series values to min 2; the 48 ceiling is unreachable past 24 categories', () => {
    expect(safeParseWithValuesCount(1)).toBe(false)
    // The declared 48-value ceiling interacts with the equal-length rule:
    // 48 values would need 48 categories, which violates the categories cap.
    expect(safeParseWithValuesCount(48)).toBe(false)
    // The reachable maximum is 24 values against 24 categories.
    expect(safeParseWithValuesCount(49)).toBe(false)
    expect(safeParseWithCategoriesAndValuesCount(24)).toBe(true)
  })

  it('rejects over-length category labels, series names, and units', () => {
    expect(RenderUiSchema.safeParse({ components: [chart({ categories: ['x'.repeat(61), 'y'] }, [{ name: 's', values: [1, 2] }])] }).success).toBe(false)
    expect(RenderUiSchema.safeParse({ components: [chart({}, [{ name: 'x'.repeat(61), values: [1, 2] }])] }).success).toBe(false)
    expect(RenderUiSchema.safeParse({ components: [chart({}, [{ name: 's', unit: 'x'.repeat(13), values: [1, 2] }])] }).success).toBe(false)
  })

  it('rejects more than 3 series', () => {
    const four = [1, 2, 3, 4].map(n => ({ name: `s${n}`, values: [n, n] }))
    expect(RenderUiSchema.safeParse({ components: [chart({ categories: ['a', 'b'] }, four)] }).success).toBe(false)
  })
})

/** Two-category chart with the given per-series values length (bounds helper). */
function safeParseWithValuesCount(count: number): boolean {
  return RenderUiSchema.safeParse({
    components: [chart({ categories: ['a', 'b'] }, [{ name: 's', values: Array.from({ length: count }, (_, i) => i) }])],
  }).success
}

/** n-category chart with matching n-value series (bounds helper for the reachable max). */
function safeParseWithCategoriesAndValuesCount(count: number): boolean {
  return RenderUiSchema.safeParse({
    components: [
      chart(
        { categories: Array.from({ length: count }, (_, i) => `c${i}`) },
        [{ name: 's', values: Array.from({ length: count }, (_, i) => i) }],
      ),
    ],
  }).success
}

describe('chart schema — closed form, no escape hatches', () => {
  it('rejects a "src" field (chart data is inline by design, unlike data-table)', () => {
    expect(RenderUiSchema.safeParse({ components: [chart({ src: 'data/points.json' })] }).success).toBe(false)
  })

  it('rejects unknown keys generally (strict)', () => {
    expect(RenderUiSchema.safeParse({ components: [chart({ rows: [{ v: 1 }] })] }).success).toBe(false)
  })

  it('keeps parsing every pre-chart component shape (zero regression)', () => {
    const legacy = [
      { type: 'stat-card', id: 's1', label: 'Gross margin', value: 42, delta: 0.152, trend: 'up' },
      { type: 'data-table', id: 't1', src: 'data/rows.json', columns: [{ key: 'k', label: 'K' }] },
      { type: 'alert', id: 'a1', severity: 'warning', message: 'check' },
      { type: 'progress', id: 'p1', status: 'running', label: 'Working' },
      {
        type: 'action-buttons', id: 'b1', buttons: [
          { id: 'x', label: 'Go', style: 'primary', action: { kind: 'send-message', prompt: 'go' } },
        ],
      },
      { type: 'form', id: 'f1', fields: [{ key: 'note', label: 'Note' }] },
    ]
    expect(RenderUiSchema.safeParse({ components: legacy }).success).toBe(true)
  })
})

describe('render_ui tool description documents the chart component', () => {
  it('carries the chart line and the chart-vs-table guidance to the model', () => {
    const def = getToolDefsAsJsonSchema({ allowRenderUi: true }).find(d => d.name === 'render_ui')!
    const description = def.description
    for (const needle of ['`chart`', '"chartType"', 'bar', 'line', 'funnel', 'pie', 'row-level detail']) {
      expect(description).toContain(needle)
    }
  })

  it('marks chart as the inline-data exception in the payload rule', () => {
    const def = getToolDefsAsJsonSchema({ allowRenderUi: true }).find(d => d.name === 'render_ui')!
    expect(def.description).toContain('`chart` is the exception')
  })
})
