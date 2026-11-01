import * as React from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { PcSearchResponse } from '@polo-ai/shared/protocol'
import type { MentionInputElement } from '@/components/ui/mention-menu'
import { cn } from '@/lib/utils'

/**
 * POO-196: the @ project-asset mention popover (adjudication D8). Typing `@`
 * in a project session's composer floats the project file list above the
 * caret; ↑/↓ move, Enter/Tab pick, Esc closes (Apple HIG keyboard contract).
 * A pick strips the `@query` token from the text and queues a structured
 * reference chip — the reference rides the send as
 * `SendMessageOptions.projectAssetRefs`, never as message prose.
 */

/** Search debounce shared with the file library (one cadence everywhere). */
export const PC_MENTION_DEBOUNCE_MS = 300

export interface AssetMentionHit {
  assetId: string
  version: number
  name: string
}

export interface AssetMentionOption extends AssetMentionHit {
  snippet: string | null
  tags: string[]
}

interface UseAssetMentionOptions {
  /** Wired only in project sessions — absent/False keeps the whole surface off. */
  enabled: boolean
  inputRef: React.RefObject<MentionInputElement | null>
  /** The debounced search call (pcSearchAssets wrapped by the parent). */
  search: (q: string) => Promise<PcSearchResponse>
  /** Fired with the picked hit; the parent queues the reference chip. */
  onPick: (hit: AssetMentionHit) => void
  /**
   * Applies the post-pick input text (the `@query` token stripped). Mirrors
   * useInlineLabelMenu.handleSelect's contract.
   */
  applyInputValue: (value: string, cursorPosition: number) => void
}

export interface UseAssetMentionResult {
  isOpen: boolean
  options: AssetMentionOption[]
  isLoading: boolean
  /** True when the index answered with metadata-only matching (degraded). */
  degraded: boolean
  selectedIndex: number
  position: { x: number; y: number }
  /** Feed every composer input change; detects/updates/closes the trigger.
   *  Returns true while the `@` trigger is active (popover owns the caret). */
  handleInputChanged: (value: string, cursorPosition: number) => boolean
  /** Route keydowns here FIRST; true = consumed (popover owns this key). */
  handleKeyDown: (event: { key: string }) => boolean
  /** Pick the highlighted option (Enter/click). */
  chooseActive: () => void
  /** Pick a specific option (pointer). */
  choose: (hit: AssetMentionHit) => void
  close: () => void
}

