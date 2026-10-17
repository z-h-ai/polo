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
import { MarkdownDatatableBlock } from '../markdown/MarkdownDatatableBlock'

// ── Payload types (renderer-side mirror of the render_ui tool schema) ────────

export type GenUiTrend = 'up' | 'down' | 'flat'

export interface GenUiStatCard {
  type: 'stat-card'
  id: string
  title?: string
  label: string
  value: string | number
  unit?: string
  /** Decimal fraction per the tool schema (0.152 = +15.2%). */
  delta?: number
  trend?: GenUiTrend
}

export interface GenUiTableColumn {
  key: string
  label: string
  type?: 'text' | 'number' | 'currency' | 'percent' | 'boolean' | 'date' | 'badge'
}

export interface GenUiDataTable {
  type: 'data-table'
  id: string
  title?: string
  columns: GenUiTableColumn[]
  src: string
  pageSize?: number
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

export interface GenUiActionButton {
  id: string
  label: string
  style: 'primary' | 'secondary' | 'danger'
  action: { kind: 'send-message'; prompt: string } | { kind: 'fill-input'; text: string }
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

// ── Component renderers ──────────────────────────────────────────────────────

/**
 * The schema sends a decimal fraction (0.152 = +15.2%); render it as a signed
 * percentage so the sign is never lost on positive deltas.
 */
export function formatStatDelta(delta: number): string {
  const percent = Math.round(delta * 1000) / 10
  return `${percent > 0 ? '+' : ''}${percent}%`
}

function StatCardView({ component }: { component: GenUiStatCard }) {
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
            {String(component.value)}
            {component.unit && <span className="text-[13px] font-normal text-muted-foreground ml-1">{component.unit}</span>}
          </div>
        </div>
        {component.delta !== undefined && (
          <span className={cn(
            'shrink-0 inline-flex items-center gap-1 text-[12px] font-medium tabular-nums',
            component.trend === 'up' && 'text-success',
            component.trend === 'down' && 'text-destructive',
            (!component.trend || component.trend === 'flat') && 'text-muted-foreground',
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
 * Delegates to MarkdownDatatableBlock by building its file-backed spec JSON.
 * Rows always come from the `src` file (the schema forbids inline rows);
 * the GenUI pageSize hint is not forwarded — the block's own scroll/max-height
 * behavior applies.
 */
function DataTableView({ component }: { component: GenUiDataTable }) {
  const spec = JSON.stringify({
    src: component.src,
    title: component.title,
    columns: component.columns,
  })
  return <MarkdownDatatableBlock code={spec} />
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

function ActionButtonsView({ component, sessionId }: { component: GenUiActionButtons; sessionId?: string }) {
  const handleAction = React.useCallback((button: GenUiActionButton) => {
    if (!sessionId) return
    if (button.action.kind === 'send-message') {
      dispatchGenUiInsertText(button.action.prompt, sessionId)
      dispatchGenUiSubmitInput(sessionId)
    } else {
      dispatchGenUiInsertText(button.action.text, sessionId)
    }
  }, [sessionId])

  return (
    <div className="rounded-[8px] overflow-hidden border bg-muted/10">
      {component.title && (
        <div className="px-3 py-2 bg-muted/50 border-b">
          <span className="text-[12px] text-muted-foreground font-medium">{component.title}</span>
        </div>
      )}
      <div className="px-3 py-2.5 flex flex-wrap gap-2">
        {component.buttons.map(button => (
          <button
            key={button.id}
            type="button"
            disabled={!sessionId}
            onClick={() => handleAction(button)}
            title={!sessionId ? undefined : button.action.kind === 'send-message' ? button.action.prompt : button.action.text}
            className={cn(
              'h-[28px] px-3 text-xs font-medium rounded-[6px] transition-all',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              ACTION_BUTTON_STYLES[button.style],
            )}
          >
            {button.label}
          </button>
        ))}
      </div>
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
  'data-table': ({ component }) => <DataTableView component={component as GenUiDataTable} />,
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
