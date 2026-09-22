import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { SkillActionButton, SkillFactsTable } from '../parts'

export interface ShareToOrgDialogProps {
  orgName: string
  skillName: string
  skillVersion?: string
  /** `compose` = P-M06-SHARE-ENT; `submitted` = P-M06-SHARE-SUBMITTED. */
  phase?: 'compose' | 'submitted'
  defaultNote?: string
  onSubmit: (note: string) => void
  onCancel: () => void
  onBack: () => void
  className?: string
}

/**
 * ShareToOrgDialog — submit a local skill for enterprise review
 * (P-M06-SHARE-ENT → P-M06-SHARE-SUBMITTED). Submitting is a review
 * request, not publication: the submitted state spells out that
 * colleagues only see the skill after review passes and it is
 * distributed.
 */
export function ShareToOrgDialog({
  orgName,
  skillName,
  skillVersion,
  phase = 'compose',
  defaultNote = '',
  onSubmit,
  onCancel,
  onBack,
  className,
}: ShareToOrgDialogProps) {
  const { t } = useTranslation()
  const [note, setNote] = React.useState(defaultNote)

  const facts = [
    { label: t('skillsManager.share.includes'), value: t('skillsManager.share.includes.value') },
    { label: t('skillsManager.share.excludes'), value: t('skillsManager.share.excludes.value') },
  ]

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto', className)}>
      {phase === 'submitted' && (
        <div
          role="status"
          data-testid="share-submitted-banner"
          className="rounded-hifi-md border border-hifi-success/20 bg-hifi-success-soft px-3 py-2 text-hifi-sm font-medium text-hifi-success"
        >
          {t('skillsManager.share.submitted.banner')}
        </div>
      )}

      <div className="rounded-hifi-lg border border-hifi-border bg-hifi-surface p-3">
        <h2 className="text-hifi-lg font-semibold text-hifi-foreground">
          {phase === 'submitted' ? skillName : t('skillsManager.share.title', { org: orgName })}
        </h2>
        <p className="mt-0.5 text-hifi-sm text-hifi-fg-60">
          {phase === 'submitted'
            ? t('skillsManager.share.submitted.desc')
            : t('skillsManager.share.desc')}
        </p>

        {phase === 'compose' ? (
          <>
            <p className="mt-3 text-hifi-sm font-medium text-hifi-foreground">
              {skillName}
              {skillVersion ? ` · v${skillVersion}` : ''}
            </p>
            <div className="mt-2">
              <SkillFactsTable facts={facts} className="bg-hifi-fg-3" />
            </div>
            <label className="mt-3 block text-hifi-sm font-medium text-hifi-foreground">
              {t('skillsManager.share.note.label')}
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={t('skillsManager.share.note.placeholder')}
                rows={3}
                className="mt-1.5 w-full resize-none rounded-hifi-md border border-hifi-border bg-hifi-surface px-2.5 py-2 text-hifi-sm text-hifi-foreground outline-none placeholder:text-hifi-fg-50 focus:border-hifi-accent"
              />
            </label>
            <div className="mt-3 flex items-center justify-end gap-2">
              <SkillActionButton onClick={onCancel}>{t('skillsManager.share.cancel')}</SkillActionButton>
              <SkillActionButton
                variant="primary"
                data-testid="share-submit"
                onClick={() => onSubmit(note)}
              >
                {t('skillsManager.share.submit')}
              </SkillActionButton>
            </div>
          </>
        ) : (
          <div className="mt-3 flex justify-end">
            <SkillActionButton variant="primary" onClick={onBack}>
              {t('skillsManager.share.submitted.back')}
            </SkillActionButton>
          </div>
        )}
      </div>
    </div>
  )
}
