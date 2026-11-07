import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import type { ProjectAssetReference } from '@polo-ai/shared/protocol'
import type { ProjectAssetMentionDraft } from '@/atoms/project-context'

/**
 * POO-196: project-asset reference chips, dual mode (mirrors
 * ElementReferenceChips):
 *
 * - draft mode (composer): removable chips for the @ mentions queued for the
 *   next send; removal keeps the user's typed text intact
 * - message mode (under a sent user message): read-only chips rendering the
 *   persisted point-in-time snapshot, INCLUDING the per-reference outcome the
 *   server stamped at send time — a reference that did not resolve says so
 *   (adjudication D7), it never silently disappears.
 */

export function projectAssetChipTitle(reference: ProjectAssetReference, fallbackStatus: string): string {
  return `${reference.name} · v${reference.version} · ${fallbackStatus}`
}

export function ProjectAssetChip({ references, mode, onRemove }: {
  references: ProjectAssetReference[]
  mode: 'draft' | 'message'
  onRemove?: (assetId: string) => void
}) {
  const { t } = useTranslation()

  if (references.length === 0) return null

  return (
    <div
      className="mt-1 flex flex-wrap items-center gap-1.5"
      data-testid={mode === 'draft' ? 'project-asset-draft-chips' : 'project-asset-reference-chips'}
    >
      {references.map((reference) => {
        const failed = reference.status !== 'ok'
        const statusText = failed
          ? t(`projectContext.referenceStatus.${reference.status}`)
          : undefined
        return (
          <span
            key={`${reference.assetId}:${reference.version}`}
            title={statusText ? `${reference.name} · ${statusText}` : `${reference.name} · v${reference.version}`}
            className={[
              'inline-flex max-w-[280px] items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] shadow-minimal',
              failed
                ? 'border-destructive/30 bg-destructive/8 text-destructive'
                : 'border-border bg-surface text-foreground-70',
            ].join(' ')}
          >
            <Icons.FileText
              className={['h-3 w-3 shrink-0', failed ? '' : 'text-accent'].join(' ')}
              aria-hidden="true"
            />
            <span className="truncate">{reference.name}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">v{reference.version}</span>
            {mode === 'message' && failed && (
              <span className="shrink-0 text-[10px] text-destructive" data-testid={`project-asset-ref-status-${reference.status}`}>
                {statusText}
              </span>
            )}
            {mode === 'draft' && onRemove && (
              <button
                type="button"
                aria-label={t('projectContext.mention.removeRef')}
                data-testid={`project-asset-draft-chip-remove-${reference.assetId}`}
                onClick={() => onRemove(reference.assetId)}
                className="shrink-0 rounded-full text-muted-foreground transition-colors hover:text-foreground"
              >
                <Icons.X className="h-3 w-3" aria-hidden="true" />
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

/** Convenience adapter: render the composer's draft mentions as chips. */
export function ProjectAssetDraftChips({ drafts, onRemove }: {
  drafts: ProjectAssetMentionDraft[]
  onRemove: (assetId: string) => void
}) {
  const references: ProjectAssetReference[] = drafts.map((draft) => ({
    assetId: draft.assetId,
    version: draft.version,
    name: draft.name,
    // Draft shape only — the server stamps the authoritative outcome at
    // send time (client values are dropped; see resolveSessionProjectContext).
    status: 'ok',
    snippet: null,
  }))
  return <ProjectAssetChip references={references} mode="draft" onRemove={onRemove} />
}
