/**
 * GenUICard - Renders declarative inline cards produced by the render_ui tool.
 *
 * The model sends a small payload ({ components: [...] }); this component
 * dispatches each entry to its registered renderer. The registry ships six
 * component types (stat-card, data-table, alert, progress, action-buttons,
 * form) statically
 * data directory via MarkdownDatatableBlock's existing file-loading path.
 *
 * Unrecognized component types (newer registry entries on other app versions)
 * and components whose renderer throws fall back to a read-only JSON view so
 * the information is never lost.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'
import { usePlatform } from '../../context/PlatformContext'
import { MarkdownDatatableBlock, formatNeutralPercent } from '../markdown/MarkdownDatatableBlock'

// ── Payload types (renderer-side mirror of the render_ui tool schema) ────────

export type GenUiTrend = 'up' | 'down' | 'flat'
export type GenUiStatValueFormat = 'number' | 'percent' | 'currency'
export type GenUiGoodWhen = 'up' | 'down' | 'neutral'

export interface GenUiStatCard {
  type: 'stat-card'
  id: string
  title?: string
  label: string
  value: string | number
  /** How to render `value`; omit to display it verbatim (e.g. with a unit). */
  format?: GenUiStatValueFormat
  /** Currency symbol/code for format 'currency' ('$' renders as $1,234; a multi-char code gets a space: CNY 1,234). */
  currency?: string
  unit?: string
  /** Decimal fraction per the tool schema (0.152 = +15.2%). */
  delta?: number
  trend?: GenUiTrend
  /** Which delta direction is good news; drives the delta color, default 'up'. */
  goodWhen?: GenUiGoodWhen
}

export interface GenUiTableColumn {
  key: string
  label: string
  type?: 'text' | 'number' | 'currency' | 'percent' | 'boolean' | 'date' | 'badge'
  /** percent columns: 'change' (default) renders signed + green/red; 'rate'/'share' render unsigned + neutral. */
  semantics?: 'rate' | 'share' | 'change'
  /** badge columns: cell value → chip color; unmatched values stay neutral. */
  badgeColors?: Record<string, 'info' | 'success' | 'warning' | 'error'>
  /** Source-link column: values render as links opened via PlatformActions.onOpenUrl (iter/row-actions). */
  link?: boolean
}

/** Optional per-row action button on a data-table (iter/row-actions). */
export interface GenUiDataTableRowAction {
  label: string
  promptTemplate: string
}

export interface GenUiDataTable {
  type: 'data-table'
  id: string
  title?: string
  columns: GenUiTableColumn[]
  src: string
  pageSize?: number
  /** Per-row action button: {{col.key}} placeholders are filled from the clicked row and the prompt is sent. */
  rowAction?: GenUiDataTableRowAction
  /** Per-row drill-down: filled template prefills the chat input (fill semantics — no send). */
  detailTemplate?: string
}

export interface GenUiAlert {
  type: 'alert'
  id: string
  title?: string
  severity: 'info' | 'success' | 'warning' | 'error'
  message: string
}

export interface GenUiProgress {
  type: 'progress'
  id: string
  title?: string
  status: 'running' | 'success' | 'error'
  label: string
  percent?: number
}

export interface GenUiActionButtonParam {
  key: string
  label: string
  type: 'text' | 'number' | 'select'
  required?: boolean
  options?: string[]
}

export interface GenUiActionButton {
  id: string
  label: string
  style: 'primary' | 'secondary' | 'danger'
  confirm?: { message: string }
  params?: GenUiActionButtonParam[]
  action:
    | { kind: 'send-message'; prompt?: string; promptTemplate?: string }
    | { kind: 'fill-input'; text: string }
}

export interface GenUiActionButtons {
  type: 'action-buttons'
  id: string
  title?: string
  buttons: GenUiActionButton[]
}

export interface GenUiFormField {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'date'
  required?: boolean
  options?: string[]
}

export interface GenUiForm {
  type: 'form'
  id: string
  title?: string
  fields: GenUiFormField[]
  submitLabel?: string
}

export type GenUiComponent =
  | GenUiStatCard
  | GenUiDataTable
  | GenUiAlert
  | GenUiProgress
  | GenUiActionButtons
  | GenUiForm

// ── Tolerant parsing (models may emit slightly-off shapes; never crash) ──────

/**
 * Extract render_ui components from an arbitrary tool-input value.
 * Accepts `{ components: [...] }` or a bare array; silently drops entries
 * without a usable id instead of throwing. The `type` field is deliberately
 * NOT filtered here — unknown types must survive parsing so the registry can
 * fall back to the read-only JSON view (GenUiUnknownFallback) instead of
 * silently losing the payload (e.g. a newer registry entry on another app
 * version).
 */
