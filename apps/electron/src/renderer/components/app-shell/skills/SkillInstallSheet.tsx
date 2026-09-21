import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SkillActionButton, SkillFactsTable } from './parts'
import { SkillGlyphTile } from './SkillGlyphTile'
import type { SkillInstallPhase, SkillSpaceKind } from './types'

export interface SkillInstallSheetProps {
  name: string
  description: string
  /** e.g. "晨星增长工作室 · 晨星增长圈 / 晨星设计圈". */
  provider: string
  version: string
  spaceKind: SkillSpaceKind
  spaceName: string
  /** What the skill needs from the conversation. */
  requiresNote?: string
  phase?: SkillInstallPhase
  /** Failure copy shown in the failed phase. */
  failureDescription?: string
  onInstall: () => void
  onRetry: () => void
  onBack: () => void
  className?: string
}

/**
 * SkillInstallSheet — the install detail surface (P-M06-INSTALL-PERSONAL /
 * INSTALL-ENT / INSTALL-FAILED). States the default-disabled rule up front:
 * installing never enables the skill; the user opts in afterwards.
 */
export function SkillInstallSheet({
  name,
  description,
  provider,
  version,
  spaceKind,
  spaceName,
  requiresNote,
  phase = 'review',
  failureDescription,
  onInstall,
  onRetry,
  onBack,
  className,
}: SkillInstallSheetProps) {
  const { t } = useTranslation()

  const facts = [
    { label: t('skillsManager.install.provider'), value: provider },
    {
      label: t('skillsManager.install.location'),
      value: t('skillsManager.install.location.value', { space: spaceName }),
    },
    { label: t('skillsManager.install.scope'), value: t('skillsManager.install.scope.value') },
    { label: t('skillsManager.install.version'), value: `v${version}` },
    {
      label: t('skillsManager.install.requires'),
      value: requiresNote ?? t('skillsManager.install.requires.default'),
    },
  ]

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto', className)}>
      <div className="flex items-center gap-3 rounded-hifi-lg border border-hifi-border bg-hifi-surface p-3">
        <SkillGlyphTile glyph="✧" />
        <div className="min-w-0">
          <h2 className="truncate text-hifi-lg font-semibold text-hifi-foreground">{name}</h2>
          <p className="mt-0.5 text-hifi-sm text-hifi-fg-60">{description}</p>
        </div>
      </div>

      <SkillFactsTable facts={facts} />

      {phase === 'failed' && (
        <div
          role="alert"
          data-testid="install-failed-card"
          className="rounded-hifi-lg border border-hifi-destructive/20 bg-hifi-destructive-soft p-3"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-hifi-destructive" />
            <div>
              <h3 className="text-hifi-md font-semibold text-hifi-destructive">
                {t('skillsManager.install.failed.title')}
              </h3>
              <p className="mt-1 text-hifi-sm text-hifi-fg-70">
                {failureDescription ?? t('skillsManager.install.failed.desc')}
              </p>
            </div>
          </div>
          <div className="mt-2.5 flex items-center justify-end gap-2">
            <SkillActionButton onClick={onBack}>{t('skillsManager.install.back')}</SkillActionButton>
            <SkillActionButton variant="primary" onClick={onRetry}>
              {t('skillsManager.install.failed.retry')}
            </SkillActionButton>
          </div>
        </div>
      )}

      {phase !== 'failed' && (
        <>
          <p className="shrink-0 text-hifi-xs leading-relaxed text-hifi-fg-50">
            {t('skillsManager.install.footnote')}
          </p>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <SkillActionButton onClick={onBack}>{t('skillsManager.install.back')}</SkillActionButton>
            <SkillActionButton
              variant="primary"
              onClick={phase === 'review' ? onInstall : onRetry}
              disabled={phase === 'installing'}
            >
              {phase === 'installing'
                ? t('skillsManager.install.installing')
                : t('skillsManager.install.action')}
            </SkillActionButton>
          </div>
        </>
      )}
    </div>
  )
}