export function useAssetMention({
  enabled,
  inputRef,
  search,
  onPick,
  applyInputValue,
}: UseAssetMentionOptions): UseAssetMentionResult {
  const [isOpen, setIsOpen] = React.useState(false)
  const [options, setOptions] = React.useState<AssetMentionOption[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [degraded, setDegraded] = React.useState(false)
  const [selectedIndex, setSelectedIndex] = React.useState(0)
  const [position, setPosition] = React.useState({ x: 0, y: 0 })

  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })
  const triggerStartRef = React.useRef(-1)
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestSeqRef = React.useRef(0)

  const close = React.useCallback(() => {
    setIsOpen(false)
    setOptions([])
    setDegraded(false)
    setSelectedIndex(0)
    triggerStartRef.current = -1
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (!enabled) close()
  }, [enabled, close])

  React.useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
  }, [])

  const runSearch = React.useCallback((query: string) => {
    const seq = ++requestSeqRef.current
    setIsLoading(true)
    search(query)
      .then((response) => {
        if (seq !== requestSeqRef.current) return
        setDegraded(response.degraded)
        setOptions(response.hits.map((hit) => ({
          assetId: hit.assetId,
          version: hit.version,
          name: hit.name,
          snippet: hit.snippet,
          tags: hit.tags.map((tag) => (tag.preset ? tag.id : tag.label)),
        })))
        setSelectedIndex(0)
      })
      .catch(() => {
        if (seq !== requestSeqRef.current) return
        // A mention search failure is never a blocker: the popover shows its
        // empty state and the user can still send plain text.
        setOptions([])
        setDegraded(false)
      })
      .finally(() => {
        if (seq === requestSeqRef.current) setIsLoading(false)
      })
  }, [search])

  const handleInputChanged = React.useCallback((value: string, cursorPosition: number): boolean => {
    currentInputRef.current = { value, cursorPosition }
    if (!enabled) {
      if (isOpen) close()
      return false
    }

    const textBeforeCursor = value.slice(0, cursorPosition)
    // The project-asset trigger: a trailing `@query` with no whitespace and no
    // second `@` (plain, typeable queries; the generic skill/source mention
    // keeps its own multi-word syntax).
    const atMatch = textBeforeCursor.match(/@([^\s@]{0,128})$/)
    if (!atMatch) {
      if (isOpen) close()
      return false
    }

    const triggerStart = textBeforeCursor.length - atMatch[0].length
    triggerStartRef.current = triggerStart

    if (inputRef.current) {
      const caretRect = inputRef.current.getCaretRect?.()
      if (caretRect && caretRect.x > 0) {
        setPosition({ x: caretRect.x, y: caretRect.y })
      } else {
        const rect = inputRef.current.getBoundingClientRect()
        const lineHeight = 20
        const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
        setPosition({ x: rect.left, y: rect.top + (linesBeforeCursor + 1) * lineHeight })
      }
    }

    setIsOpen(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const query = atMatch[1]
    if (!query) {
      // Fresh `@` with no query yet: open empty, don't burn a search.
      setOptions([])
      setDegraded(false)
      setIsLoading(false)
      return true
    }
    debounceRef.current = setTimeout(() => runSearch(query), PC_MENTION_DEBOUNCE_MS)
    return true
  }, [enabled, inputRef, isOpen, close, runSearch])

  const pickHit = React.useCallback((hit: AssetMentionHit) => {
    const triggerStart = triggerStartRef.current
    const { value: currentValue, cursorPosition } = currentInputRef.current
    if (triggerStart >= 0) {
      const before = currentValue.slice(0, triggerStart)
      const after = currentValue.slice(cursorPosition)
      // The trigger text never becomes message prose — it becomes a chip.
      const nextValue = before + after
      applyInputValue(nextValue, before.length)
    }
    triggerStartRef.current = -1
    setIsOpen(false)
    setOptions([])
    onPick(hit)
  }, [applyInputValue, onPick])

  const chooseActive = React.useCallback(() => {
    const hit = options[selectedIndex]
    if (!hit) return
    pickHit(hit)
  }, [options, selectedIndex, pickHit])

  const choose = React.useCallback((hit: AssetMentionHit) => {
    pickHit(hit)
  }, [pickHit])

  const handleKeyDown = React.useCallback((event: { key: string }) => {
    if (!isOpen) return false
    switch (event.key) {
      case 'ArrowDown':
        setSelectedIndex((prev) => (options.length === 0 ? 0 : (prev + 1) % options.length))
        return true
      case 'ArrowUp':
        setSelectedIndex((prev) => (options.length === 0 ? 0 : (prev - 1 + options.length) % options.length))
        return true
      case 'Enter':
      case 'Tab':
        // Enter only consumes when an option is highlighted-and-available;
        // with zero hits the send must keep working.
        if (options.length > 0) {
          chooseActive()
          return true
        }
        return false
      case 'Escape':
        close()
        return true
      default:
        return false
    }
  }, [isOpen, options.length, chooseActive, close])

  return {
    isOpen,
    options,
    isLoading,
    degraded,
    selectedIndex,
    position,
    handleInputChanged,
    handleKeyDown,
    chooseActive,
    choose,
    close,
  }
}

export function AssetMentionPopover({ state, onChoose }: {
  state: UseAssetMentionResult
  onChoose: (hit: AssetMentionHit) => void
}) {
  const { t } = useTranslation()
  if (!state.isOpen) return null

  return (
    <div
      role="listbox"
      aria-label={t('projectContext.mention.listAria')}
      className="fixed z-50 max-h-[280px] w-[320px] overflow-y-auto rounded-[12px] border border-border bg-surface p-1 shadow-lg"
      style={{ left: state.position.x, top: state.position.y }}
      data-testid="pc-mention-popover"
      data-open="true"
    >
      {state.isLoading && state.options.length === 0 && (
        <p className="px-3 py-2 text-[12px] text-muted-foreground" role="status">
          {t('projectContext.mention.searching')}
        </p>
      )}
      {!state.isLoading && state.options.length === 0 && (
        <p className="px-3 py-2 text-[12px] text-muted-foreground" data-testid="pc-mention-empty">
          {t('projectContext.mention.empty')}
        </p>
      )}
      {state.options.map((option, index) => (
        <button
          key={`${option.assetId}:${option.version}`}
          type="button"
          role="option"
          aria-selected={index === state.selectedIndex}
          onMouseDown={(event) => {
            // mousedown (not click): the composer input keeps focus.
            event.preventDefault()
            onChoose(option)
          }}
          onMouseEnter={() => undefined}
          className={cn(
            'flex w-full flex-col items-start gap-0.5 rounded-[8px] px-2.5 py-1.5 text-left transition-colors',
            index === state.selectedIndex ? 'bg-foreground/8' : 'hover:bg-foreground/5',
          )}
          data-testid={`pc-mention-option-${option.assetId}`}
          data-highlighted={index === state.selectedIndex ? 'true' : 'false'}
        >
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <Icons.FileText className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden="true" />
            <span className="truncate text-[13px] text-foreground">{option.name}</span>
            <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">v{option.version}</span>
          </span>
          {option.snippet && (
            <span className="line-clamp-1 text-[11px] text-muted-foreground">{option.snippet}</span>
          )}
        </button>
      ))}
      {state.degraded && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="pc-mention-degraded">
          {t('projectContext.mention.degraded')}
        </p>
      )}
      <p className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        {t('projectContext.mention.hint')}
      </p>
    </div>
  )
}
