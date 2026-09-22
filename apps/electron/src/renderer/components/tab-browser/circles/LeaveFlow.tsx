/**
 * LeaveFlow — leaving a circle confirmation (POO-70 M07).
 *
 * Leaving only revokes this circle's sources. The confirmation states which
 * works stay usable (authorized by another circle) and which become
 * unavailable (provided only here) — D-PC-09 on the confirmation side.
 */

import { CircleCheck, CircleX } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FlowButton } from './flowButtons'
import type { CircleSourcedApp, CircleSummary } from './types'

export interface LeaveFlowProps {
  circle: CircleSummary
  /** All works the circle currently provides (apps + skills), deduped. */
  works: CircleSourcedApp[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 确认退出 — the host applies the source revocation. */
  onConfirm: () => void
}

export function LeaveFlow({
  circle,
  works,
  open,
  onOpenChange,
  onConfirm,
}: LeaveFlowProps) {
  const { t } = useTranslation()

  const circleWorks = works.filter(work =>
    work.sources.some(source => source.circleId === circle.id),
  )
  // Works that stay usable: another circle's source remains valid (D-PC-09).
  const stillUsable = circleWorks.filter(work =>
    work.sources.some(
      source => source.circleId !== circle.id && source.valid,
    ),
  )
  const stillUsableIds = new Set(stillUsable.map(work => work.appId))
  const onlyHere = circleWorks.filter(work => !stillUsableIds.has(work.appId))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[480px]" data-testid="circle-leave-flow">
        <DialogHeader>
          <DialogTitle>{t('circles.leave.title', { name: circle.name })}</DialogTitle>
          <DialogDescription>{t('circles.leave.subtitle')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2.5 text-left">
          {stillUsable.length > 0 && (
            <div className="flex items-start gap-3 rounded-hifi-md border border-hifi-border bg-hifi-success-soft p-4">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-hifi-success" aria-hidden="true" />
              <span>
                <strong className="block text-hifi-md font-semibold text-hifi-foreground">
                  {t('circles.leave.stillUsableHeading')}
                </strong>
                <small className="mt-0.5 block text-hifi-base text-hifi-fg-60">
                  {t('circles.leave.stillUsableBody', {
                    works: stillUsable.map(work => work.name).join(t('circles.work.sourceSeparator')),
                  })}
                </small>
              </span>
            </div>
          )}
          {onlyHere.length > 0 && (
            <div className="flex items-start gap-3 rounded-hifi-md border border-hifi-border bg-hifi-destructive-soft p-4">
              <CircleX className="mt-0.5 size-4 shrink-0 text-hifi-destructive" aria-hidden="true" />
              <span>
                <strong className="block text-hifi-md font-semibold text-hifi-foreground">
                  {t('circles.leave.onlyHereHeading')}
                </strong>
                <small className="mt-0.5 block text-hifi-base text-hifi-fg-60">
                  {t('circles.leave.onlyHereBody', {
                    works: onlyHere.map(work => work.name).join(t('circles.work.sourceSeparator')),
                  })}
                </small>
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <FlowButton variant="quiet" onClick={() => onOpenChange(false)}>
            {t('circles.leave.cancel')}
          </FlowButton>
          <FlowButton variant="danger" onClick={onConfirm}>
            {t('circles.leave.confirm')}
          </FlowButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
