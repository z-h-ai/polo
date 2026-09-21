import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { SkillActionButton } from './parts'
import { SkillGlyphTile } from './SkillGlyphTile'
import { SkillStateBadge } from './SkillStateBadge'
import {
  discoverRowState,
  type DiscoverableSkill,
  type SkillSpaceKind,
} from './types'

export interface DiscoverSkillsListProps {
  /** Circle library entries (personal space) or org shared library (enterprise). */
  items: DiscoverableSkill[]
  spaceKind: SkillSpaceKind
  spaceName: string
  /** Open the install sheet for a not-yet-installed entry. */
  onViewInstall: (entry: DiscoverableSkill) => void
  /** Manage the installed local copy of an entry. */
  onManage: (entry: DiscoverableSkill) => void
  /** Enterprise only: open the share-to-org dialog for a local skill. */
  onShareToOrg?: () => void
  /** Personal only: link out to circles. */
  onViewCircles?: () => void
  className?: string
}

/**
 * DiscoverSkillsList — the 获取 tab. Personal spaces fetch from joined
 * circles (P-M06-DISCOVER-PERSONAL); enterprise spaces show the org shared
 * library (P-M06-DISCOVER-ENT) where colleagues' skills can be installed
 * and own local skills can be submitted for review.
 */
export function DiscoverSkillsList({
  items,
  spaceKind,
  spaceName,
  onViewInstall,
  onManage,
  onShareToOrg,
  onViewCircles,
  className,
}: DiscoverSkillsListProps) {
  const { t } = useTranslation()
  const isEnterprise = spaceKind === 'enterprise'

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-hifi-lg border border-hifi-border bg-hifi-surface">
        {items.map((entry) => {
          const rowState = discoverRowState(entry)
          const installed = Boolean(entry.installed)
          return (
            <article
              key={entry.slug}
              data-discover-slug={entry.slug}
              className="flex items-start gap-2.5 border-b border-hifi-border px-3 py-2.5 last:border-b-0"
            >
              <SkillGlyphTile glyph={entry.glyph ?? '✧'} compact />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-hifi-md font-semibold text-hifi-foreground">
                  {entry.name}
                </h3>
                <p className="mt-0.5 line-clamp-2 text-hifi-sm text-hifi-fg-60">
                  {entry.description}
                </p>
                <p className="mt-0.5 truncate text-hifi-xs text-hifi-fg-50">
                  {`${entry.provider} · v${entry.version}`}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <SkillStateBadge
                  state={rowState}
                  version={entry.installed?.updateVersion}
                />
                <div className="flex items-center gap-1.5">
                  {installed ? (
                    <SkillActionButton variant="primary" onClick={() => onManage(entry)}>
                      {t('skillsManager.action.manage')}
                    </SkillActionButton>
                  ) : (
                    <SkillActionButton variant="primary" onClick={() => onViewInstall(entry)}>
                      {t('skillsManager.action.viewInstall')}
                    </SkillActionButton>
                  )}
                </div>
              </div>
            </article>
          )
        })}

        {items.length === 0 && (
          <p className="px-3 py-6 text-center text-hifi-sm text-hifi-fg-50">
            {t(isEnterprise
              ? 'skillsManager.discover.empty.ent'
              : 'skillsManager.discover.empty.circle')}
          </p>
        )}
      </div>

      <div className="mt-2 shrink-0 rounded-hifi-lg border border-hifi-border bg-hifi-surface p-3 text-center">
        {isEnterprise ? (
          <>
            <h3 className="text-hifi-lg font-semibold text-hifi-foreground">
              {t('skillsManager.discover.shareCard.title')}
            </h3>
            <p className="mt-1 text-hifi-sm text-hifi-fg-60">
              {t('skillsManager.discover.shareCard.desc')}
            </p>
            <div className="mt-2.5 flex justify-center">
              <SkillActionButton onClick={onShareToOrg} disabled={!onShareToOrg}>
                {t('skillsManager.discover.shareCard.action')}
              </SkillActionButton>
            </div>
          </>
        ) : (
          <>
            <h3 className="text-hifi-lg font-semibold text-hifi-foreground">
              {t('skillsManager.discover.circlesCard.title')}
            </h3>
            <p className="mt-1 text-hifi-sm text-hifi-fg-60">
              {t('skillsManager.discover.circlesCard.desc')}
            </p>
            <div className="mt-2.5 flex justify-center">
              <SkillActionButton onClick={onViewCircles} disabled={!onViewCircles}>
                {t('skillsManager.discover.circlesCard.action')}
              </SkillActionButton>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