export function parseGenUiComponents(input: unknown): GenUiComponent[] {
  let raw: unknown
  if (Array.isArray(input)) {
    raw = input
  } else if (input && typeof input === 'object' && Array.isArray((input as { components?: unknown }).components)) {
    raw = (input as { components: unknown[] }).components
  } else {
    return []
  }
  const out: GenUiComponent[] = []
  for (const entry of raw as unknown[]) {
    if (!entry || typeof entry !== 'object') continue
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string' || id.length === 0) continue
    out.push(entry as GenUiComponent)
  }
  return out
}

/**
 * Merge components across successive render_ui calls in one turn.
 * First-seen order wins; a later call with the same id overrides the earlier
 * entry in place (update semantics) rather than appending a duplicate.
 */
export function mergeGenUiComponents(groups: GenUiComponent[][]): GenUiComponent[] {
  const byId = new Map<string, GenUiComponent>()
  const order: string[] = []
  for (const group of groups) {
    for (const component of group) {
      if (!byId.has(component.id)) order.push(component.id)
      byId.set(component.id, component)
    }
  }
  return order.map(id => byId.get(id)!)
}

// ── Per-component error boundary ─────────────────────────────────────────────

class GenUiComponentErrorBoundary extends React.Component<
  { children: React.ReactNode; componentId: string },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[GenUICard] Component render failed, showing placeholder:', error)
  }
  componentDidUpdate(prev: { componentId: string }) {
    // Reset so a merged update can retry rendering after a failure
    if (prev.componentId !== this.props.componentId && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }
  render() {
    if (this.state.hasError) return <GenUiErrorPlaceholder componentId={this.props.componentId} />
    return this.props.children
  }
}

function GenUiErrorPlaceholder({ componentId }: { componentId: string }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-[8px] border border-destructive/20 bg-destructive/[0.04] px-3 py-2.5 flex items-start gap-2">
      <AlertTriangle className="w-3.5 h-3.5 text-destructive/70 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-[12px] font-medium text-destructive/80">{t('genui.componentError')}</div>
        <div className="text-[11px] text-muted-foreground/70 truncate">{componentId}</div>
      </div>
    </div>
  )
}

/** Read-only JSON fallback for unknown types or registry misses */
function GenUiUnknownFallback({ component }: { component: Record<string, unknown> }) {
  const { t } = useTranslation()
  return (
    <div className="rounded-[8px] overflow-hidden border bg-muted/10">
      <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-1.5">
        <AlertTriangle className="w-3 h-3 text-muted-foreground/60" />
        <span className="text-[12px] text-muted-foreground font-medium">
          {t('genui.unknownType', { type: String(component.type ?? '') })}
        </span>
      </div>
      <pre className="px-3 py-2 text-[11px] leading-relaxed text-muted-foreground overflow-x-auto select-text max-h-[240px]">
        {JSON.stringify(component, null, 2)}
      </pre>
    </div>
  )
}

// ── Button actions (chat input bridge) ───────────────────────────────────────

export function dispatchGenUiInsertText(text: string, sessionId: string): void {
  window.dispatchEvent(new CustomEvent('craft:insert-text', { detail: { text, sessionId } }))
}

export function dispatchGenUiSubmitInput(sessionId: string): void {
  window.dispatchEvent(new CustomEvent('craft:submit-input', { detail: { sessionId } }))
}

// ── Row-level template fill and source links (iter/row-actions) ──────────────

const GENUI_HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * HTML-escape a value string for attribute/text rendering contexts
 * (defense in depth — row values are model/data-controlled).
 */
export function escapeGenUiHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => GENUI_HTML_ESCAPES[ch]!)
}

export interface GenUiTemplateFill {
  /** Raw filled text — the string dispatched into the chat-input pipeline. */
  text: string
  /** HTML-escaped filled text — for title/attribute contexts. */
  escapedText: string
  /** Placeholder keys whose row value was missing (the placeholder became ''). */
  missingKeys: string[]
}

/**
 * Fill `{{col.key}}` placeholders in a rowAction/detailTemplate from a
 * data-table row. A missing value (absent key, null/undefined/'') makes the
 * placeholder the empty string and is reported in missingKeys so the button
 * title can hint at the gap; unknown placeholders therefore degrade to ''.
 *
 * `text` keeps the RAW values — the chat input pipeline is plain text, and
 * sending escaped entities would corrupt the prompt (e.g. "AT&T" must not
 * become "AT&amp;T"). `escapedText` carries the HTML-escaped variant for
 * rendering contexts. Object values serialize as JSON.
 */
