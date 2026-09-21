import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SkillActionButton, SkillFactsTable } from './parts'
import { SkillGlyphTile } from './SkillGlyphTile'
import { SkillStateBadge } from './SkillStateBadge'
import { localSkillRowState, type ManagedSkill, type SkillDetailMode } from './types'

export interface SkillDetailSheetProps {
  skill: ManagedSkill
  spaceName: string
  /** `manage` shows the version surface; the confirm modes render the
   *  uninstall confirmation (with dedicated copy for restricted sources). */
  mode?: SkillDetailMode
  /** What the skill needs from the conversation. */
  requiresNote?: string
  onToggleEnabled: (skill: ManagedSkill, enabled: boolean) => void
  onUpdate: (skill: ManagedSkill) => void
  onReauthorize: (skill: ManagedSkill) => void
  onViewRestrictedReason: (skill: ManagedSkill) => void
  onRequestUninstall: (skill: ManagedSkill) => void
  onConfirmUninstall: (skill: ManagedSkill) => void
  onCancelUninstall: () => void
  onBack: () => void
  className?: string
}

/**
 * SkillDetailSheet — the 管理版本 surface (P-M06-DETAIL-* state-bit scenes)
 * with the embedded uninstall confirmation (P-M06-REMOVE-* / REMOVE-
 * RESTRICTED-*). Built-in skills have no uninstall entry; restricted rows
 * keep the copy, stay disabled and offer re-verification.
 */
export function SkillDetailSheet({
  skill,
  spaceName,
  mode = 'manage',
  requiresNote,
  onToggleEnabled,
  onUpdate,
  onReauthorize,
  onViewRestrictedReason,
  onRequestUninstall,
  onConfirmUninstall,
  onCancelUninstall,
  onBack,
  className,
}: SkillDetailSheetProps) {
  const { t } = useTranslation()
  const isBuiltin = skill.origin === 'builtin'

  if (mode !== 'manage') {
    const restricted = mode === 'confirm-uninstall-restricted'
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col gap-3', className)}>
        <div className="rounded-hifi-lg border border-hifi-border bg-hifi-surface p-3">
          <h2 className="text-hifi-lg font-semibold text-hifi-foreground">
            {t('skillsManager.uninstall.title')}
          </h2>
          <p className="mt-0.5 text-hifi-sm text-hifi-fg-60">{skill.name}</p>
          {restricted && (
            <div
              role="status"
              className="mt-2 flex items-start gap-2 rounded-hifi-md border border-hifi-destructive/20 bg-hifi-destructive-soft px-2.5 py-2 text-hifi-sm text-hifi-destructive"
            >
              <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
              <span>{t('skillsManager.uninstall.restricted.banner')}</span>
            </div>
          )}
          <h3 className="mt-3 text-hifi-md font-semibold text-hifi-foreground">
            {t('skillsManager.uninstall.card.title')}
          </h3>
          <p className="mt-1 text-hifi-sm leading-relaxed text-hifi-fg-60">
            {t(restricted
              ? 'skillsManager.uninstall.restricted.card.desc'
              : 'skillsManager.uninstall.card.desc')}
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <SkillActionButton onClick={onCancelUninstall}>
              {t('skillsManager.uninstall.cancel')}
            </SkillActionButton>
            <SkillActionButton
              variant="danger"
              data-testid="confirm-uninstall"
              onClick={() => onConfirmUninstall(skill)}
            >
              {t('skillsManager.uninstall.confirm')}
            </SkillActionButton>
          </div>
        </div>
      </div>
    )
  }

  const hasUpdate = Boolean(
    skill.availableVersion && skill.availableVersion !== skill.installedVersion,
  )
  const rowState = localSkillRowState(skill)

  const facts = [
    {
      label: t('skillsManager.install.provider'),
      value: isBuiltin ? t('skillsManager.source.builtin') : skill.provider ?? spaceName,
    },
    {
      label: t('skillsManager.install.location'),
      value: t('skillsManager.install.location.value', { space: spaceName }),
    },
    { label: t('skillsManager.install.scope'), value: t('skillsManager.install.scope.value') },
    {
      label: t('skillsManager.install.version'),
      value: skill.installedVersion
        ? `v${skill.installedVersion}`
        : t('skillsManager.detail.version.unknown'),
    },
    {
      label: t('skillsManager.install.requires'),
      value: requiresNote ?? t('skillsManager.install.requires.default'),
    },
  ]

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto', className)}>
      <div className="flex items-center gap-3 rounded-hifi-lg border border-hifi-border bg-hifi-surface p-3">
        <SkillGlyphTile glyph="✧" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-hifi-lg font-semibold text-hifi-foreground">
            {skill.name}
          </h2>
          <p className="mt-0.5 text-hifi-sm text-hifi-fg-60">{skill.description}</p>
        </div>
        <SkillStateBadge state={rowState} version={skill.availableVersion} />
      </div>

      {skill.restricted && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-hifi-md border border-hifi-destructive/20 bg-hifi-destructive-soft px-3 py-2 text-hifi-sm text-hifi-destructive"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('skillsManager.restricted.banner')}</span>
        </div>
      )}

      <SkillFactsTable facts={facts} />

      {hasUpdate && !skill.restricted && !isBuiltin && (
        <div className="rounded-hifi-lg border border-hifi-border bg-hifi-surface p-3">
          <h3 className="text-hifi-md font-semibold text-hifi-foreground">
            {t('skillsManager.detail.updateCard.title', { version: skill.availableVersion })}
          </h3>
          <p className="mt-1 text-hifi-sm text-hifi-fg-60">
            {t('skillsManager.detail.updateCard.desc')}
          </p>
          <div className="mt-2.5 flex justify-end">
            <SkillActionButton variant="primary" onClick={() => onUpdate(skill)}>
              <RefreshCw className="mr-1 size-3.5" />
              {t('skillsManager.detail.update.action')}
            </SkillActionButton>
          </div>
        </div>
      )}

      <p className="shrink-0 text-hifi-xs leading-relaxed text-hifi-fg-50">
        {t('skillsManager.footnote.disable')}
      </p>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <SkillActionButton onClick={onBack}>{t('skillsManager.detail.back')}</SkillActionButton>
        {skill.restricted ? (
          <>
            <SkillActionButton onClick={() => onViewRestrictedReason(skill)}>
              {t('skillsManager.action.viewReason')}
            </SkillActionButton>
            <SkillActionButton onClick={() => onReauthorize(skill)}>
              {t('skillsManager.action.reauthorize')}
            </SkillActionButton>
          </>
        ) : (
          <SkillActionButton onClick={() => onToggleEnabled(skill, !skill.enabled)}>
            {t(skill.enabled
              ? 'skillsManager.action.disable'
              : 'skillsManager.action.enable')}
          </SkillActionButton>
        )}
        {!isBuiltin && (
          <SkillActionButton
            variant="danger"
            data-testid="request-uninstall"
            onClick={() => onRequestUninstall(skill)}
          >
            {t('skillsManager.action.uninstall')}
          </SkillActionButton>
        )}
      </div>
    </div>
  )
}
