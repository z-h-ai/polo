import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, FolderUp, Loader2, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Checkbox } from '../ui/Checkbox'

/**
 * POO-215 U1/U3 — the distillation checklist card.
 *
 * Rendered from a completed `project_context_suggest` tool result: the model
 * proposed distilled markdown entries, and NOTHING is written until the user
 * ticks entries and confirms (adjudication Q5 — model suggests, user
 * disposes; automatic deposit is never done). Selection semantics follow the
 * POO-210 batch-upload checklist (default all-selected, per-row toggle locked
 * while submitting, entries stay listed with their outcome), plus the U3
 * per-entry expandable preview that the upload checklist does not have.
 *
 * This component is deliberately pure UI: the deposit round-trip
 * (storeAttachment → prepare → pcUploadFile → pcSetConfirmed) lives in the
 * host renderer behind `onConfirm`. When no handler is provided (non-project
 * or non-Electron surface) the card renders inert instead of promising an
 * action it cannot keep.
 */

export interface DistillSuggestion {
  id: string
  title: string
  body: string
  suggestedTags: string[]
}

/** Per-entry deposit outcome handed back by the host's `onConfirm`. */
export interface DistillEntryResult {
  id: string
  status: 'success' | 'failed'
  /** i18n key for a known failure class (the pc_* → copy map); absent when
   * the failure is an unclassified message. */
  errorKey?: string
  errorDetail?: string
}

interface DistillSuggestionCardProps {
  suggestions: DistillSuggestion[]
  /** Serial deposit round-trip; resolves with one result per submitted entry. */
  onConfirm?: (entries: DistillSuggestion[]) => Promise<DistillEntryResult[]>
}

