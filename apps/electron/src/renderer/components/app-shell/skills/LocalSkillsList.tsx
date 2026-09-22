import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Search, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { creatorSkillHasStaleSafetyStatus } from '@/lib/creator-skill-safety-display'
import { SkillActionButton } from './parts'
import { SkillGlyphTile } from './SkillGlyphTile'
import { SkillStateBadge } from './SkillStateBadge'
import {
  canUninstallManagedSkill,
  localSkillRowState,
  type ManagedSkill,
  type SkillSpaceKind,
} from './types'

export interface LocalSkillsListProps {
  skills: ManagedSkill[]
  spaceKind: SkillSpaceKind
  spaceName: string
  workspaceId?: string
  onToggleEnabled: (skill: ManagedSkill, enabled: boolean) => void
  onManage: (skill: ManagedSkill) => void
  onReauthorize: (skill: ManagedSkill) => void
  onViewRestrictedReason: (skill: ManagedSkill) => void
  onUninstall: (skill: ManagedSkill) => void
  /** 获取 Skill / empty-state CTA — switches to the discover tab. */
  onGetSkills: () => void
  /** Slug of the currently selected row (info-page wiring). */
  selectedSlug?: string
  /** Show the search + 获取 Skill toolbar row. */
  showToolbar?: boolean
  className?: string
}

/**
 * LocalSkillsList — the right-hand list of the 本机已安装 tab
 * (P-M06-SKILLS(-PERSONAL) and the LOCAL-* state-bit scenes).
 *
 * Row actions follow the R6 lifecycle: built-in skills can only be
 * toggled (never uninstalled), distributed skills enable/disable per user
 * choice, restricted rows keep their copy with re-verify / uninstall
 * paths. Toggling only affects future messages — the footnote states this
 * and no task-control callback exists on this surface.
 */
