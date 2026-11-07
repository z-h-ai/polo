import * as React from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { PcSearchResponse } from '@polo-ai/shared/protocol'
import type { MentionInputElement } from '@/components/ui/mention-menu'
import { ViewportPortal, useCloseOnViewportResize } from '@/components/ui/viewport-portal'
import { cn } from '@/lib/utils'

/**
 * POO-196: the @ project-asset mention popover (adjudication D8). Typing `@`
 * in a project session's composer floats the project file list above the
 * caret; ↑/↓ move, Enter/Tab pick, Esc closes (Apple HIG keyboard contract).
 * A pick strips the `@query` token from the text and queues a structured
 * reference chip — the reference rides the send as
 * `SendMessageOptions.projectAssetRefs`, never as message prose.
 *
 * Consensus S-11: the popover is the ONE `@` surface in project sessions — it
 * takes the project file group plus the existing skill/source groups as extra
 * sections, so the plain single-token skill/source mention that pre-dates
 * POO-196 stays reachable (D2). Typing a space still hands the caret to the
 * generic multi-word mention menu, exactly as before.
 */

/** Search debounce shared with the file library (one cadence everywhere). */
export const PC_MENTION_DEBOUNCE_MS = 300

/** Popover geometry: mirrors the inline mention menu's width budget and its
 * above-the-caret placement, clamped to the viewport (consensus X1). */
const PC_MENTION_POPOVER_WIDTH = 320
const PC_MENTION_POPOVER_MAX_HEIGHT = 280
const PC_MENTION_VIEWPORT_MARGIN = 8

export interface AssetMentionHit {
  assetId: string
  version: number
  name: string
}

export interface AssetMentionOption extends AssetMentionHit {
  snippet: string | null
  tags: string[]
}

/** One pickable non-asset row (skill/source) contributed by the composer. */
export interface AssetMentionExtraItemInput {
  id: string
  label: string
  description?: string | null
  /** Fired on pick; the parent closes the popover and runs the legacy select. */
  pick: () => void
}

export interface AssetMentionExtraSection {
  id: string
  /** Localized group header (already resolved — the parent owns the i18n). */
  label: string
  items: AssetMentionExtraItemInput[]
}

export interface AssetMentionExtraItem extends AssetMentionExtraItemInput {
  /** Absolute index in the flattened selectable list (after the asset hits). */
  index: number
}

export interface AssetMentionExtraGroup {
  id: string
  label: string
  items: AssetMentionExtraItem[]
}

/** The four popover faces (consensus X4): guidance / searching / results /
 * no-results / failure are distinct — an empty `@` never claims "no matches". */
export type AssetMentionFace = 'guide' | 'searching' | 'results' | 'empty' | 'error'

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
  /**
   * Non-asset groups (skills/sources) rendered under their own headers in the
   * SAME popover, keyboard-navigable together with the asset hits (S-11).
   */
  extraSections?: AssetMentionExtraSection[]
}

