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
 *
 * View-state interactions (P0-1b): legend chips toggle a series' visibility
 * and the x-axis brush narrows the rendered category window. Both are pure
 * client-side view state — ephemeral React state inside this card — honoring
 * the tool-description boundary contract ("view-state operations are
 * client-side; reserve action-buttons for semantic follow-ups"): no schema
 * field, no persistence, no action/send-message round-trip, and replay
 * semantics are untouched. The interaction decisions live in exported pure
 * helpers (visibleGenUiChartSeries / toggleGenUiChartSeriesHidden /
 * resolveGenUiChartRange) so the interactive layer is fully determined by
 * unit-tested functions, same doctrine as the plan layer.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  Brush,
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
import { cn } from '../../lib/utils'
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

// ── View-state interaction logic (P0-1b, pure; unit-tested directly) ────────

/**
 * Minimum category count before the x-axis range brush earns its footprint —
 * below this the whole plot already fits on screen and a brush is noise.
 */
export const GENUI_CHART_RANGE_MIN_CATEGORIES = 8

/** Inclusive category-index window of the x-axis range filter. */
export interface GenUiChartRange {
  startIndex: number
  endIndex: number
}

/** Whether the range-filter affordance renders for this row count. */
export function genUiChartRangeFilterEnabled(rowCount: number): boolean {
  return rowCount >= GENUI_CHART_RANGE_MIN_CATEGORIES
}

/**
 * Normalize a brush-reported window against the CURRENT row count. Returns
 * null when nothing is narrowed — no window, garbage values (a recharts
 * change event can omit either index), a full-width selection, or an empty
 * plot — so callers render the status row exactly when a real filter is on.
 * A reversed window (endIndex < startIndex) collapses to the start index.
 */
export function resolveGenUiChartRange(
  range: GenUiChartRange | null | undefined,
  rowCount: number,
): GenUiChartRange | null {
  if (!range || rowCount < 1) return null
  if (!Number.isFinite(range.startIndex) || !Number.isFinite(range.endIndex)) return null
  const startIndex = Math.min(Math.max(0, Math.floor(range.startIndex)), rowCount - 1)
  const endIndex = Math.min(Math.max(startIndex, Math.floor(range.endIndex)), rowCount - 1)
  if (startIndex === 0 && endIndex === rowCount - 1) return null
  return { startIndex, endIndex }
}

/**
 * Toggle one series' visibility (identity = its name, the same key the rows
 * use). Pure: returns a fresh set, never mutates the input — stale names
 * (a series the payload no longer carries) are inert downstream.
 */
export function toggleGenUiChartSeriesHidden(hidden: ReadonlySet<string>, name: string): Set<string> {
  const next = new Set(hidden)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  return next
}

/**
 * The series that render: legend chips, Bar/Line elements, and the tooltip
 * all derive from this one list so a hidden series disappears from the whole
 * view while the underlying rows (and the payload) stay untouched.
 */
export function visibleGenUiChartSeries<T extends { name: string }>(
  series: readonly T[],
  hidden: ReadonlySet<string>,
): T[] {
  return series.filter(series => !hidden.has(series.name))
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
 * Click-to-toggle series legend (replaces the recharts <Legend> on multi-
 * series bar/line): same chip family as the datatable column filters. The
 * color dot keeps the series' declaration-order palette slot so hiding a
 * neighbor never recolors a visible series. Pressed = series visible;
 * hidden chips go muted + line-through but stay clickable to restore.
 */
function SeriesLegendChips({
  series,
  hiddenSeries,
  onToggle,
}: {
  series: ReadonlyArray<{ name: string }>
  hiddenSeries: ReadonlySet<string>
  onToggle: (name: string) => void
}) {
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1">
      {series.map((series, index) => {
        const isHidden = hiddenSeries.has(series.name)
        return (
          <button
            key={`${series.name}-${index}`}
            type="button"
            aria-pressed={!isHidden}
            onClick={() => onToggle(series.name)}
            className={cn(
              'flex items-center gap-1 px-1.5 py-0.5 rounded-[4px] text-[11px] border transition-colors',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              isHidden
                ? 'bg-background text-muted-foreground/50 border-foreground/10 line-through'
                : 'bg-background text-muted-foreground border-foreground/10 hover:text-foreground hover:border-foreground/25',
            )}
          >
            <span
              aria-hidden
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: GENUI_CHART_SERIES_COLORS[index % GENUI_CHART_SERIES_COLORS.length] }}
            />
            {series.name}
          </button>
        )
      })}
    </div>
  )
}

/**
 * X-axis range brush (vertical bar/line only — the horizontal ranking and the
 * share-of-whole views have no left-to-right category axis to narrow).
 * Colors come from the same foreground ramp as the grid/axes; the trough is
 * near-invisible so the slider reads as card chrome, not content.
 */