export function DistillSuggestionCard({ suggestions, onConfirm }: DistillSuggestionCardProps) {
  const { t } = useTranslation()
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(suggestions.map(suggestion => suggestion.id)),
  )
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const [confirming, setConfirming] = React.useState(false)
  const [results, setResults] = React.useState<Map<string, DistillEntryResult>>(() => new Map())
  const [dismissed, setDismissed] = React.useState(false)

  const settled = results.size > 0 && !confirming
  const failedIds = React.useMemo(
    () => suggestions
      .map(suggestion => suggestion.id)
      .filter(id => results.get(id)?.status === 'failed'),
    [suggestions, results],
  )
  const successCount = React.useMemo(
    () => suggestions.filter(suggestion => results.get(suggestion.id)?.status === 'success').length,
    [suggestions, results],
  )

  const checkable = (id: string) => !!onConfirm && !confirming && results.get(id)?.status !== 'success'

  const toggleEntry = (id: string) => {
    if (!checkable(id)) return
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleAll = (select: boolean) => {
    if (confirming) return
    setSelected(new Set(select ? suggestions.map(suggestion => suggestion.id) : []))
  }

  const toggleExpanded = (id: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const submitEntries = async (pending: DistillSuggestion[]) => {
    if (!onConfirm || confirming || pending.length === 0) return
    setConfirming(true)
    try {
      const outcomes = await onConfirm(pending)
      setResults(prev => {
        const next = new Map(prev)
        for (const outcome of outcomes) next.set(outcome.id, outcome)
        return next
      })
    } finally {
      setConfirming(false)
    }
  }

  const confirm = () => submitEntries(suggestions.filter(suggestion => selected.has(suggestion.id)))

  const retryFailed = () => {
    setSelected(new Set(failedIds))
    return submitEntries(suggestions.filter(suggestion => failedIds.includes(suggestion.id)))
  }

  if (dismissed) return null

  const allSelected = selected.size === suggestions.length
  const confirmCount = selected.size

  return (
    <div
      className="mt-2 rounded-[8px] border border-border bg-background/60 px-3 py-2.5"
      data-testid="pc-distill-card"
      data-status={settled ? 'settled' : confirming ? 'uploading' : 'review'}
    >
      <div className="flex items-center gap-2">
        <FolderUp className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium" data-testid="pc-distill-title">
          {t('projectContext.distill.title')}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="pc-distill-description">
        {t('projectContext.distill.description')}
      </p>

      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => toggleAll(true)}
            disabled={confirming || allSelected}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground"
            data-testid="pc-distill-select-all"
          >
            {t('projectContext.distill.selectAll')}
          </button>
          <button
            type="button"
            onClick={() => toggleAll(false)}
            disabled={confirming || selected.size === 0}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:hover:text-muted-foreground"
            data-testid="pc-distill-select-none"
          >
            {t('projectContext.distill.selectNone')}
          </button>
        </div>
        {!settled && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            disabled={confirming}
            className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
            data-testid="pc-distill-dismiss"
          >
            {t('projectContext.distill.dismiss')}
          </button>
        )}
      </div>

      <ul className="mt-1.5 space-y-1">
        {suggestions.map((suggestion) => {
          const result = results.get(suggestion.id)
          const isOpen = expanded.has(suggestion.id)
          return (
            <li
              key={suggestion.id}
              className="rounded-[6px] border border-border/60 bg-background px-2 py-1.5"
              data-testid={`pc-distill-entry-${suggestion.id}`}
              data-status={result?.status ?? 'pending'}
            >
              <div className="flex items-start gap-2">
                <Checkbox
                  className="mt-0.5"
                  checked={selected.has(suggestion.id) || result?.status === 'success'}
                  disabled={!checkable(suggestion.id)}
                  onChange={() => toggleEntry(suggestion.id)}
                  aria-label={suggestion.title}
                  data-testid={`pc-distill-entry-check-${suggestion.id}`}
                />
                <button
                  type="button"
                  onClick={() => toggleExpanded(suggestion.id)}
                  className="flex min-w-0 flex-1 items-start gap-1 text-left"
                  aria-expanded={isOpen}
                  data-testid={`pc-distill-entry-toggle-${suggestion.id}`}
                >
                  {isOpen
                    ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className={cn('block truncate text-sm', result?.status === 'success' && 'text-muted-foreground line-through')}>
                      {suggestion.title}
                    </span>
                    {suggestion.suggestedTags.length > 0 && (
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {suggestion.suggestedTags.map(tag => (
                          <span key={tag} className="rounded-[4px] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </button>
                {confirming && selected.has(suggestion.id) && (
                  <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                )}
                {result?.status === 'success' && (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
                )}
                {result?.status === 'failed' && (
                  <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
                )}
              </div>
              {isOpen && (
                <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-[4px] bg-muted/50 px-2 py-1.5 text-xs text-foreground/90">
                  {suggestion.body}
                </pre>
              )}
              {result?.status === 'failed' && (
                <p className="mt-1 text-xs text-destructive" data-testid={`pc-distill-entry-error-${suggestion.id}`}>
                  {result.errorKey ? t(result.errorKey) : result.errorDetail || t('projectContext.errors.generic')}
                </p>
              )}
            </li>
          )
        })}
      </ul>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground" data-testid="pc-distill-selection-count">
          {settled
            ? t('projectContext.distill.settledSummary', { success: successCount, count: successCount })
            : t('projectContext.distill.selectedCount', { count: confirmCount })}
        </span>
        <div className="flex items-center gap-2">
          {settled && failedIds.length > 0 && onConfirm && (
            <button
              type="button"
              onClick={() => { void retryFailed() }}
              className="text-xs text-muted-foreground hover:text-foreground"
              data-testid="pc-distill-retry"
            >
              {t('projectContext.distill.retryFailed', { count: failedIds.length })}
            </button>
          )}
          {!settled && onConfirm && (
            <button
              type="button"
              onClick={() => { void confirm() }}
              disabled={confirming || confirmCount === 0}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-sm font-medium',
                'bg-accent text-[var(--on-accent,#fff)] hover:opacity-90',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
              data-testid="pc-distill-confirm"
            >
              {confirming
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                : <FolderUp className="h-3.5 w-3.5" aria-hidden="true" />}
              {confirming ? t('projectContext.distill.confirming') : t('projectContext.distill.confirm', { count: confirmCount })}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Parse a completed `project_context_suggest` tool result into card data.
 * Returns null for anything that is not the marker-tagged envelope (older
 * shapes, error text, truncated streams) — the caller renders nothing rather
 * than a broken card.
 */
export function parseDistillSuggestions(content: string | undefined): DistillSuggestion[] | null {
  if (!content) return null
  const markerIndex = content.indexOf('"marker"')
  if (markerIndex < 0) return null
  // The envelope is the whole (single-line) tool result; find the JSON object
  // bounds defensively in case a backend prepends or appends plain text.
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as {
      marker?: unknown
      suggestions?: unknown
    }
    if (parsed.marker !== 'PC_DISTILL_SUGGESTIONS_V1' || !Array.isArray(parsed.suggestions)) return null
    const suggestions: DistillSuggestion[] = []
    for (const raw of parsed.suggestions) {
      const candidate = raw as { id?: unknown; title?: unknown; body?: unknown; suggestedTags?: unknown }
      if (typeof candidate.id !== 'string' || candidate.id.length === 0) return null
      if (typeof candidate.title !== 'string' || candidate.title.length === 0) return null
      if (typeof candidate.body !== 'string' || candidate.body.length === 0) return null
      const tags = Array.isArray(candidate.suggestedTags)
        ? candidate.suggestedTags.filter((tag): tag is string => typeof tag === 'string')
        : []
      suggestions.push({ id: candidate.id, title: candidate.title, body: candidate.body, suggestedTags: tags })
    }
    return suggestions.length > 0 ? suggestions : null
  } catch {
    return null
  }
}

/** Tool-name predicate shared with the renderer: registry tools surface under
 * both the bare name and the session MCP prefix. */
export function isDistillSuggestToolName(name: string | undefined): boolean {
  return name === 'project_context_suggest' || name === 'mcp__session__project_context_suggest'
}