export interface UseAssetMentionResult {
  isOpen: boolean
  options: AssetMentionOption[]
  isLoading: boolean
  /** True when the index answered with metadata-only matching (degraded). */
  degraded: boolean
  selectedIndex: number
  position: { x: number; y: number }
  /** The live `@query` text (empty right after the bare `@`). */
  query: string
  /** Which face the popover should render. */
  face: AssetMentionFace
  /** Skill/source groups with their flattened (absolute) indices. */
  extraGroups: AssetMentionExtraGroup[]
  /** asset hits + extra items — the whole keyboard-reachable set. */
  selectableCount: number
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
  extraSections,
}: UseAssetMentionOptions): UseAssetMentionResult {
  const [isOpen, setIsOpen] = React.useState(false)
  const [options, setOptions] = React.useState<AssetMentionOption[]>([])
  const [isLoading, setIsLoading] = React.useState(false)
  const [degraded, setDegraded] = React.useState(false)
  const [searchFailed, setSearchFailed] = React.useState(false)
  const [query, setQuery] = React.useState('')
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
    setSearchFailed(false)
    setQuery('')
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
    setSearchFailed(false)
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
        // failure face and the user can still send plain text.
        setOptions([])
        setDegraded(false)
        setSearchFailed(true)
        setSelectedIndex(0)
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
    setQuery(atMatch[1])
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const nextQuery = atMatch[1]
    if (!nextQuery) {
      // Fresh `@` with no query yet: open with the guidance face, don't burn a
      // search (consensus X4).
      setOptions([])
      setDegraded(false)
      setSearchFailed(false)
      setIsLoading(false)
      setSelectedIndex(0)
      return true
    }
    if (searchFailed) setSearchFailed(false)
    debounceRef.current = setTimeout(() => runSearch(nextQuery), PC_MENTION_DEBOUNCE_MS)
    return true
  }, [enabled, inputRef, isOpen, close, runSearch, searchFailed])

  // Flattened keyboard model: asset hits first, then every extra item.
  const extraGroups = React.useMemo<AssetMentionExtraGroup[]>(() => {
    let index = options.length
    return (extraSections ?? [])
      .filter((section) => section.items.length > 0)
      .map((section) => ({
        id: section.id,
        label: section.label,
        items: section.items.map((item) => ({ ...item, index: index++ })),
      }))
  }, [options.length, extraSections])

  const selectableCount = options.length
    + extraGroups.reduce((total, group) => total + group.items.length, 0)

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
    if (selectedIndex < options.length) {
      const hit = options[selectedIndex]
      if (hit) pickHit(hit)
      return
    }
    // An extra (skill/source) row: hand the pick back to its owner, which
    // closes this popover and runs the legacy mention insertion.
    for (const group of extraGroups) {
      const item = group.items.find((candidate) => candidate.index === selectedIndex)
      if (item) {
        item.pick()
        return
      }
    }
  }, [options, selectedIndex, pickHit, extraGroups])

  const choose = React.useCallback((hit: AssetMentionHit) => {
    pickHit(hit)
  }, [pickHit])

  const handleKeyDown = React.useCallback((event: { key: string }) => {
    if (!isOpen) return false
    switch (event.key) {
      case 'ArrowDown':
        setSelectedIndex((prev) => (selectableCount === 0 ? 0 : (prev + 1) % selectableCount))
        return true
      case 'ArrowUp':
        setSelectedIndex((prev) => (selectableCount === 0 ? 0 : (prev - 1 + selectableCount) % selectableCount))
        return true
      case 'Enter':
      case 'Tab':
        // Enter only consumes when a row is highlighted-and-available; with
        // zero rows the send must keep working.
        if (selectableCount > 0) {
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
  }, [isOpen, selectableCount, chooseActive, close])

  const face: AssetMentionFace = !isOpen
    ? 'guide'
    : searchFailed && options.length === 0
      ? 'error'
      : selectableCount > 0
        ? 'results'
        : isLoading
          ? 'searching'
          : query.length === 0
            ? 'guide'
            : 'empty'

  return {
    isOpen,
    options,
    isLoading,
    degraded,
    selectedIndex,
    position,
    query,
    face,
    extraGroups,
    selectableCount,
    handleInputChanged,
    handleKeyDown,
    chooseActive,
    choose,
    close,
  }
}

export function AssetMentionPopover({ state, onChoose, onChooseExtra, onClose }: {
  state: UseAssetMentionResult
  onChoose: (hit: AssetMentionHit) => void
  /** Fired for a picked skill/source row (extra sections). */
  onChooseExtra?: (item: AssetMentionExtraItem) => void
  /** Outside-pointer dismiss; close never touches the composer text (X2). */
  onClose?: () => void
}) {
  const { t } = useTranslation()
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const listRef = React.useRef<HTMLDivElement | null>(null)

  const isOpen = state.isOpen

  // Click-outside closes the popover; the option rows pick on mousedown so the
  // same event completes the selection first (consensus X2).
  React.useEffect(() => {
    if (!isOpen) return
    const handleMouseDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        ;(onClose ?? state.close)()
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [isOpen, onClose, state.close])

  // Keep the highlighted row visible while the keyboard walks a long list
  // (consensus X3) — same contract as the inline mention menu.
  React.useEffect(() => {
    if (!isOpen) return
    const selectedEl = listRef.current?.querySelector('[data-highlighted="true"]')
    selectedEl?.scrollIntoView({ block: 'nearest' })
  }, [isOpen, state.selectedIndex, state.options.length, state.extraGroups])

  // R-AT: viewport/layout changes invalidate the stored caret anchor — close
  // instead of drifting (registered unconditionally; self-gates on isOpen).
  useCloseOnViewportResize(isOpen, () => state.close())

  if (!isOpen) return null

  // Above the caret, viewport-clamped (consensus X1) — the same placement the
  // generic mention menu has always used in this composer, plus a TOP clamp
  // (review R-12): `bottom` positions the lower edge, so a caret near the
  // window's top would otherwise push the whole list off-screen upward. Capping
  // the lower edge keeps the top edge inside the viewport, the same way the
  // left/right clamp works horizontally — matters if this surface is ever
  // reused above a composer that is not pinned to the window bottom.
  const bottomPosition = Math.min(
    Math.max(
      PC_MENTION_VIEWPORT_MARGIN,
      window.innerHeight - Math.round(state.position.y) + PC_MENTION_VIEWPORT_MARGIN,
    ),
    Math.max(
      PC_MENTION_VIEWPORT_MARGIN,
      window.innerHeight - PC_MENTION_POPOVER_MAX_HEIGHT - PC_MENTION_VIEWPORT_MARGIN,
    ),
  )
  const leftPosition = Math.min(
    Math.max(Math.round(state.position.x) - 10, PC_MENTION_VIEWPORT_MARGIN),
    Math.max(PC_MENTION_VIEWPORT_MARGIN, window.innerWidth - PC_MENTION_POPOVER_WIDTH - PC_MENTION_VIEWPORT_MARGIN),
  )

  const face = state.face

  return (
    <ViewportPortal>
      <div
        ref={containerRef}
        role="listbox"
        aria-label={t('projectContext.mention.listAria')}
        className="fixed z-dropdown max-h-[280px] w-[320px] overflow-y-auto rounded-[12px] border border-border bg-surface p-1 shadow-modal-small"
        style={{ left: leftPosition, bottom: bottomPosition, maxHeight: PC_MENTION_POPOVER_MAX_HEIGHT }}
        data-testid="pc-mention-popover"
        data-open="true"
        data-face={face}
      >
      <div ref={listRef}>
        {face === 'guide' && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground" role="status" data-testid="pc-mention-guide">
            {t('projectContext.mention.guide')}
          </p>
        )}
        {face === 'searching' && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground" role="status" data-testid="pc-mention-searching">
            {t('projectContext.mention.searching')}
          </p>
        )}
        {face === 'error' && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground" role="alert" data-testid="pc-mention-error">
            {t('projectContext.mention.error')}
          </p>
        )}
        {face === 'empty' && (
          <p className="px-3 py-2 text-[12px] text-muted-foreground" data-testid="pc-mention-empty">
            {t('projectContext.mention.empty')}
          </p>
        )}

        {state.options.length > 0 && (
          <p className="px-3 py-1 text-[11px] font-medium text-muted-foreground" data-testid="pc-mention-group-assets">
            {t('projectContext.mention.groupAssets')}
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

        {state.extraGroups.map((group) => (
          <React.Fragment key={group.id}>
            <p className={cn('px-3 py-1 text-[11px] font-medium text-muted-foreground', state.options.length === 0 && 'pt-1.5')} data-testid={`pc-mention-group-${group.id}`}>
              {group.label}
            </p>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={item.index === state.selectedIndex}
                onMouseDown={(event) => {
                  // mousedown: the pick completes before the outside-close
                  // listener could dismiss the popover.
                  event.preventDefault()
                  ;(onChooseExtra ?? (() => item.pick()))(item)
                }}
                className={cn(
                  'flex w-full flex-col items-start gap-0.5 rounded-[8px] px-2.5 py-1.5 text-left transition-colors',
                  item.index === state.selectedIndex ? 'bg-foreground/8' : 'hover:bg-foreground/5',
                )}
                data-testid={`pc-mention-extra-${item.id}`}
                data-highlighted={item.index === state.selectedIndex ? 'true' : 'false'}
              >
                <span className="flex w-full min-w-0 items-center gap-1.5">
                  <span className="truncate text-[13px] text-foreground">{item.label}</span>
                </span>
                {item.description && (
                  <span className="line-clamp-1 text-[11px] text-muted-foreground">{item.description}</span>
                )}
              </button>
            ))}
          </React.Fragment>
        ))}
      </div>

      {state.degraded && (
        <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground" data-testid="pc-mention-degraded">
          {t('projectContext.mention.degraded')}
        </p>
      )}
      <p className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
        {t('projectContext.mention.hint')}
      </p>
      </div>
    </ViewportPortal>
  )
}
