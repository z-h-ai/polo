/**
 * GenUiChart - recharts renderer for the render_ui `chart` component (iter/chart).
 *
 * This module is loaded EXCLUSIVELY through React.lazy in GenUICard's registry
 * — recharts must never enter the main bundle. Keep every static import here
 * chart-related; payload types come in via `import type` from GenUICard (type
 * only, erased at build time, so the lazy chunk stays one-directional).
 *
 * Every color derives from theme CSS variables (--accent/--info/--success/
 * --destructive and the --foreground-* ramp), which the `.dark` theme
 * redefines — charts adapt to dark mode with no chart-side palette.
 *
 * The model-side schema already bounds the payload (4 chart types, 2-24
 * categories, 1-3 series of 2-48 numbers), but replayed or hand-edited cards
 * can carry anything parseGenUiComponents lets through, so the renderer plans
 * first (planGenUiChart) and never crashes on off shapes — it degrades to the
 * GenUiUnknownFallback-style placeholder instead.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Funnel,
  FunnelChart,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { TooltipValueType } from 'recharts'
import { AlertTriangle } from 'lucide-react'
import type { GenUiChart } from './GenUICard'

// ── Payload-shape mirrors (renderer-side, tolerant) ──────────────────────────

/** The four closed chart forms; anything else placeholders. */
export const GENUI_CHART_TYPES = ['bar', 'line', 'funnel', 'pie'] as const
export type GenUiChartType = (typeof GENUI_CHART_TYPES)[number]

/** Renderer-side mirror of the schema's series cap; over-limit placeholders. */
export const GENUI_CHART_MAX_SERIES = 3

/**
 * Horizontal ranking threshold: a single-series bar spanning at least this
 * many categories flips to a horizontal ranking (category names read better
 * as rows once there are enough of them to compare).
 */
export const GENUI_CHART_HORIZONTAL_MIN_CATEGORIES = 4

/** Fixed plot height — one steady visual rhythm across chart types. */
const GENUI_CHART_HEIGHT = 190

/** Bar/line series colors in declaration order (max 3 = schema cap). */
const GENUI_CHART_SERIES_COLORS = ['var(--accent)', 'var(--info)', 'var(--success)'] as const

/** Base cycle for pie/funnel slices (see genUiChartSliceColor). */
const GENUI_CHART_SLICE_BASE_COLORS = ['var(--accent)', 'var(--info)', 'var(--success)', 'var(--destructive)'] as const

// ── Pure planning logic (unit-tested directly; no recharts in the decisions) ─

/**
 * One recharts data row. The category rides an internal `__category` key so a
 * series literally named "category" can never collide with it.
 */
export interface GenUiChartRow {
  __category: string
  [seriesName: string]: string | number
}

export type GenUiChartPlan =
  | {
      kind: 'ok'
      horizontal: boolean
      rows: GenUiChartRow[]
      series: Array<{ name: string; unit?: string; values: Array<number | undefined> }>
    }
  | { kind: 'placeholder'; reason: 'empty' | 'too-many-series' | 'unknown-chart-type' }

/**
 * Numbers (and numeric strings from hand-edited cards) survive; anything
 * else — null/undefined/booleans, NaN/Infinity — drops out of the plot rather
 * than silently becoming zero.
 */
function coerceFinite(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
  }
  return undefined
}

/**
 * Decide how (or whether) a chart payload renders. Tolerant by design:
 * - unknown chartType / series over the cap → placeholder;
 * - length mismatches clip to the common prefix instead of drawing
 *   category/value pairs that do not exist;
 * - payloads with no plottable number at all → empty placeholder.
 */