export function fillGenUiTemplate(template: string, row: Record<string, unknown>): GenUiTemplateFill {
  const missingKeys: string[] = []
  let text = ''
  let escapedText = ''
  let lastIndex = 0
  for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const literal = template.slice(lastIndex, match.index)
    text += literal
    escapedText += escapeGenUiHtml(literal)
    const key = match[1]!.trim()
    const value = row[key]
    if (value === null || value === undefined || value === '') {
      missingKeys.push(key)
    } else {
      const raw = typeof value === 'object' ? JSON.stringify(value) : String(value)
      text += raw
      escapedText += escapeGenUiHtml(raw)
    }
    lastIndex = match.index! + match[0].length
  }
  const tail = template.slice(lastIndex)
  text += tail
  escapedText += escapeGenUiHtml(tail)
  return { text, escapedText, missingKeys }
}

export interface GenUiCellLink {
  href: string
  /** Display override when the row value is a { value, link } object. */
  label?: string
}

/**
 * Only http(s) may reach the platform URL handler: data-table cells are
 * model/data-controlled, so javascript:/data:/vbscript: (and non-URLs) never
 * open. Same policy as the markdown renderer's default URL transform.
 */
export function isSafeGenUiHref(href: string): boolean {
  try {
    const url = new URL(href)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Resolve the link behind a link-column cell: the row value is either the URL
 * itself, or an object carrying the URL on its `link` field (the model's way
 * to give e.g. a clause number its source document) with an optional display
 * override on `value`/`text`/`label`. Returns null when nothing safely
 * linkable is present — the caller falls back to the default cell rendering.
 */
export function resolveGenUiCellLink(value: unknown): GenUiCellLink | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const link = (value as { link?: unknown }).link
    if (typeof link === 'string' && isSafeGenUiHref(link.trim())) {
      const display = (value as { value?: unknown; text?: unknown; label?: unknown }).value
        ?? (value as { text?: unknown }).text
        ?? (value as { label?: unknown }).label
      return {
        href: link.trim(),
        label: display === null || display === undefined ? undefined : String(display),
      }
    }
    return null
  }
  if (value === null || value === undefined || Array.isArray(value)) return null
  const raw = String(value).trim()
  if (raw === '' || !isSafeGenUiHref(raw)) return null
  return { href: raw }
}

// ── Button gates (confirm / params — iter/confirm-flow) ─────────────────────

/**
 * Replace `{{key}}` occurrences with the user-filled values. Values are used
 * trimmed; a placeholder whose key was not filled (optional param left blank,
 * or a key the schema never declared) is left visible rather than silently
 * emptied — the model sees exactly what the user saw.
 */
export function interpolateGenUiTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (placeholder, key: string) => {
    const value = values[key]
    return value === undefined ? placeholder : value.trim()
  })
}

/** Keys of required params left blank (empty or whitespace-only). */
export function missingGenUiParamKeys(params: GenUiActionButtonParam[], values: Record<string, string>): string[] {
  return params
    .filter(param => param.required && !(values[param.key] ?? '').trim())
    .map(param => param.key)
}

/** The backfilled text for an action: the template interpolated, prompt, or fill text. */
export function resolveGenUiActionButtonText(
  action: GenUiActionButton['action'],
  values: Record<string, string> = {},
): string {
  if (action.kind === 'fill-input') return action.text
  return action.promptTemplate ? interpolateGenUiTemplate(action.promptTemplate, values) : action.prompt ?? ''
}

export type GenUiButtonPress =
  | { gate: 'params' }
  | { gate: 'confirm' }
  | { gate: 'execute'; text: string }

/**
 * What a click on the button does next: open the params mini form when the
 * button declares params, else the confirm bar when it declares confirm, else
 * execute directly. Cancel (collapsing the open panel) never reaches the
 * backfill pipeline — execution only happens through an explicit
 * `{ gate: 'execute' }` plan.
 */
export function planGenUiButtonPress(button: GenUiActionButton, values: Record<string, string> = {}): GenUiButtonPress {
  if (button.params && button.params.length > 0) return { gate: 'params' }
  if (button.confirm) return { gate: 'confirm' }
  return { gate: 'execute', text: resolveGenUiActionButtonText(button.action, values) }
}

export type GenUiParamsSubmitPlan =
  | { ok: false; missing: string[] }
  | { ok: true; gate: 'confirm' }
  | { ok: true; gate: 'execute'; text: string }

/** The params form 执行 button: intercept missing required values, else advance to the next gate. */
export function planGenUiParamsSubmit(button: GenUiActionButton, values: Record<string, string>): GenUiParamsSubmitPlan {
  const missing = missingGenUiParamKeys(button.params ?? [], values)
  if (missing.length > 0) return { ok: false, missing }
  if (button.confirm) return { ok: true, gate: 'confirm' }
  return { ok: true, gate: 'execute', text: resolveGenUiActionButtonText(button.action, values) }
}

