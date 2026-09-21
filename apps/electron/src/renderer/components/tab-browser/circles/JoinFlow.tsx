/**
 * JoinFlow — joining a free circle (POO-70 M07).
 *
 * Two dialogs: the confirmation (免费 · 确认后立即生效 — free circles take
 * effect immediately) and the pending-approval notice (批准前，这个圈子的
 * 作品不会出现). Paid circles go through SubscribeFlow instead.
 */

import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FlowButton } from './flowButtons'
import type { CircleSummary } from './types'

export interface JoinFlowProps {
  circle: CircleSummary
  /** 'confirm' — free join confirmation; 'pending' — submitted, awaiting approval. */
  variant: 'confirm' | 'pending'
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm?: () => void
}

export function JoinFlow({
  circle,
  variant,
  open,
  onOpenChange,
  onConfirm,
}: JoinFlowProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]" data-testid="circle-join-flow">
        {variant === 'confirm' ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {t('circles.join.dialogTitle', { name: circle.name })}
              </DialogTitle>
              <DialogDescription>{t('circles.join.dialogSubtitle')}</DialogDescription>
            </DialogHeader>
            <dl className="grid overflow-hidden rounded-hifi-md border border-hifi-border bg-hifi-surface text-left">
              <JoinFact label={t('circles.join.factPrice')}>
                {t('circles.join.factPriceValue')}
              </JoinFact>
              <JoinFact label={t('circles.join.factGets')}>
                {t('circles.join.factGetsValue', {
                  apps: circle.appCount,
                  skills: circle.skillCount,
                })}
              </JoinFact>
              <JoinFact label={t('circles.join.factAfter')}>
                {t('circles.join.factAfterValue')}
              </JoinFact>
            </dl>
            <div className="flex flex-wrap justify-end gap-2">
              <FlowButton variant="quiet" onClick={() => onOpenChange(false)}>
                {t('circles.join.decline')}
              </FlowButton>
              <FlowButton variant="primary" onClick={onConfirm}>
                {t('circles.join.confirm')}
              </FlowButton>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('circles.join.pendingTitle')}</DialogTitle>
              <DialogDescription>{t('circles.join.pendingSubtitle')}</DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-3 rounded-hifi-md border border-hifi-border bg-hifi-info-soft p-4 text-left">
              <Info className="mt-0.5 size-4 shrink-0 text-hifi-info" aria-hidden="true" />
              <span>
                <strong className="block text-hifi-md font-semibold text-hifi-foreground">
                  {t('circles.join.pendingHeading')}
                </strong>
                <small className="mt-0.5 block text-hifi-base text-hifi-fg-60">
                  {t('circles.join.pendingBody')}
                </small>
              </span>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <FlowButton variant="primary" onClick={() => onOpenChange(false)}>
                {t('circles.join.pendingAck')}
              </FlowButton>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function JoinFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-3 border-b border-hifi-border px-[13px] py-[11px] text-hifi-base last:border-b-0">
      <dt className="text-hifi-fg-50">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  )
}
