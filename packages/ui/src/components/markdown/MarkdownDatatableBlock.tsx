/**
 * MarkdownDatatableBlock - Interactive data table for markdown ```datatable code blocks
 *
 * Renders structured JSON as a sortable table with fullscreen expand.
 * No TanStack dependency — uses native HTML table + React state for lightweight
 * portability across Electron and the web viewer.
 *
 * Expected JSON shape (inline):
 * {
 *   "title": "Sales by Region",
 *   "columns": [{ "key": "region", "label": "Region", "type": "text" }],
 *   "rows": [{ "region": "North America" }]
 * }
 *
 * File-backed shape (src field):
 * {
 *   "src": "data/transactions.json",
 *   "title": "Transactions",
 *   "columns": [{ "key": "id", "label": "ID", "type": "text" }]
 * }
 *
 * When `src` is present, rows are loaded from the file via PlatformContext.onReadFile.
 * The file can contain full {title, columns, rows} or just a rows array [...].
 * Inline title/columns take precedence over file values.
 *
 * Falls back to CodeBlock if JSON parsing fails.
 */

import * as React from 'react'
import niceTicks from 'nice-ticks'
import { ArrowUpDown, Check, ChevronRight, Group, ListFilter, Maximize2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { DataTableOverlay } from '../overlay/DataTableOverlay'
import { useScrollFade } from './useScrollFade'
import { TableExportDropdown } from './TableExportDropdown'
import { usePlatform } from '../../context/PlatformContext'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '../ui/StyledDropdown'
import { useTranslation } from 'react-i18next'

// ── Types ────────────────────────────────────────────────────────────────────

interface ColumnDef {
  key: string
  label: string
  type?: 'text' | 'number' | 'currency' | 'percent' | 'boolean' | 'date' | 'badge'
  align?: 'left' | 'center' | 'right'
  /** percent columns only: change = up/down move (signed, colored); rate/share = unsigned, neutral */
  semantics?: 'rate' | 'share' | 'change'
  /** badge columns only: cell value → chip color; unmatched values stay neutral */
  badgeColors?: Record<string, 'info' | 'success' | 'warning' | 'error'>
  /** iter/row-actions: render values as external links (http(s) value or { value, link }) */
  link?: boolean
}

interface DatatableData {
  title?: string
  columns: ColumnDef[]
  rows: Record<string, unknown>[]
}

interface DatatableSpec {
  src?: string
  title?: string
  columns?: ColumnDef[]
  rows?: Record<string, unknown>[]
}

type SortDir = 'asc' | 'desc' | null

// ── Cell formatting ──────────────────────────────────────────────────────────

export type BadgeColorName = 'info' | 'success' | 'warning' | 'error'

/** Chip classes per declared badge color; `warning` rides the amber `info` token (no separate warning color in the theme). */
const BADGE_COLOR_CLASSES: Record<BadgeColorName, string> = {
  info: 'bg-accent/10 text-accent',
  success: 'bg-success/10 text-success',
  warning: 'bg-info/10 text-info',
  error: 'bg-destructive/10 text-destructive',
}
const BADGE_NEUTRAL_CLASS = 'bg-muted text-muted-foreground'

/**
 * Unsigned, magnitude-aware percent for rate/share semantics columns
 * (decimal fraction in: 0.068 → "6.8%"). No sign, no coloring — a share or a
 * loss rate is not an up/down move, so "+" and green/red would mislead.
 * Thousands separators kick in past 1000%; precision tightens as magnitudes
 * shrink so sub-1% rates keep their digits.
 */
export function formatNeutralPercent(pct: number): string {
  const scaled = pct * 100
  const abs = Math.abs(scaled)
  const maxFractionDigits = abs >= 1000 ? 1 : abs >= 1 ? 2 : 4
  return scaled.toLocaleString('en-US', { maximumFractionDigits: maxFractionDigits }) + '%'
}

/**
 * Chip class for a badge cell. When the column declares `badgeColors`, the
 * cell value is matched against it case-insensitively — a hit renders that
 * color, a miss stays neutral (a declared map replaces the builtin guesses).
 * Without `badgeColors`, the builtin status-word mapping applies unchanged.
 */
export function resolveBadgeChipClass(value: string, badgeColors?: ColumnDef['badgeColors']): string {
  if (badgeColors) {
    const needle = value.toLowerCase()
    for (const [key, color] of Object.entries(badgeColors)) {
      if (key.toLowerCase() === needle) return BADGE_COLOR_CLASSES[color]
    }
    return BADGE_NEUTRAL_CLASS
  }
  const s = value.toLowerCase()
  if (s === 'active' || s === 'passing' || s === 'success' || s === 'done') return BADGE_COLOR_CLASSES.success
  if (s === 'revoked' || s === 'failed' || s === 'error') return BADGE_COLOR_CLASSES.error
  return BADGE_NEUTRAL_CLASS
}

function formatCell(value: unknown, col: ColumnDef): React.ReactNode {
  const type = col.type
  if (value === null || value === undefined) return <span className="text-muted-foreground/40">—</span>
  switch (type) {
    case 'currency': {
      const num = typeof value === 'number' ? value : Number(value)
      if (isNaN(num)) return String(value)
      return <span className="tabular-nums">{num.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
    }
    case 'percent': {
      const pct = typeof value === 'number' ? value : Number(value)
      if (isNaN(pct)) return String(value)
      // rate/share: unsigned, neutral. change (default): signed + green/red.
      if (col.semantics === 'rate' || col.semantics === 'share') {
        return <span className="tabular-nums">{formatNeutralPercent(pct)}</span>
      }
      const formatted = (pct * 100).toFixed(1) + '%'
      const positive = pct > 0
      return <span className={cn('tabular-nums', positive && 'text-success', pct < 0 && 'text-destructive')}>{positive ? '+' : ''}{formatted}</span>
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value)
      if (isNaN(n)) return String(value)
      return <span className="tabular-nums">{n.toLocaleString()}</span>
    }
    case 'boolean':
      return value ? <span className="text-success">Yes</span> : <span className="text-muted-foreground">No</span>
    case 'badge': {
      const color = resolveBadgeChipClass(String(value), col.badgeColors)
      return <span className={cn('inline-block px-1.5 py-0.5 rounded text-[11px] font-medium', color)}>{String(value)}</span>
    }
    default:
      return String(value)
  }
}

function colAlign(type?: ColumnDef['type'], explicit?: string): string {
  if (explicit) return `text-${explicit}`
  if (type === 'number' || type === 'currency' || type === 'percent') return 'text-right'
  return 'text-left'
}

// ── Sort icon ────────────────────────────────────────────────────────────────

function SortIcon({ dir }: { dir: SortDir }) {
  return (
    <svg className={cn('w-3 h-3 shrink-0', dir ? 'opacity-60' : 'opacity-20')} viewBox="0 0 16 16" fill="currentColor">
      {dir === 'asc' ? (
        <path d="M8 3l4 5H4l4-5z" />
      ) : dir === 'desc' ? (
        <path d="M8 13l4-5H4l4 5z" />
      ) : (
        <>
          <path d="M8 3l3 4H5l3-4z" />
          <path d="M8 13l3-4H5l3 4z" />
        </>
      )}
    </svg>
  )
}

// ── Grouping granularity ─────────────────────────────────────────────────

interface GranularityOption {
  label: string
  value: string
}

const DATE_GRANULARITIES: GranularityOption[] = [
  { label: 'Hour', value: 'hour' },
  { label: 'Day', value: 'day' },
  { label: 'Month', value: 'month' },
  { label: 'Year', value: 'year' },
]

function formatCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K'
  if (abs >= 1) return String(Math.round(n))
  if (abs >= 0.01) return n.toFixed(2)
  return String(n)
}