// ── Component renderers ──────────────────────────────────────────────────────

/**
 * The schema sends a decimal fraction (0.152 = +15.2%); render it as a signed
 * percentage so the sign is never lost on positive deltas.
 */
export function formatStatDelta(delta: number): string {
  const percent = Math.round(delta * 1000) / 10
  return `${percent > 0 ? '+' : ''}${percent}%`
}

/**
 * Render a stat-card `value` per the optional `format` hint: 'percent' treats
 * the schema's decimal fraction as a share (0.093 → 9.3%), 'number' and
 * 'currency' add thousands separators ('currency' prefixed by the declared
 * symbol — a multi-char code gets a separating space). Without `format` (or
 * when the value does not survive numeric coercion) the value shows verbatim,
 * so a formatted stat can never blank out or double-render a unit.
 */
export function formatStatValue(
  value: string | number,
  format?: GenUiStatValueFormat,
  currency?: string,
): string {
  if (!format) return String(value)
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return String(value)
  switch (format) {
    case 'percent':
      return formatNeutralPercent(num)
    case 'currency': {
      const prefix = currency && currency.length > 0 ? currency : ''
      const separator = prefix.length > 1 ? ' ' : ''
      return `${prefix}${separator}${num.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    }
    case 'number':
    default:
      return num.toLocaleString('en-US')
  }
}

/**
 * Delta color sentiment from the trend arrow and the declared `goodWhen`
 * direction. Default 'up' reproduces the historical mapping (rises green,
 * falls red); 'down' inverts it (queues, error rates, costs — a rise is bad);
 * 'neutral' mutes the color. The arrow icon itself always shows the real
 * direction — only the color flips. No trend (or flat) stays muted.
 */
export function resolveStatDeltaTone(
  trend: GenUiTrend | undefined,
  goodWhen: GenUiGoodWhen | undefined,
): 'success' | 'destructive' | 'muted' {
  if (!trend || trend === 'flat' || goodWhen === 'neutral') return 'muted'
  const up = trend === 'up'
  const good = goodWhen === 'down' ? !up : up
  return good ? 'success' : 'destructive'
}

function StatCardView({ component }: { component: GenUiStatCard }) {
  const deltaTone = resolveStatDeltaTone(component.trend, component.goodWhen)
  return (
    <div className="rounded-[8px] overflow-hidden border bg-muted/10">
      {component.title && (
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{component.title}</span>
        </div>
      )}
      <div className="px-3 py-2.5 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12px] text-muted-foreground truncate">{component.label}</div>
          <div className="text-[20px] font-semibold tabular-nums leading-tight truncate">
            {formatStatValue(component.value, component.format, component.currency)}
            {component.unit && <span className="text-[13px] font-normal text-muted-foreground ml-1">{component.unit}</span>}
          </div>
        </div>
        {component.delta !== undefined && (
          <span className={cn(
            'shrink-0 inline-flex items-center gap-1 text-[12px] font-medium tabular-nums',
            deltaTone === 'success' && 'text-success',
            deltaTone === 'destructive' && 'text-destructive',
            deltaTone === 'muted' && 'text-muted-foreground',
          )}>
            {component.trend === 'up' && <TrendingUp className="w-3 h-3" />}
            {component.trend === 'down' && <TrendingDown className="w-3 h-3" />}
            {(!component.trend || component.trend === 'flat') && <Minus className="w-3 h-3" />}
            {formatStatDelta(component.delta)}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * The spec JSON handed to MarkdownDatatableBlock. Row-action/detail/link
 * behavior deliberately stays OUT of the spec (the block renders data only;
 * behavior is attached via its optional render hooks), so a plain table's
 * spec is identical to the pre-row-actions payload.
 */
export function buildGenUiDataTableSpec(component: GenUiDataTable): string {
  return JSON.stringify({
    src: component.src,
    title: component.title,
    columns: component.columns,
  })
}

// Row-level controls share the card's tinted accent language (same tokens as
// ACTION_BUTTON_STYLES), densified for table rows.
const GENUI_ROW_LINK_STYLES = cn(
  'text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent',
  'transition-colors rounded-[2px]',
  'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:no-underline',
)

const GENUI_ROW_ACTION_STYLES = cn(
  'h-[22px] px-2 text-[11px] font-medium rounded-[5px] transition-all',
  'bg-accent/5 text-accent hover:bg-accent/10 shadow-tinted',
  'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
  'disabled:opacity-50 disabled:cursor-not-allowed',
)

/**
 * Delegates to MarkdownDatatableBlock by building its file-backed spec JSON.
 * Rows always come from the `src` file (the schema forbids inline rows);
 * the GenUI pageSize hint is not forwarded — the block's own scroll/max-height
 * behavior applies.
 *
 * Row-level extras (iter/row-actions) are attached via the block's optional
 * render hooks; a table without any renders through the unchanged plain path.
 */
function DataTableView({ component, sessionId }: { component: GenUiDataTable; sessionId?: string }) {
  const { t } = useTranslation()
  const { onOpenUrl } = usePlatform()

  const spec = buildGenUiDataTableSpec(component)
  const hasRowExtras = component.rowAction !== undefined
    || component.detailTemplate !== undefined
    || component.columns.some(col => col.link === true)
  if (!hasRowExtras) return <MarkdownDatatableBlock code={spec} />

  const { rowAction, detailTemplate, columns } = component
  const firstColumnKey = columns[0]?.key

  /** Button title: the escaped filled template, plus a hint when values were missing. */
  const rowButtonTitle = (fill: GenUiTemplateFill): string =>
    fill.missingKeys.length > 0
      ? `${fill.escapedText} (${t('genui.dataTable.rowValuesMissing')})`
      : fill.escapedText

  // 「详情」 drill-down — fill semantics: prefill the input, never auto-send.
  const renderDetailButton = detailTemplate === undefined
    ? undefined
    : (row: Record<string, unknown>) => {
      const fill = fillGenUiTemplate(detailTemplate, row)
      return (
        <button
          type="button"
          disabled={!sessionId}
          title={!sessionId ? undefined : rowButtonTitle(fill)}
          onClick={() => { if (sessionId) dispatchGenUiInsertText(fill.text, sessionId) }}
          className={GENUI_ROW_LINK_STYLES}
        >
          {t('genui.dataTable.rowDetail')}
        </button>
      )
    }

  return (
    <MarkdownDatatableBlock
      code={spec}
      renderColumnCell={(col, row, defaultCell) => {
        // Drill-down lives in the first column, next to the default cell.
        const detailButton = col.key === firstColumnKey ? renderDetailButton?.(row) : undefined
        if (col.link === true) {
          const link = resolveGenUiCellLink(row[col.key])
          if (link) {
            const raw = row[col.key]
            const display = link.label
              ?? (raw === null || raw === undefined ? '' : String(raw))
            const linkButton = (
              <button
                type="button"
                disabled={!onOpenUrl}
                title={link.href}
                onClick={() => { if (onOpenUrl) onOpenUrl(link.href) }}
                className={GENUI_ROW_LINK_STYLES}
              >
                {display}
              </button>
            )
            return detailButton
              ? <span className="inline-flex items-center gap-2">{linkButton}{detailButton}</span>
              : linkButton
          }
        }
        if (detailButton) {
          return <span className="inline-flex items-center gap-2">{defaultCell}{detailButton}</span>
        }
        return defaultCell
      }}
      renderRowAction={rowAction === undefined
        ? undefined
        : (row) => {
          const fill = fillGenUiTemplate(rowAction.promptTemplate, row)
          return (
            <button
              type="button"
              disabled={!sessionId || fill.text.trim() === ''}
              title={!sessionId ? undefined : rowButtonTitle(fill)}
              onClick={() => {
                if (!sessionId) return
                dispatchGenUiInsertText(fill.text, sessionId)
                dispatchGenUiSubmitInput(sessionId)
              }}
              className={GENUI_ROW_ACTION_STYLES}
            >
              {rowAction.label}
            </button>
          )
        }}
    />
  )
}

// `warning` maps to the amber `info` token — the theme has no separate warning color
const ALERT_SEVERITY_STYLES: Record<GenUiAlert['severity'], string> = {
  info: 'border-accent/20 bg-accent/[0.04] text-accent',
  success: 'border-success/20 bg-success/[0.04] text-success',
  warning: 'border-info/20 bg-info/[0.04] text-info',
  error: 'border-destructive/20 bg-destructive/[0.04] text-destructive',
}

function AlertView({ component }: { component: GenUiAlert }) {
  return (
    <div className={cn('rounded-[8px] border px-3 py-2.5 flex items-start gap-2', ALERT_SEVERITY_STYLES[component.severity])}>
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 opacity-70" />
      <div className="min-w-0">
        {component.title && <div className="text-[12px] font-medium">{component.title}</div>}
        <div className="text-[13px] leading-snug select-text text-foreground/80">
          {component.message}
        </div>
      </div>
    </div>
  )
}

const PROGRESS_STATUS_STYLES: Record<GenUiProgress['status'], { bar: string; text: string }> = {
  running: { bar: 'bg-accent', text: 'text-muted-foreground' },
  success: { bar: 'bg-success', text: 'text-success' },
  error: { bar: 'bg-destructive', text: 'text-destructive' },
}

function ProgressView({ component }: { component: GenUiProgress }) {
  const styles = PROGRESS_STATUS_STYLES[component.status]
  const percent = typeof component.percent === 'number' && component.percent >= 0 && component.percent <= 100
    ? component.percent
    : undefined
  return (
    <div className="rounded-[8px] overflow-hidden border bg-muted/10">
      {component.title && (
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{component.title}</span>
        </div>
      )}
      <div className="px-3 py-2.5 space-y-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className={cn('text-[13px] truncate', styles.text)}>{component.label}</span>
          {percent !== undefined && (
            <span className="shrink-0 text-[12px] text-muted-foreground tabular-nums">{Math.round(percent)}%</span>
          )}
        </div>
        <div className="h-1 rounded-full bg-muted overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all', styles.bar)}
            style={{ width: percent !== undefined ? `${percent}%` : undefined }}
          />
        </div>
      </div>
    </div>
  )
}

const ACTION_BUTTON_STYLES: Record<GenUiActionButton['style'], string> = {
  primary: 'bg-accent/5 text-accent hover:bg-accent/10 shadow-tinted',
  secondary: 'bg-background text-foreground/80 hover:bg-muted shadow-minimal border border-foreground/[0.06]',
  danger: 'bg-destructive/5 text-destructive hover:bg-destructive/10 shadow-tinted',
}

/** In-place panel opened by a click on a confirm/params button (session-local React state, never persisted). */
type GenUiExpandedPanel = { buttonId: string; stage: 'params' | 'confirm' } | null

const GENUI_ACTION_BAR_STYLES: Record<'accent' | 'destructive', string> = {
  accent: 'border-accent/20 bg-accent/[0.04]',
  destructive: 'border-destructive/20 bg-destructive/[0.04]',
}

function ActionButtonsView({ component, sessionId }: { component: GenUiActionButtons; sessionId?: string }) {
  const { t } = useTranslation()
  // Session-render-cycle state only: which button's panel is open, what the
  // user typed into it, which buttons already fired (receipt state). Nothing
  // here is persisted — a remounted card starts fresh.
  const [panel, setPanel] = React.useState<GenUiExpandedPanel>(null)
  const [paramValues, setParamValues] = React.useState<Record<string, Record<string, string>>>({})
  const [missingParams, setMissingParams] = React.useState<ReadonlySet<string>>(() => new Set())
  // buttonId → the exact text that was backfilled, so the disabled button's
  // title keeps showing the receipt even if the card is updated in place.
  const [executedTexts, setExecutedTexts] = React.useState<ReadonlyMap<string, string>>(() => new Map())

  const execute = React.useCallback((button: GenUiActionButton, text: string) => {
    if (!sessionId) return
    dispatchGenUiInsertText(text, sessionId)
    if (button.action.kind === 'send-message') {
      dispatchGenUiSubmitInput(sessionId)
    }
    setExecutedTexts(previous => new Map(previous).set(button.id, text))
    setPanel(null)
    setMissingParams(new Set())
  }, [sessionId])

  const handleButtonClick = React.useCallback((button: GenUiActionButton) => {
    if (!sessionId || executedTexts.has(button.id)) return
    const press = planGenUiButtonPress(button, paramValues[button.id] ?? {})
    if (press.gate === 'execute') {
      execute(button, press.text)
    } else {
      setMissingParams(new Set())
      setPanel({ buttonId: button.id, stage: press.gate })
    }
  }, [execute, executedTexts, paramValues, sessionId])

  const handleParamChange = React.useCallback((buttonId: string, key: string, value: string) => {
    setParamValues(previous => ({ ...previous, [buttonId]: { ...previous[buttonId], [key]: value } }))
    setMissingParams(previous => {
      if (!previous.has(key)) return previous
      const next = new Set(previous)
      next.delete(key)
      return next
    })
  }, [])

  const handleParamsSubmit = React.useCallback((button: GenUiActionButton) => {
    if (!sessionId) return
    const plan = planGenUiParamsSubmit(button, paramValues[button.id] ?? {})
    if (!plan.ok) {
      setMissingParams(new Set(plan.missing))
      return
    }
    if (plan.gate === 'confirm') {
      setPanel({ buttonId: button.id, stage: 'confirm' })
      return
    }
    execute(button, plan.text)
  }, [execute, paramValues, sessionId])

  const collapsePanel = React.useCallback(() => {
    setPanel(null)
    setMissingParams(new Set())
  }, [])

  const openPanelButton = panel ? component.buttons.find(button => button.id === panel.buttonId) : undefined

  return (
    <div className="rounded-[8px] overflow-hidden border bg-muted/10">
      {component.title && (
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{component.title}</span>
        </div>
      )}
      <div className="px-3 py-2.5 flex flex-wrap gap-2">
        {component.buttons.map(button => {
          const executedText = executedTexts.get(button.id)
          return (
            <button
              key={button.id}
              type="button"
              disabled={!sessionId || executedText !== undefined}
              onClick={() => handleButtonClick(button)}
              title={!sessionId
                ? undefined
                : executedText !== undefined
                  ? executedText
                  : button.action.kind === 'send-message'
                    ? button.action.prompt ?? button.action.promptTemplate
                    : button.action.text}
              className={cn(
                'h-[28px] px-3 text-xs font-medium rounded-[6px] transition-all',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                ACTION_BUTTON_STYLES[button.style],
              )}
            >
              {executedText !== undefined ? `${t('genui.actions.executed')} ✓` : button.label}
            </button>
          )
        })}
      </div>
      {openPanelButton && panel && sessionId && (
        panel.stage === 'confirm' ? (
          <div className={cn(
            'px-3 py-2.5 border-t flex flex-wrap items-center gap-2',
            GENUI_ACTION_BAR_STYLES[openPanelButton.style === 'danger' ? 'destructive' : 'accent'],
          )}>
            <span className="text-[12px] leading-snug text-foreground/80 min-w-0 flex-1 select-text">
              {openPanelButton.confirm?.message}
            </span>
            <button
              type="button"
              onClick={() => execute(openPanelButton, resolveGenUiActionButtonText(openPanelButton.action, paramValues[openPanelButton.id] ?? {}))}
              className={cn(
                'h-[28px] px-3 text-xs font-medium rounded-[6px] transition-all shrink-0',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                openPanelButton.style === 'danger' ? ACTION_BUTTON_STYLES.danger : ACTION_BUTTON_STYLES.primary,
              )}
            >
              {t('genui.actions.confirm')}
            </button>
            <button
              type="button"
              onClick={collapsePanel}
              className={cn(
                'h-[28px] px-3 text-xs font-medium rounded-[6px] transition-all shrink-0',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                ACTION_BUTTON_STYLES.secondary,
              )}
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <form
            onSubmit={event => {
              event.preventDefault()
              handleParamsSubmit(openPanelButton)
            }}
            className="px-3 py-2.5 border-t space-y-2"
          >
            {(openPanelButton.params ?? []).map(param => (
              <label key={param.key} className="block space-y-1">
                <span className="flex items-baseline gap-1 text-[11px] text-muted-foreground">
                  {param.label}
                  {param.required && <span className="text-destructive/80">*</span>}
                </span>
                {param.type === 'select' ? (
                  <select
                    className={FORM_FIELD_STYLES}
                    value={paramValues[openPanelButton.id]?.[param.key] ?? ''}
                    onChange={event => handleParamChange(openPanelButton.id, param.key, event.target.value)}
                  >
                    <option value=""></option>
                    {(param.options ?? []).map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={param.type === 'number' ? 'number' : 'text'}
                    className={FORM_FIELD_STYLES}
                    value={paramValues[openPanelButton.id]?.[param.key] ?? ''}
                    onChange={event => handleParamChange(openPanelButton.id, param.key, event.target.value)}
                  />
                )}
                {missingParams.has(param.key) && (
                  <span className="block text-[10px] text-destructive/80">{t('genui.form.requiredMissing')}</span>
                )}
              </label>
            ))}
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                className={cn(
                  'h-[28px] px-3 text-xs font-medium rounded-[6px] transition-all',
                  'bg-accent/5 text-accent hover:bg-accent/10 shadow-tinted',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                )}
              >
                {t('genui.actions.execute')}
              </button>
              <button
                type="button"
                onClick={collapsePanel}
                className={cn(
                  'h-[28px] px-3 text-xs font-medium rounded-[6px] transition-all',
                  'bg-background text-foreground/80 hover:bg-muted shadow-minimal border border-foreground/[0.06]',
                  'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                )}
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        )
      )}
    </div>
  )
}

// ── Form (POO-103) ───────────────────────────────────────────────────────────

const FORM_FIELD_STYLES = cn(
  'h-[28px] w-full px-2 text-xs rounded-[6px] border border-foreground/[0.08] bg-background',
  'text-foreground placeholder:text-muted-foreground/60',
  'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
)

/**
 * Form card: user-filled inputs whose submit serializes the values object and
 * sends it as the next user message — the same craft: insert+submit backfill
 * pipeline action-buttons use (fixed send-message semantics per the tool
 * contract; no per-form action configuration).
 */
function FormView({ component, sessionId }: { component: GenUiForm; sessionId?: string }) {
  const { t } = useTranslation()
  const [values, setValues] = React.useState<Record<string, string>>({})
  const [missingKeys, setMissingKeys] = React.useState<Set<string>>(() => new Set())

  const setValue = React.useCallback((key: string, value: string) => {
    setValues(previous => ({ ...previous, [key]: value }))
    setMissingKeys(previous => {
      if (!previous.has(key)) return previous
      const next = new Set(previous)
      next.delete(key)
      return next
    })
  }, [])

  const handleSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault()
    if (!sessionId) return
    const absentRequired = component.fields.filter(field => field.required && !(values[field.key] ?? '').trim())
    if (absentRequired.length > 0) {
      setMissingKeys(new Set(absentRequired.map(field => field.key)))
      return
    }
    setMissingKeys(new Set())
    // Numbers serialize as JSON numbers; empty fields are omitted entirely so
    // the model receives only what the user actually entered.
    const payload: Record<string, string | number> = {}
    for (const field of component.fields) {
      const raw = (values[field.key] ?? '').trim()
      if (raw === '') continue
      payload[field.key] = field.type === 'number' && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw
    }
    dispatchGenUiInsertText(JSON.stringify(payload), sessionId)
    dispatchGenUiSubmitInput(sessionId)
  }, [component.fields, sessionId, values])

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-[8px] overflow-hidden border bg-muted/10"
    >
      {component.title && (
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{component.title}</span>
        </div>
      )}
      <div className="px-3 py-2.5 space-y-2">
        {component.fields.map(field => (
          <label key={field.key} className="block space-y-1">
            <span className="flex items-baseline gap-1 text-[11px] text-muted-foreground">
              {field.label}
              {field.required && <span className="text-destructive/80">*</span>}
            </span>
            {field.type === 'select' ? (
              <select
                className={FORM_FIELD_STYLES}
                value={values[field.key] ?? ''}
                onChange={event => setValue(field.key, event.target.value)}
                disabled={!sessionId}
              >
                <option value=""></option>
                {(field.options ?? []).map(option => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            ) : (
              <input
                type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                className={FORM_FIELD_STYLES}
                value={values[field.key] ?? ''}
                onChange={event => setValue(field.key, event.target.value)}
                disabled={!sessionId}
              />
            )}
            {missingKeys.has(field.key) && (
              <span className="block text-[10px] text-destructive/80">{t('genui.form.requiredMissing')}</span>
            )}
          </label>
        ))}
      </div>
      <div className="px-3 pb-2.5">
        <button
          type="submit"
          disabled={!sessionId}
          className={cn(
            'h-[28px] px-3 text-xs font-medium rounded-[6px] transition-all',
            'bg-accent/5 text-accent hover:bg-accent/10 shadow-tinted',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'disabled:opacity-50 disabled:cursor-not-allowed',
          )}
        >
          {component.submitLabel ?? t('genui.form.submit')}
        </button>
      </div>
    </form>
  )
}

// ── Component registry (static imports for P0) ──────────────────────────────

type GenUiComponentRenderer = React.ComponentType<{ component: GenUiComponent; sessionId?: string }>

const GENUI_COMPONENT_REGISTRY: Record<string, GenUiComponentRenderer> = {
  'stat-card': ({ component }) => <StatCardView component={component as GenUiStatCard} />,
  'data-table': ({ component, sessionId }) => <DataTableView component={component as GenUiDataTable} sessionId={sessionId} />,
  'alert': ({ component }) => <AlertView component={component as GenUiAlert} />,
  'progress': ({ component }) => <ProgressView component={component as GenUiProgress} />,
  'action-buttons': ({ component, sessionId }) => <ActionButtonsView component={component as GenUiActionButtons} sessionId={sessionId} />,
  'form': ({ component, sessionId }) => <FormView component={component as GenUiForm} sessionId={sessionId} />,
}

/** Whether a component type has a registered renderer (else the JSON fallback renders) */
export function hasGenUiRenderer(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(GENUI_COMPONENT_REGISTRY, type)
}

// ── Main component ───────────────────────────────────────────────────────────

export interface GenUICardProps {
  components: GenUiComponent[]
  /** Session used to target the chat-input events; buttons render disabled without it */
  sessionId?: string
  className?: string
}

export function GenUICard({ components, sessionId, className }: GenUICardProps) {
  if (components.length === 0) return null
  return (
    <div className={cn('space-y-2', className)} data-search-exclude="true">
      {components.map(component => {
        const Renderer = GENUI_COMPONENT_REGISTRY[component.type]
        return (
          <GenUiComponentErrorBoundary key={component.id} componentId={component.id}>
            {Renderer
              ? <Renderer component={component} sessionId={sessionId} />
              : <GenUiUnknownFallback component={component as unknown as Record<string, unknown>} />}
          </GenUiComponentErrorBoundary>
        )
      })}
    </div>
  )
}