export function planGenUiChart(component: Pick<GenUiChart, 'chartType' | 'categories' | 'series'>): GenUiChartPlan {
  if (!(GENUI_CHART_TYPES as readonly string[]).includes(component.chartType)) {
    return { kind: 'placeholder', reason: 'unknown-chart-type' }
  }
  if (component.series.length > GENUI_CHART_MAX_SERIES) {
    return { kind: 'placeholder', reason: 'too-many-series' }
  }
  const categories = component.categories.map(value => (value === null || value === undefined ? '' : String(value)))
  // Plottable width = the shortest of categories and every series.
  const width = component.series.reduce(
    (width, series) => Math.min(width, series.values.length),
    categories.length,
  )
  const series = component.series.map(s => ({
    name: String(s.name),
    unit: s.unit,
    values: s.values.slice(0, width).map(coerceFinite),
  }))
  const hasPlottableValue = series.some(s => s.values.some(value => value !== undefined))
  if (width < 1 || categories.length < 1 || !hasPlottableValue) {
    return { kind: 'placeholder', reason: 'empty' }
  }
  const rows: GenUiChartRow[] = []
  for (let index = 0; index < width; index++) {
    const row: GenUiChartRow = { __category: categories[index]! }
    for (const s of series) {
      const value = s.values[index]
      if (value !== undefined) row[s.name] = value
    }
    rows.push(row)
  }
  return {
    kind: 'ok',
    // Horizontal ranking variant: single-series bar with enough categories to compare.
    horizontal: component.chartType === 'bar'
      && series.length === 1
      && width >= GENUI_CHART_HORIZONTAL_MIN_CATEGORIES,
    rows,
    series,
  }
}

/**
 * Slice fill for pie/funnel: cycle the four semantic tokens, then repeat them
 * progressively mixed toward the background so up to the schema's 24 slices
 * stay distinguishable while every color still comes from theme tokens.
 */
export function genUiChartSliceColor(index: number): string {
  const base = GENUI_CHART_SLICE_BASE_COLORS[index % GENUI_CHART_SLICE_BASE_COLORS.length]!
  const cycle = Math.floor(index / GENUI_CHART_SLICE_BASE_COLORS.length)
  if (cycle <= 0) return base
  const keep = Math.max(30, 75 - cycle * 15)
  return `color-mix(in oklab, ${base} ${keep}%, var(--background))`
}

/**
 * Tooltip/axis value: thousands separators, then the series unit if any.
 * Non-finite values render verbatim so a malformed number stays visible.
 */
export function formatGenUiChartValue(value: TooltipValueType | number | string | undefined, unit?: string): string {
  if (value === undefined || value === null) return ''
  const raw = Array.isArray(value) ? value[0] : value
  const num = typeof raw === 'number' ? raw : Number(raw)
  const text = Number.isFinite(num) ? num.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(raw)
  return unit ? `${text} ${unit}` : text
}

/**
 * Category labels can be 60 chars per the schema; the axis truncates them and
 * the tooltip carries the full text.
 */