function computeNumericGranularities(values: number[], type: 'number' | 'currency' | 'percent'): GranularityOption[] {
  if (values.length < 2) return []
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return []

  const tickCounts = [3, 5, 8, 15]
  const seen = new Set<number>()
  const options: GranularityOption[] = [{ label: 'Exact', value: 'exact' }]

  for (const count of tickCounts) {
    const ticks = niceTicks(min, max, count)
    if (ticks.length < 2) continue
    const step = Math.abs(ticks[1]! - ticks[0]!)
    if (step <= 0 || seen.has(step)) continue
    seen.add(step)

    let label: string
    if (type === 'percent') {
      label = formatCompact(step * 100) + '%'
    } else if (type === 'currency') {
      label = '$' + formatCompact(step)
    } else {
      label = formatCompact(step)
    }
    options.push({ label, value: String(step) })
  }

  return options.length > 1 ? options : []
}

function computeDateGranularities(values: number[]): GranularityOption[] {
  if (values.length < 2) return DATE_GRANULARITIES
  const min = Math.min(...values)
  const max = Math.max(...values)
  const spanMs = max - min

  const HOUR = 3600_000
  const DAY = 86400_000
  const MONTH = 30 * DAY
  const YEAR = 365 * DAY

  const opts: GranularityOption[] = []
  if (spanMs < 2 * YEAR) opts.push({ label: 'Hour', value: 'hour' })
  if (spanMs >= 2 * DAY || spanMs < 2 * YEAR) opts.push({ label: 'Day', value: 'day' })
  if (spanMs >= 2 * MONTH) opts.push({ label: 'Month', value: 'month' })
  if (spanMs >= 2 * YEAR) opts.push({ label: 'Year', value: 'year' })
  return opts.length ? opts : DATE_GRANULARITIES
}