function chartRangeBrush(rowCount: number, onRangeChange: (range: GenUiChartRange | null) => void) {
  return (
    <Brush
      dataKey="__category"
      height={22}
      travellerWidth={8}
      fill="var(--foreground-5)"
      stroke="var(--foreground-20)"
      tickFormatter={(value: unknown) => truncateGenUiChartTick(value, 10)}
      onChange={(state: { startIndex?: number; endIndex?: number }) =>
        onRangeChange(resolveGenUiChartRange(
          { startIndex: state.startIndex ?? 0, endIndex: state.endIndex ?? rowCount - 1 },
          rowCount,
        ))}
    />
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

/**
 * `brush` is the range-filter element for the vertical variants (null when
 * the chart is too short to filter); the legend itself moved out of the plot
 * into SeriesLegendChips above the container.
 */
function BarChartView({ plan, brush }: { plan: ChartPlanOk; brush?: React.ReactNode }) {
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
        {plan.series.map((series, index) => (
          <Bar
            key={index}
            dataKey={series.name}
            fill={GENUI_CHART_SERIES_COLORS[index % GENUI_CHART_SERIES_COLORS.length]}
            radius={[4, 4, 0, 0]}
            maxBarSize={28}
          />
        ))}
        {brush}
      </BarChart>
    </ResponsiveContainer>
  )
}

function LineChartView({ plan, brush }: { plan: ChartPlanOk; brush?: React.ReactNode }) {
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
        {brush}
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

/**
 * The interactive body: legend toggle + range filter state lives here (and
 * nowhere else — no schema field, no persistence). The `key` on the instance
 * from GenUiChartView pins the view to the payload CONTENT: a card update
 * (same id, new JSON) remounts the body, so ephemeral view state and the
 * chart's internal brush window can never leak across payloads, while
 * unrelated parent re-renders keep the user's filters alive.
 */
function InteractiveChartBody({ component, plan }: { component: GenUiChart; plan: ChartPlanOk }) {
  const { t } = useTranslation()
  const [hiddenSeries, setHiddenSeries] = React.useState<ReadonlySet<string>>(() => new Set())
  const [activeRange, setActiveRange] = React.useState<GenUiChartRange | null>(null)
  // Remount nonce for the chart subtree: the recharts brush window is
  // uncontrolled internal state, so "Reset" restores the full view by
  // remounting it, not by reaching into recharts internals.
  const [viewNonce, setViewNonce] = React.useState(0)

  // Legend chips are a multi-series bar/line affordance: only there does a
  // legend entry correspond to a series (pie legends list slices, and
  // pie/funnel plot the first series only).
  const supportsSeriesToggle = (component.chartType === 'bar' || component.chartType === 'line')
    && plan.series.length > 1
  // Range filter: vertical bar/line with enough categories to be worth a brush.
  const showRangeFilter = (component.chartType === 'bar' || component.chartType === 'line')
    && !plan.horizontal
    && genUiChartRangeFilterEnabled(plan.rows.length)

  const visibleSeries = visibleGenUiChartSeries(plan.series, hiddenSeries)
  const displayPlan: ChartPlanOk = visibleSeries.length === plan.series.length
    ? plan
    : { ...plan, series: visibleSeries }
  const brush = showRangeFilter ? chartRangeBrush(plan.rows.length, setActiveRange) : undefined

  const resetView = () => {
    setHiddenSeries(new Set())
    setActiveRange(null)
    setViewNonce(nonce => nonce + 1)
  }

  return (
    <div>
      {supportsSeriesToggle && (
        <SeriesLegendChips
          series={plan.series}
          hiddenSeries={hiddenSeries}
          onToggle={name => setHiddenSeries(prev => toggleGenUiChartSeriesHidden(prev, name))}
        />
      )}
      <div key={viewNonce}>
        {component.chartType === 'bar' && <BarChartView plan={displayPlan} brush={brush} />}
        {component.chartType === 'line' && <LineChartView plan={displayPlan} brush={brush} />}
        {component.chartType === 'pie' && <PieChartView plan={displayPlan} />}
        {component.chartType === 'funnel' && <FunnelChartView plan={displayPlan} />}
      </div>
      {activeRange && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>
            {t('genui.chart.filterStatus', {
              shown: activeRange.endIndex - activeRange.startIndex + 1,
              total: plan.rows.length,
            })}
          </span>
          <button
            type="button"
            onClick={resetView}
            className="text-muted-foreground underline-offset-2 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-[4px]"
          >
            {t('genui.chart.resetFilters')}
          </button>
        </div>
      )}
    </div>
  )
}

export function GenUiChartView({ component }: GenUiChartViewProps) {
  const plan = planGenUiChart(component)
  if (plan.kind === 'placeholder') {
    return <ChartPlaceholder reason={plan.reason} component={component} />
  }
  // Content-addressed key: any payload change (same-card update) resets the
  // ephemeral view state with the card; replayed/hover re-renders keep it.
  const payloadKey = JSON.stringify(component)
  return (
    <ChartCard title={component.title}>
      <InteractiveChartBody key={payloadKey} component={component} plan={plan} />
    </ChartCard>
  )
}