export function truncateGenUiChartTick(value: unknown, max = 14): string {
  const text = value === null || value === undefined ? '' : String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ── Shared styling (token-derived) ───────────────────────────────────────────

const AXIS_TICK_STYLE = { fill: 'var(--foreground-50)', fontSize: 11 } as const
const GRID_STROKE = 'var(--foreground-10)'
const TOOLTIP_CONTENT_STYLE = {
  background: 'var(--background)',
  border: '1px solid var(--foreground-10)',
  borderRadius: 8,
  fontSize: 12,
  padding: '6px 10px',
} as const
const TOOLTIP_LABEL_STYLE = { color: 'var(--foreground)', fontWeight: 500 } as const
const TOOLTIP_ITEM_STYLE = { color: 'var(--foreground)' } as const
const LEGEND_WRAPPER_STYLE = { fontSize: 11, color: 'var(--muted-foreground)' } as const

/** Tooltip wired to the shared token styling and the per-series unit lookup. */
function chartTooltip(unitFor: (seriesName: string) => string | undefined, cursor?: Record<string, unknown>) {
  return (
    <Tooltip
      cursor={cursor}
      contentStyle={TOOLTIP_CONTENT_STYLE}
      labelStyle={TOOLTIP_LABEL_STYLE}
      itemStyle={TOOLTIP_ITEM_STYLE}
      formatter={(value: TooltipValueType | undefined, name: string | number | undefined) =>
        [formatGenUiChartValue(value, unitFor(String(name ?? ''))), String(name ?? '')]}
    />
  )
}

/** Card chrome shared with the other GenUI renderers. */
function ChartCard({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[8px] overflow-hidden border bg-muted/10">
      {title && (
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{title}</span>
        </div>
      )}
      <div className="px-3 py-2.5">{children}</div>
    </div>
  )
}

/**
 * Placeholder in the GenUiUnknownFallback style: warning header + reason
 * (plus the raw payload when the chartType itself is unrecognizable, so the
 * data is never lost).
 */
function ChartPlaceholder({
  reason,
  component,
}: { reason: 'empty' | 'too-many-series' | 'unknown-chart-type'; component: GenUiChart }) {
  const { t } = useTranslation()
  const message = reason === 'too-many-series'
    ? t('genui.chart.tooManySeries')
    : reason === 'empty'
      ? t('genui.chart.empty')
      : t('genui.unknownType', { type: String(component.chartType ?? '') })
  return (
    <div className="rounded-[8px] overflow-hidden border bg-muted/10">
      <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-1.5">
        <AlertTriangle className="w-3 h-3 text-muted-foreground/60 shrink-0" />
        <span className="text-[12px] text-muted-foreground font-medium">{message}</span>
      </div>
      {reason === 'unknown-chart-type' && (
        <pre className="px-3 py-2 text-[11px] leading-relaxed text-muted-foreground overflow-x-auto select-text max-h-[240px]">
          {JSON.stringify(component, null, 2)}
        </pre>
      )}
    </div>
  )
}

// ── Per-chartType views ──────────────────────────────────────────────────────

type ChartPlanOk = Extract<GenUiChartPlan, { kind: 'ok' }>

function BarChartView({ plan }: { plan: ChartPlanOk }) {
  const unitByName = new Map(plan.series.map(series => [series.name, series.unit]))
  if (plan.horizontal) {
    // Ranking variant: categories as rows, best read top-to-bottom.
    return (
      <ResponsiveContainer width="100%" height={GENUI_CHART_HEIGHT}>
        <BarChart data={plan.rows} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} horizontal={false} />
          <XAxis type="number" tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="__category"
            width={104}
            tick={AXIS_TICK_STYLE}
            axisLine={false}
            tickLine={false}
            tickFormatter={truncateGenUiChartTick}
          />
          {chartTooltip(name => unitByName.get(name), { fill: 'var(--foreground-5)' })}
          <Bar
            dataKey={plan.series[0]?.name}
            fill={GENUI_CHART_SERIES_COLORS[0]}
            radius={[0, 4, 4, 0]}
            maxBarSize={22}
          />
        </BarChart>
      </ResponsiveContainer>
    )
  }
  return (
    <ResponsiveContainer width="100%" height={GENUI_CHART_HEIGHT}>
      <BarChart data={plan.rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID_STROKE} vertical={false} />
        <XAxis
          dataKey="__category"
          tick={AXIS_TICK_STYLE}
          tickFormatter={truncateGenUiChartTick}
          axisLine={false}
          tickLine={false}
        />
        <YAxis tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} width={44} />
        {chartTooltip(name => unitByName.get(name), { fill: 'var(--foreground-5)' })}
        {plan.series.length > 1 && <Legend iconType="circle" wrapperStyle={LEGEND_WRAPPER_STYLE} />}
        {plan.series.map((series, index) => (
          <Bar
            key={index}
            dataKey={series.name}
            fill={GENUI_CHART_SERIES_COLORS[index % GENUI_CHART_SERIES_COLORS.length]}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  )
}

function LineChartView({ plan }: { plan: ChartPlanOk }) {
  const unitByName = new Map(plan.series.map(series => [series.name, series.unit]))
  return (
    <ResponsiveContainer width="100%" height={GENUI_CHART_HEIGHT}>
      <LineChart data={plan.rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID_STROKE} vertical={false} />
        <XAxis
          dataKey="__category"
          tick={AXIS_TICK_STYLE}
          tickFormatter={truncateGenUiChartTick}
          axisLine={false}
          tickLine={false}
        />
        <YAxis tick={AXIS_TICK_STYLE} axisLine={false} tickLine={false} width={44} />
        {chartTooltip(name => unitByName.get(name), { stroke: 'var(--foreground-20)' })}
        {plan.series.length > 1 && <Legend iconType="circle" wrapperStyle={LEGEND_WRAPPER_STYLE} />}
        {plan.series.map((series, index) => (
          <Line
            key={index}
            type="monotone"
            dataKey={series.name}
            stroke={GENUI_CHART_SERIES_COLORS[index % GENUI_CHART_SERIES_COLORS.length]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}

/**
 * pie/funnel plot one whole: the FIRST series as { name, value } slices
 * (multi-series has no meaning for a share-of-whole; schema still allows up
 * to 3 for the closed form). Unplottable points drop out.
 */
function singleSeriesSlices(plan: ChartPlanOk): Array<{ name: string; value: number }> {
  const series = plan.series[0]
  if (!series) return []
  return plan.rows
    .map(row => ({ name: row.__category, value: coerceFinite(row[series.name]) ?? Number.NaN }))
    .filter(slice => Number.isFinite(slice.value))
}

function PieChartView({ plan }: { plan: ChartPlanOk }) {
  const slices = singleSeriesSlices(plan)
  const unit = plan.series[0]?.unit
  return (
    <ResponsiveContainer width="100%" height={GENUI_CHART_HEIGHT}>
      <PieChart>
        {slices.length > 0 && slices.length <= 8 && <Legend iconType="circle" wrapperStyle={LEGEND_WRAPPER_STYLE} />}
        <Pie data={slices} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="78%" paddingAngle={1} strokeWidth={0}>
          {slices.map((slice, index) => (
            <Cell key={`${slice.name}-${index}`} fill={genUiChartSliceColor(index)} />
          ))}
        </Pie>
        {chartTooltip(() => unit)}
      </PieChart>
    </ResponsiveContainer>
  )
}

function FunnelChartView({ plan }: { plan: ChartPlanOk }) {
  const slices = singleSeriesSlices(plan)
  const unit = plan.series[0]?.unit
  return (
    <ResponsiveContainer width="100%" height={GENUI_CHART_HEIGHT}>
      <FunnelChart>
        {chartTooltip(() => unit)}
        <Funnel dataKey="value" nameKey="name" data={slices}>
          {slices.map((slice, index) => (
            <Cell key={`${slice.name}-${index}`} fill={genUiChartSliceColor(index)} />
          ))}
          <LabelList position="right" dataKey="name" fill="var(--foreground-70)" fontSize={11} />
        </Funnel>
      </FunnelChart>
    </ResponsiveContainer>
  )
}

// ── Main renderer ────────────────────────────────────────────────────────────

export interface GenUiChartViewProps {
  component: GenUiChart
  /** Present for registry interface parity; the chart is read-only. */
  sessionId?: string
}

export function GenUiChartView({ component }: GenUiChartViewProps) {
  const plan = planGenUiChart(component)
  if (plan.kind === 'placeholder') {
    return <ChartPlaceholder reason={plan.reason} component={component} />
  }
  return (
    <ChartCard title={component.title}>
      {component.chartType === 'bar' && <BarChartView plan={plan} />}
      {component.chartType === 'line' && <LineChartView plan={plan} />}
      {component.chartType === 'pie' && <PieChartView plan={plan} />}
      {component.chartType === 'funnel' && <FunnelChartView plan={plan} />}
    </ChartCard>
  )
}