function computeGranularityOptions(data: DatatableData): Map<string, GranularityOption[]> {
  const result = new Map<string, GranularityOption[]>()
  for (const col of data.columns) {
    if (col.type === 'date') {
      const timestamps = data.rows
        .map((r) => new Date(r[col.key] as string | number).getTime())
        .filter((t) => !isNaN(t))
      result.set(col.key, computeDateGranularities(timestamps))
    } else if (col.type === 'number' || col.type === 'currency' || col.type === 'percent') {
      const nums = data.rows
        .map((r) => typeof r[col.key] === 'number' ? r[col.key] as number : Number(r[col.key]))
        .filter((n) => !isNaN(n))
      const opts = computeNumericGranularities(nums, col.type)
      if (opts.length > 0) result.set(col.key, opts)
    }
    // text, badge, boolean → no entry → no sub-menu
  }
  return result
}

function bucketValue(value: unknown, type: ColumnDef['type'], granularity: string): string {
  if (value === null || value === undefined) return '—'

  if (type === 'date') {
    const d = new Date(value as string | number)
    if (isNaN(d.getTime())) return String(value)
    switch (granularity) {
      case 'hour': return d.toLocaleDateString() + ' ' + d.getHours() + ':00'
      case 'day': return d.toLocaleDateString()
      case 'month': return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
      case 'year': return String(d.getFullYear())
    }
  }

  if (type === 'number' || type === 'currency' || type === 'percent') {
    const n = typeof value === 'number' ? value : Number(value)
    if (isNaN(n)) return String(value)
    if (granularity === 'exact') {
      if (type === 'currency') return '$' + n.toLocaleString()
      if (type === 'percent') return (n * 100).toFixed(1) + '%'
      return n.toLocaleString()
    }
    const size = parseFloat(granularity)
    if (!size) return String(n)
    const lo = Math.floor(n / size) * size
    const hi = lo + size
    if (type === 'percent') return `${(lo * 100).toFixed(0)}%–${(hi * 100).toFixed(0)}%`
    if (type === 'currency') return `$${formatCompact(lo)}–$${formatCompact(hi)}`
    return `${formatCompact(lo)}–${formatCompact(hi)}`
  }

  return String(value)
}

function defaultGranularity(type: ColumnDef['type'], options: GranularityOption[]): string {
  if (!options.length) return 'exact'
  if (type === 'date') return options.find((o) => o.value === 'day')?.value ?? options[0]!.value
  // For numeric: pick the second option (first non-Exact) if available
  return options.length > 1 ? options[1]!.value : options[0]!.value
}

// ── Client-side column filters (P0-1 view-state boundary) ────────────────────
//
// View-state operations (filter/sort/group) are the table's own concern —
// they never round-trip through the model. Filter state lives in component
// React state only: ephemeral, never in the datatable spec, never persisted,
// never exported into share URLs. Opt-in via `enableColumnFilters` (GenUICard
// DataTableView); the markdown ```datatable rich block path must behave
// exactly as before.

/** Max distinct text values for which a column still gets filter chips. */
export const DATATABLE_FILTER_CHIP_MAX_DISTINCT = 12

/** One column's active filter: text equality via chip, or a numeric range. */
export type ColumnFilter =
  | { kind: 'text'; value: string }
  | { kind: 'range'; min?: number; max?: number }

/** Active filters keyed by column key. */
export type ColumnFilters = Record<string, ColumnFilter>

export function isNumericFilterColumnType(type?: ColumnDef['type']): boolean {
  return type === 'number' || type === 'currency' || type === 'percent'
}

/**
 * Distinct display values of a text-ish column in first-appearance order,
 * or null when the column has more than `maxDistinct` distinct values (no
 * chips then — avoids chip explosions on free-form columns). Null/undefined
 * cell values never become chips.
 */
export function computeTextFilterChips(
  rows: Record<string, unknown>[],
  columnKey: string,
  maxDistinct: number = DATATABLE_FILTER_CHIP_MAX_DISTINCT,
): string[] | null {
  const seen = new Set<string>()
  for (const row of rows) {
    const value = row[columnKey]
    if (value === null || value === undefined) continue
    seen.add(String(value))
    if (seen.size > maxDistinct) return null
  }
  return [...seen]
}