export function LocalSkillsList({
  skills,
  spaceKind,
  spaceName,
  workspaceId,
  onToggleEnabled,
  onManage,
  onReauthorize,
  onViewRestrictedReason,
  onUninstall,
  onGetSkills,
  selectedSlug,
  showToolbar = true,
  className,
}: LocalSkillsListProps) {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState('')

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleSkills = normalizedQuery
    ? skills.filter((skill) =>
        `${skill.name} ${skill.description} ${skill.provider ?? ''} ${skill.originLabel}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : skills
  const hasRestricted = skills.some((skill) => skill.restricted)

  const sourceLine = (skill: ManagedSkill) => {
    if (skill.origin === 'builtin') {
      return t('skillsManager.source.builtin')
    }
    if (skill.skill?.source === 'project') {
      return t('skillsManager.source.project')
    }
    const provider = skill.provider ?? (
      skill.origin === 'org' ? spaceName : t('skillsManager.source.personal')
    )
    const versionPart = skill.installedVersion
      ? ` · ${t('skillsManager.source.localVersion', { version: skill.installedVersion })}`
      : ''
    return `${provider}${versionPart}`
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {hasRestricted && (
        <div
          role="status"
          data-testid="skills-restricted-banner"
          className="mb-2 flex items-start gap-2 rounded-hifi-md border border-hifi-destructive/20 bg-hifi-destructive-soft px-3 py-2 text-hifi-sm text-hifi-destructive"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('skillsManager.restricted.banner')}</span>
        </div>
      )}

      {showToolbar && (
        <div className="mb-2 flex items-center gap-2">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-hifi-md border border-hifi-border bg-hifi-surface px-2.5 text-hifi-fg-50">
            <Search className="size-3.5 shrink-0" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('skillsManager.search.label')}
              placeholder={t('skillsManager.search.placeholder')}
              className="h-full w-full min-w-0 bg-transparent text-hifi-sm text-hifi-foreground outline-none placeholder:text-hifi-fg-50"
            />
          </label>
          <SkillActionButton onClick={onGetSkills}>
            {t('skillsManager.getAction')}
          </SkillActionButton>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto rounded-hifi-lg border border-hifi-border bg-hifi-surface">
        {visibleSkills.map((skill) => {
          const rowState = localSkillRowState(skill)
          const staleSafety = skill.skill ? creatorSkillHasStaleSafetyStatus(skill.skill) : false
          return (
            <article
              key={skill.slug}
              data-search-text={`${skill.name} ${skill.description} ${skill.provider ?? ''}`}
              data-skill-slug={skill.slug}
              aria-current={selectedSlug === skill.slug || undefined}
              className={cn(
                'flex items-start gap-2.5 border-b border-hifi-border px-3 py-2.5 last:border-b-0',
                selectedSlug === skill.slug && 'bg-hifi-fg-3',
              )}
            >
              <SkillGlyphTile skill={skill.skill} workspaceId={workspaceId} compact />
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-hifi-md font-semibold text-hifi-foreground">
                  {skill.name}
                </h3>
                <p className="mt-0.5 line-clamp-2 text-hifi-sm text-hifi-fg-60">
                  {skill.description}
                </p>
                <p className="mt-0.5 truncate text-hifi-xs text-hifi-fg-50">
                  {sourceLine(skill)}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5">
                <div className="flex items-center gap-1.5">
                  {staleSafety && (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-hifi-fg-10 px-1.5 py-0.5 text-hifi-xs text-hifi-fg-70">
                      <ShieldAlert className="size-3" />
                      {t('creatorSkills.safety.stale')}
                    </span>
                  )}
                  <SkillStateBadge state={rowState} version={skill.availableVersion} />
                </div>
                <div className="flex items-center gap-1.5">
                  {skill.restricted ? (
                    <>
                      <SkillActionButton
                        onClick={() => onViewRestrictedReason(skill)}
                      >
                        {t('skillsManager.action.viewReason')}
                      </SkillActionButton>
                      <SkillActionButton onClick={() => onReauthorize(skill)}>
                        {t('skillsManager.action.reauthorize')}
                      </SkillActionButton>
                      <SkillActionButton
                        variant="danger"
                        disabled={!canUninstallManagedSkill(skill)}
                        title={canUninstallManagedSkill(skill)
                          ? undefined
                          : t('skillsManager.uninstall.unavailable')}
                        onClick={() => onUninstall(skill)}
                      >
                        {t('skillsManager.action.uninstall')}
                      </SkillActionButton>
                    </>
                  ) : (
                    <>
                      <SkillActionButton
                        onClick={() => onToggleEnabled(skill, !skill.enabled)}
                      >
                        {t(skill.enabled
                          ? 'skillsManager.action.disable'
                          : 'skillsManager.action.enable')}
                      </SkillActionButton>
                      <SkillActionButton variant="primary" onClick={() => onManage(skill)}>
                        {t('skillsManager.action.manage')}
                      </SkillActionButton>
                    </>
                  )}
                </div>
              </div>
            </article>
          )
        })}

        {visibleSkills.length === 0 && skills.length > 0 && (
          <p className="px-3 py-6 text-center text-hifi-sm text-hifi-fg-50">
            {t('skillsManager.search.empty')}
          </p>
        )}

        {skills.length === 0 && (
          <div className="px-3 py-6 text-center">
            <h3 className="text-hifi-lg font-semibold text-hifi-foreground">
              {t('skillsManager.local.empty.title')}
            </h3>
            <p className="mt-1 text-hifi-sm text-hifi-fg-60">
              {t(spaceKind === 'enterprise'
                ? 'skillsManager.local.empty.desc.ent'
                : 'skillsManager.local.empty.desc.personal')}
            </p>
            <div className="mt-3 flex justify-center">
              <SkillActionButton variant="primary" onClick={onGetSkills}>
                {t('skillsManager.action.viewInstall')}
              </SkillActionButton>
            </div>
          </div>
        )}
      </div>

      <p className="mt-2 shrink-0 text-hifi-xs leading-relaxed text-hifi-fg-50">
        {t('skillsManager.footnote.disable')}
      </p>
    </div>
  )
}
