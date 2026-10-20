import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Library, LoaderCircle, X } from 'lucide-react'
import { FilterableSelectPopover } from '@polo-ai/ui'

import { cn } from '@/lib/utils'
import type { KbCollection } from '@polo-ai/shared/protocol'

export interface KnowledgeBaseSelectorPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: React.RefObject<HTMLButtonElement | null>
  collections: KbCollection[] | null
  loading: boolean
  loadFailed: boolean
  selectedIds: string[]
  onToggleId: (collectionId: string) => void
  onRetry: () => void
  /** Removes every selection at once (the summary bar's clear action). */
  onClear: () => void
}

/**
 * The composer's knowledge-base scope picker (POO-108): a multi-select over
 * the enterprise space's PUBLISHED collections. The kb RPC is asked for
 * `publishedOnly` and this list filters again as a client-side backstop — a
 * collection without published documents can never be offered for selection,
 * because saving it is refused and sending it would silently resolve to zero
 * references (review #16).
 */
export function KnowledgeBaseSelectorPopover({
  open,
  onOpenChange,
  anchorRef,
  collections: allCollections,
  loading,
  loadFailed,
  selectedIds,
  onToggleId,
  onRetry,
  onClear,
}: KnowledgeBaseSelectorPopoverProps) {
  const { t } = useTranslation()

  const collections = allCollections?.filter(
    collection => collection.documentCounts.published > 0,
  ) ?? null

  if (loading) {
    return (
      <FilterableSelectPopover<KbCollection>
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        items={[]}
        getKey={(item: KbCollection) => item.id}
        getLabel={(item: KbCollection) => item.name}
        isSelected={() => false}
        onToggle={() => {}}
        filterPlaceholder=""
        emptyState={(
          <span className="flex items-center justify-center gap-2 py-2 text-[13px] text-muted-foreground">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            {t('chat.knowledgeBase.loading')}
          </span>
        )}
        noResultsState=""
        minWidth={220}
        maxWidth={320}
      />
    )
  }

  if (loadFailed || !collections) {
    return (
      <FilterableSelectPopover<KbCollection>
        open={open}
        onOpenChange={onOpenChange}
        anchorRef={anchorRef}
        items={[]}
        getKey={(item: KbCollection) => item.id}
        getLabel={(item: KbCollection) => item.name}
        isSelected={() => false}
        onToggle={() => {}}
        filterPlaceholder=""
        emptyState={(
          <button
            type="button"
            onClick={onRetry}
            className="w-full cursor-pointer rounded-[6px] px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-foreground/5"
          >
            {t('chat.knowledgeBase.loadFailed')}
          </button>
        )}
        noResultsState=""
        minWidth={220}
        maxWidth={320}
      />
    )
  }

  // Called after the early returns above, so no hooks beyond this point.
  const selected = (collections ?? []).filter(collection => selectedIds.includes(collection.id))

  // POO-108 selection summary bar: what is attached, removable one by one,
  // clearable at once. Toggling a list row already persists; these are the
  // explicit removal affordances the same contract asks for.
  const summaryBar = selected.length > 0 ? (
    <div
      className="flex flex-wrap items-center gap-1.5 border-b border-border/50 px-3 py-2"
      data-testid="kb-selected-summary"
    >
      {selected.map(collection => (
        <span
          key={collection.id}
          className="inline-flex max-w-[200px] items-center gap-1 rounded-full bg-foreground/5 py-0.5 pl-2 pr-1 text-[11px] text-foreground-70"
        >
          <span className="truncate">{collection.name}</span>
          <button
            type="button"
            aria-label={t('chat.knowledgeBase.removeCollection', { name: collection.name })}
            onClick={() => onToggleId(collection.id)}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onClear}
        className="ml-auto shrink-0 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {t('chat.knowledgeBase.clearAll')}
      </button>
    </div>
  ) : null

  return (
    <FilterableSelectPopover<KbCollection>
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      items={collections}
      getKey={(collection) => collection.id}
      getLabel={(collection) => collection.name}
      isSelected={(collection) => selectedIds.includes(collection.id)}
      onToggle={(collection) => onToggleId(collection.id)}
      filterPlaceholder={t('chat.knowledgeBase.searchPlaceholder')}
      emptyState={t('chat.knowledgeBase.empty')}
      noResultsState={t('chat.knowledgeBase.noMatches')}
      headerContent={summaryBar}
      minWidth={220}
      maxWidth={340}
      renderItem={(collection, state) => (
        <div
          className={cn(
            'flex cursor-pointer select-none items-center gap-3 rounded-[6px] px-3 py-2 text-[13px]',
            state.highlighted && 'bg-foreground/5',
            state.selected && 'bg-foreground/3',
          )}
        >
          <div className="shrink-0 text-muted-foreground flex items-center">
            <Library className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate">{collection.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {t('chat.knowledgeBase.publishedCount', { count: collection.documentCounts.published })}
            </div>
          </div>
          <div
            className={cn(
              'shrink-0 h-4 w-4 rounded-full bg-current flex items-center justify-center',
              !state.selected && 'opacity-0',
            )}
          >
            <Check className="h-2.5 w-2.5 text-white dark:text-black" strokeWidth={3} />
          </div>
        </div>
      )}
    />
  )
}