/** Parse one min/max bound input; empty or non-numeric input → undefined (ignored). */
export function parseFilterBound(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isNaN(parsed) ? undefined : parsed
}

function rowMatchesFilter(row: Record<string, unknown>, columnKey: string, filter: ColumnFilter): boolean {
  const value = row[columnKey]
  if (value === null || value === undefined) return false
  if (filter.kind === 'text') {
    return String(value) === filter.value
  }
  const num = typeof value === 'number' ? value : Number(value)
  if (Number.isNaN(num)) return false
  if (filter.min !== undefined && num < filter.min) return false
  if (filter.max !== undefined && num > filter.max) return false
  return true
}

/** Filters with a concrete constraint set — empty bounds/text are dropped. */
function isConcreteFilter(filter: ColumnFilter): boolean {
  if (filter.kind === 'text') return filter.value !== ''
  return filter.min !== undefined || filter.max !== undefined
}

/** Active (concrete) filters as ordered entries for status rendering. */
export function activeColumnFilterEntries(filters: ColumnFilters): Array<[string, ColumnFilter]> {
  return Object.entries(filters).filter(([, filter]) => isConcreteFilter(filter))
}

/** Apply every concrete filter conjunctively (AND across columns). */
export function applyColumnFilters(
  rows: Record<string, unknown>[],
  filters: ColumnFilters,
): Record<string, unknown>[] {
  const active = activeColumnFilterEntries(filters)
  if (active.length === 0) return rows
  return rows.filter(row => active.every(([key, filter]) => rowMatchesFilter(row, key, filter)))
}

// ── Error boundary ───────────────────────────────────────────────────────────

class DatatableErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownDatatableBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

// ── Main component ───────────────────────────────────────────────────────────

/**
 * Opt-in row-level render hooks. Only the GenUI data-table passes these
 * (GenUICard's DataTableView); the markdown ```datatable rich block never
 * does, and with both undefined the component renders exactly as before.
 *
 * - renderColumnCell replaces a cell's content; it receives the default node
 *   (formatCell output) so callers can wrap it or discard it for a custom one.
 * - renderRowAction appends a trailing, non-sortable, non-exported action
 *   column with one control per row (group headers/empty rows span it).
 */
export interface MarkdownDatatableBlockProps {
  code: string
  className?: string
  renderColumnCell?: (
    col: ColumnDef,
    row: Record<string, unknown>,
    defaultCell: React.ReactNode,
  ) => React.ReactNode
  renderRowAction?: (row: Record<string, unknown>) => React.ReactNode
  /**
   * Opt-in client-side column filters (P0-1 view-state boundary): text
   * columns get value chips (≤12 distinct values), numeric columns get
   * min/max range inputs. Default false — the markdown ```datatable rich
   * block path renders exactly as before. Only GenUICard's DataTableView
   * passes true. Filter state is ephemeral component state: it never enters
   * the spec/schema, is never persisted, and never leaks into export URLs.
   */
  enableColumnFilters?: boolean
}

