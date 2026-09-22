import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { SkillActionButton } from './parts'

export interface SkillDeniedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skillName: string
  /** e.g. "晨星科技". */
  sourceName: string
  /** Keep chatting with already-enabled skills. */
  onUseEnabled: () => void
  /** Jump to the enterprise shared library. */
  onViewShared: () => void
}

/**
 * SkillDeniedDialog — enabling a skill failed because the account has no
 * grant for it (P-M06-SKILL-DENIED). Points to the org admin path and
 * makes clear the rest of the conversation is unaffected.
 */
export function SkillDeniedDialog({
  open,
  onOpenChange,
  skillName,
  sourceName,
  onUseEnabled,
  onViewShared,
}: SkillDeniedDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px]">
        <DialogHeader>
          <DialogTitle>
            {t('skillsManager.denied.title', { name: skillName })}
          </DialogTitle>
          <DialogDescription>
            {t('skillsManager.denied.subtitle')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between rounded-hifi-md border border-hifi-border bg-hifi-fg-3 px-3 py-2.5">
          <span className="flex flex-col">
            <strong className="text-hifi-md font-semibold text-hifi-foreground">
              {t('skillsManager.denied.impact')}
            </strong>
            <small className="text-hifi-xs text-hifi-fg-50">
              {t('skillsManager.denied.impact.source', { source: sourceName })}
            </small>
          </span>
        </div>

        <p className="text-hifi-sm leading-relaxed text-hifi-fg-60">
          {t('skillsManager.denied.note')}
        </p>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onUseEnabled}>
            {t('skillsManager.denied.useEnabled')}
          </Button>
          <SkillActionButton variant="primary" onClick={onViewShared}>
            {t('skillsManager.denied.viewShared')}
          </SkillActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