export function MarkdownDatatableBlock({ code, className, renderColumnCell, renderRowAction, enableColumnFilters = false }: MarkdownDatatableBlockProps) {
  const { t } = useTranslation()
  const { onReadFile } = usePlatform()

  // Parse the inline JSON spec (may have src field for file-backed data)
  const spec = React.useMemo<DatatableSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      // Valid if it has inline data OR a src reference
      if (raw.src || (Array.isArray(raw.columns) && Array.isArray(raw.rows))) {
        return raw as DatatableSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  // Load file data when src is present
  const [fileData, setFileData] = React.useState<DatatableData | null>(null)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [fileLoading, setFileLoading] = React.useState(false)

  React.useEffect(() => {
    if (!spec?.src || !onReadFile) return
    setFileLoading(true)
    setFileError(null)
    onReadFile(spec.src)
      .then((content) => {
        try {
          const raw = JSON.parse(content)
          // File can be full {title, columns, rows} or just a rows array
          if (Array.isArray(raw)) {
            setFileData({ rows: raw, columns: [], title: undefined })
          } else if (raw && typeof raw === 'object') {
            setFileData({
              title: raw.title,
              columns: Array.isArray(raw.columns) ? raw.columns : [],
              rows: Array.isArray(raw.rows) ? raw.rows : [],
            })
          } else {
            setFileError('File does not contain valid datatable data')
          }
        } catch {
          setFileError('Failed to parse data file as JSON')
        }
      })
      .catch((err) => {
        setFileError(err instanceof Error ? err.message : 'Failed to read data file')
      })
      .finally(() => setFileLoading(false))
  }, [spec?.src, onReadFile])

  // Merge: inline spec takes precedence, file provides rows
  const parsed = React.useMemo<DatatableData | null>(() => {
    if (!spec) return null
    if (spec.src) {
      if (!fileData) return null // Still loading or error
      return {
        title: spec.title ?? fileData.title,
        columns: (spec.columns && spec.columns.length > 0) ? spec.columns : fileData.columns,
        rows: fileData.rows,
      }
    }
    // Inline data - must have columns and rows
    if (!Array.isArray(spec.columns) || !Array.isArray(spec.rows)) return null
    return { title: spec.title, columns: spec.columns, rows: spec.rows }
  }, [spec, fileData])

  const [sortKey, setSortKey] = React.useState<string | null>(null)
  const [sortDir, setSortDir] = React.useState<SortDir>(null)
  const [isFullscreen, setIsFullscreen] = React.useState(false)
  const [groupKey, setGroupKey] = React.useState<string | null>(null)
  const [groupGranularity, setGroupGranularity] = React.useState<string>('exact')
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(new Set())
  // Ephemeral column-filter state (P0-1). rangeInputs keeps the raw input
  // strings so a half-typed/invalid bound stays visible in the input but is
  // simply not applied (parseFilterBound drops it).
  const [columnFilters, setColumnFilters] = React.useState<ColumnFilters>({})
  const [rangeInputs, setRangeInputs] = React.useState<Record<string, { min: string; max: string }>>({})
  const { scrollRef, maskImage } = useScrollFade()

  const handleSort = React.useCallback((key: string) => {
    setSortKey((prev) => {
      if (prev !== key) { setSortDir('asc'); return key }
      setSortDir((d) => d === 'asc' ? 'desc' : d === 'desc' ? null : 'asc')
      return key
    })
  }, [])

  // ── Column filter interactions (only reachable when enableColumnFilters) ──

  const toggleTextFilter = React.useCallback((key: string, value: string) => {
    setColumnFilters((prev) => {
      const current = prev[key]
      if (current?.kind === 'text' && current.value === value) {
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: { kind: 'text', value } }
    })
  }, [])

  const setRangeFilter = React.useCallback((key: string, bound: 'min' | 'max', raw: string) => {
    setRangeInputs((prev) => {
      const current = prev[key] ?? { min: '', max: '' }
      return { ...prev, [key]: { ...current, [bound]: raw } }
    })
    const parsed = parseFilterBound(raw)
    setColumnFilters((prev) => {
      const base: { kind: 'range'; min?: number; max?: number } =
        prev[key]?.kind === 'range' ? prev[key] : { kind: 'range' }
      const next: { kind: 'range'; min?: number; max?: number } = { ...base, [bound]: parsed }
      const copy = { ...prev }
      if (next.min === undefined && next.max === undefined) delete copy[key]
      else copy[key] = next
      return copy
    })
  }, [])

  const clearFilters = React.useCallback(() => {
    setColumnFilters({})
    setRangeInputs({})
  }, [])

  // Filter chips per text column (numeric columns use range inputs instead).
  const textChipValues = React.useMemo(() => {
    const map = new Map<string, string[] | null>()
    if (!enableColumnFilters || !parsed) return map
    for (const col of parsed.columns) {
      if (isNumericFilterColumnType(col.type)) continue
      map.set(col.key, computeTextFilterChips(parsed.rows, col.key))
    }
    return map
  }, [enableColumnFilters, parsed])

  // View-state pipeline: filter FIRST, then sort, then group — grouping
  // counts and row actions all see the filtered set (user-visible rows only).
  const filteredRows = React.useMemo(() => {
    if (!parsed) return []
    if (!enableColumnFilters) return parsed.rows
    return applyColumnFilters(parsed.rows, columnFilters)
  }, [parsed, enableColumnFilters, columnFilters])

  const processedRows = React.useMemo(() => {
    let rows = [...filteredRows]
    // Sort
    if (sortKey && sortDir) {
      rows.sort((a, b) => {
        const av = a[sortKey]
        const bv = b[sortKey]
        if (av === bv) return 0
        if (av === null || av === undefined) return 1
        if (bv === null || bv === undefined) return -1
        const cmp = typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv))
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return rows
  }, [filteredRows, sortKey, sortDir])

  const granularityOptions = React.useMemo(() => {
    if (!parsed) return new Map<string, GranularityOption[]>()
    return computeGranularityOptions(parsed)
  }, [parsed])

  const groupedData = React.useMemo(() => {
    if (!groupKey || !parsed) return null
    const col = parsed.columns.find((c) => c.key === groupKey)
    const hasGranularity = granularityOptions.has(groupKey)
    const groups: { value: string; rows: Record<string, unknown>[] }[] = []
    const map = new Map<string, Record<string, unknown>[]>()
    for (const row of processedRows) {
      const val = hasGranularity
        ? bucketValue(row[groupKey], col?.type, groupGranularity)
        : String(row[groupKey] ?? '—')
      if (!map.has(val)) { map.set(val, []); groups.push({ value: val, rows: map.get(val)! }) }
      map.get(val)!.push(row)
    }
    return groups
  }, [processedRows, groupKey, groupGranularity, parsed, granularityOptions])

  const toggleCollapsed = React.useCallback((value: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }, [])

  const activeFilterCount = enableColumnFilters ? activeColumnFilterEntries(columnFilters).length : 0
  const hasActiveControls = (sortKey !== null && sortDir !== null) || groupKey !== null || activeFilterCount > 0

  const clearControls = React.useCallback(() => {
    setSortKey(null)
    setSortDir(null)
    setGroupKey(null)
    setGroupGranularity('exact')
    setCollapsedGroups(new Set())
    setColumnFilters({})
    setRangeInputs({})
  }, [])

  // Loading state for file-backed datatable
  if (spec?.src && fileLoading) {
    return (
      <div className={cn('rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{spec.title || t('datatable.defaultTitle')}</span>
        </div>
        <div className="py-8 text-center text-muted-foreground text-[13px]">{t('datatable.loadingData')}</div>
      </div>
    )
  }

  // Error state for file-backed datatable
  if (spec?.src && fileError) {
    return (
      <div className={cn('rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{spec.title || t('datatable.defaultTitle')}</span>
        </div>
        <div className="py-6 text-center text-destructive/70 text-[13px]">{fileError}</div>
      </div>
    )
  }

  if (!parsed) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  const groupColumnLabel = groupKey ? parsed.columns.find((c) => c.key === groupKey)?.label ?? groupKey : ''

  // The optional GenUI action column widens every grid span by one.
  const columnCount = parsed.columns.length + (renderRowAction ? 1 : 0)

  // Per-column filter control rendered under the header label. Clicks are
  // stopped so they never trigger the th's sort handler.
  const renderColumnFilterControl = (col: ColumnDef) => {
    if (!enableColumnFilters) return null
    const active = columnFilters[col.key]
    if (isNumericFilterColumnType(col.type)) {
      const raw = rangeInputs[col.key] ?? { min: '', max: '' }
      return (
        <div className="mt-1 flex items-center gap-1 whitespace-normal" onClick={(e) => e.stopPropagation()}>
          <input
            type="text"
            inputMode="decimal"
            value={raw.min}
            onChange={(e) => setRangeFilter(col.key, 'min', e.target.value)}
            placeholder={t('datatable.filterMin')}
            aria-label={`${col.label} ${t('datatable.filterMin')}`}
            className="w-14 px-1 py-0.5 text-[11px] rounded-[4px] border border-foreground/10 bg-background text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <span className="text-muted-foreground/50 text-[11px]">–</span>
          <input
            type="text"
            inputMode="decimal"
            value={raw.max}
            onChange={(e) => setRangeFilter(col.key, 'max', e.target.value)}
            placeholder={t('datatable.filterMax')}
            aria-label={`${col.label} ${t('datatable.filterMax')}`}
            className="w-14 px-1 py-0.5 text-[11px] rounded-[4px] border border-foreground/10 bg-background text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </div>
      )
    }
    const chips = textChipValues.get(col.key)
    if (!chips || chips.length === 0) return null
    return (
      <div className="mt-1 flex flex-wrap gap-1 whitespace-normal" onClick={(e) => e.stopPropagation()}>
        {chips.map((chip) => {
          const isActive = active?.kind === 'text' && active.value === chip
          return (
            <button
              key={chip}
              type="button"
              aria-pressed={isActive}
              onClick={() => toggleTextFilter(col.key, chip)}
              className={cn(
                'px-1.5 py-0.5 rounded-[4px] text-[11px] border transition-colors',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                isActive
                  ? 'bg-accent/10 text-accent border-accent/30'
                  : 'bg-background text-muted-foreground border-foreground/10 hover:text-foreground hover:border-foreground/25',
              )}
            >
              {chip}
            </button>
          )
        })}
      </div>
    )
  }

  const renderRows = (rows: Record<string, unknown>[]) =>
    rows.map((row, i) => (
      <tr key={i} className="border-b border-foreground/[0.03] last:border-0 hover:bg-foreground/[0.015] transition-colors">
        {parsed.columns.map((col) => (
          <td key={col.key} className={cn('py-2 px-3 whitespace-nowrap', colAlign(col.type, col.align))}>
            {renderColumnCell
              ? renderColumnCell(col, row, formatCell(row[col.key], col))
              : formatCell(row[col.key], col)}
          </td>
        ))}
        {renderRowAction && (
          <td className="py-2 px-3 whitespace-nowrap text-right">
            {renderRowAction(row)}
          </td>
        )}
      </tr>
    ))

  const tableContent = (maxHeight?: boolean, scrollable?: boolean) => (
    <div
      ref={scrollable ? scrollRef : undefined}
      className={cn(maxHeight && 'max-h-[400px]', 'overflow-y-auto')}
      style={scrollable ? {
        overflowX: 'auto',
        maskImage,
        WebkitMaskImage: maskImage,
      } : { overflowX: 'auto' }}
    >
      <table className="w-max min-w-full text-[13px]">
        <thead>
          <tr className="border-b border-foreground/[0.06] bg-foreground/[0.02]">
            {parsed.columns.map((col) => (
              <th
                key={col.key}
                className={cn('py-2 px-3 text-[12px] cursor-pointer select-none whitespace-nowrap align-top', colAlign(col.type, col.align))}
                onClick={() => handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground transition-colors">
                  {col.label}
                  <SortIcon dir={sortKey === col.key ? sortDir : null} />
                </span>
                {renderColumnFilterControl(col)}
              </th>
            ))}
            {renderRowAction && <th className="py-2 px-3 whitespace-nowrap" aria-hidden="true" />}
          </tr>
        </thead>
        <tbody>
          {groupedData ? groupedData.map((group) => (
            <React.Fragment key={group.value}>
              <tr
                className="cursor-pointer select-none"
                onClick={() => toggleCollapsed(group.value)}
              >
                <td colSpan={columnCount} className="py-2 px-3 bg-foreground/[0.03] border-b border-foreground/[0.06]">
                  <span className="inline-flex items-center gap-2 text-[12px] font-medium text-muted-foreground">
                    <ChevronRight className={cn('w-3 h-3 transition-transform', !collapsedGroups.has(group.value) && 'rotate-90')} />
                    {groupColumnLabel}: {group.value}
                    <span className="text-muted-foreground/50">({group.rows.length})</span>
                  </span>
                </td>
              </tr>
              {!collapsedGroups.has(group.value) && renderRows(group.rows)}
            </React.Fragment>
          )) : processedRows.length ? renderRows(processedRows) : (
            <tr>
              <td colSpan={columnCount} className="py-6 text-center text-muted-foreground text-[13px]">
                No rows
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )

  const renderControlsDropdown = (alwaysVisible?: boolean) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            'p-1 rounded-[6px] transition-all select-none',
            'bg-background shadow-minimal',
            'data-[state=open]:opacity-100',
            hasActiveControls
              ? 'opacity-100 bg-accent/5 text-accent shadow-tinted'
              : alwaysVisible
                ? 'opacity-70 hover:opacity-100 transition-opacity'
                : 'opacity-0 group-hover:opacity-100 text-muted-foreground/50 hover:text-foreground',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
          )}
          title={t('table.tableControls')}
        >
          <ListFilter className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent sideOffset={6} align="end" className="min-w-36" style={{ zIndex: 'var(--z-floating-menu, 400)' }}>
        {/* Sort sub-menu */}
        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <ArrowUpDown />
            <span className="flex-1">{t('table.sortBy')}</span>
            {sortKey && sortDir && <Check className="w-3 h-3 text-accent" />}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent style={{ zIndex: 'calc(var(--z-floating-menu, 400) + 1)' }}>
            {parsed.columns.map((col) => {
              const isActive = sortKey === col.key && sortDir !== null
              return (
                <StyledDropdownMenuItem
                  key={`sort-${col.key}`}
                  onSelect={(e) => { e.preventDefault(); handleSort(col.key) }}
                >
                  <span className={cn('flex-1', isActive && 'text-accent font-medium')}>{col.label}</span>
                  {isActive && <SortIcon dir={sortDir} />}
                </StyledDropdownMenuItem>
              )
            })}
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>
        {/* Group sub-menu */}
        <DropdownMenuSub>
          <StyledDropdownMenuSubTrigger>
            <Group />
            <span className="flex-1">{t('table.groupBy')}</span>
            {groupKey && <Check className="w-3 h-3 text-accent" />}
          </StyledDropdownMenuSubTrigger>
          <StyledDropdownMenuSubContent style={{ zIndex: 'calc(var(--z-floating-menu, 400) + 1)' }}>
            {parsed.columns.map((col) => {
              const isActive = groupKey === col.key
              const opts = granularityOptions.get(col.key)

              // Typed column with granularity options → nested sub-menu
              if (opts && opts.length > 0) {
                return (
                  <DropdownMenuSub key={`group-${col.key}`}>
                    <StyledDropdownMenuSubTrigger>
                      <span className={cn('flex-1', isActive && 'text-accent font-medium')}>{col.label}</span>
                      {isActive && <Check className="w-3 h-3 text-accent" />}
                    </StyledDropdownMenuSubTrigger>
                    <StyledDropdownMenuSubContent style={{ zIndex: 'calc(var(--z-floating-menu, 400) + 2)' }}>
                      {opts.map((opt) => {
                        const optActive = isActive && groupGranularity === opt.value
                        return (
                          <StyledDropdownMenuItem
                            key={opt.value}
                            onSelect={(e) => {
                              e.preventDefault()
                              if (isActive && groupGranularity === opt.value) {
                                setGroupKey(null)
                              } else {
                                setGroupKey(col.key)
                                setGroupGranularity(opt.value)
                              }
                              setCollapsedGroups(new Set())
                            }}
                          >
                            <span className={cn('flex-1', optActive && 'text-accent font-medium')}>{opt.label}</span>
                            {optActive && <Check className="w-3.5 h-3.5 text-accent" />}
                          </StyledDropdownMenuItem>
                        )
                      })}
                    </StyledDropdownMenuSubContent>
                  </DropdownMenuSub>
                )
              }

              // Plain column (text, badge, boolean) → direct click
              return (
                <StyledDropdownMenuItem
                  key={`group-${col.key}`}
                  onSelect={(e) => {
                    e.preventDefault()
                    if (isActive) {
                      setGroupKey(null)
                    } else {
                      setGroupKey(col.key)
                      setGroupGranularity('exact')
                    }
                    setCollapsedGroups(new Set())
                  }}
                >
                  <span className={cn('flex-1', isActive && 'text-accent font-medium')}>{col.label}</span>
                  {isActive && <Check className="w-3.5 h-3.5 text-accent" />}
                </StyledDropdownMenuItem>
              )
            })}
          </StyledDropdownMenuSubContent>
        </DropdownMenuSub>
        {/* Clear */}
        {hasActiveControls && (
          <>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem onSelect={clearControls}>
              <span className="text-accent">{t('common.clearAll')}</span>
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <DatatableErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-hidden border bg-muted/10', className)}>
        {/* Control button */}
        <div className="absolute top-[7px] right-10 z-10">
          {renderControlsDropdown()}
        </div>

        {/* Expand button */}
        <button
          onClick={() => setIsFullscreen(true)}
          className={cn(
            "absolute top-[7px] right-2 p-1 rounded-[6px] transition-all z-10 select-none",
            "bg-background shadow-minimal",
            hasActiveControls ? "opacity-100" : "opacity-0 group-hover:opacity-100",
            "text-muted-foreground/50 hover:text-foreground",
            "focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100"
          )}
          title={t('common.viewFullscreen')}
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>

        {/* Header */}
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">
            {parsed.title || t('datatable.defaultTitle')}
          </span>
        </div>

        {/* Active filter status (P0-1 view-state, ephemeral) */}
        {activeFilterCount > 0 && (
          <div className="px-3 py-1.5 border-b bg-accent/[0.04] flex items-center justify-between gap-2">
            <span className="text-[12px] text-muted-foreground">
              {t('datatable.filterStatus', { shown: filteredRows.length, total: parsed.rows.length })}
            </span>
            <button
              type="button"
              onClick={clearFilters}
              className="text-[12px] text-accent hover:underline rounded focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {t('common.clearAll')}
            </button>
          </div>
        )}

        {/* Table with max height and scroll fade */}
        {tableContent(true, true)}
      </div>

      {/* Fullscreen overlay */}
      <DataTableOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        title={parsed.title || t('datatable.defaultTitle')}
        subtitle={t('datatable.rowCount', { count: parsed.rows.length })}
        headerActions={
          <div className="flex items-center gap-1.5">
            {renderControlsDropdown(true)}
            <TableExportDropdown columns={parsed.columns} rows={parsed.rows} filename={parsed.title || t('datatable.defaultTitle')} />
          </div>
        }
      >
        <div className="px-6">
          <div className="bg-background shadow-minimal rounded-[12px] overflow-hidden">
            {tableContent(false)}
          </div>
        </div>
      </DataTableOverlay>
    </DatatableErrorBoundary>
  )
}
