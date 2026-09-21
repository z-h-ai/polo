/**
 * RenewFlow — manual renewal dialog (POO-70 M07, PC-F03).
 *
 * Renewal starts from the current expiry date while active; after expiry a
 * repurchase takes effect immediately. Prepaid time is capped at 12 months
 * and there is no auto-charge — the facts display these terms as status,
 * the payment itself completes in the browser.
 */

import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { addMonths, renewalBaseDate } from './circlesState'
import { FlowButton } from './flowButtons'
import type { CircleSummary } from './types'

export interface RenewFlowProps {
  circle: CircleSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Renewal duration in months (UI offers 1 by default). */
  months?: number
  /** ISO date of "today"; defaults to render time. */
  now?: string
  /** 去浏览器支付 — hands off to SubscribeFlow's browser step. */
  onPayInBrowser: () => void
}

function RenewFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[116px_minmax(0,1fr)] gap-3 border-b border-hifi-border px-[13px] py-[11px] text-hifi-base last:border-b-0">
      <dt className="text-hifi-fg-50">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  )
}

export function RenewFlow({
  circle,
  open,
  onOpenChange,
  months = 1,
  now,
  onPayInBrowser,
}: RenewFlowProps) {
  const { t } = useTranslation()
  const today = now ?? new Date().toISOString().slice(0, 10)
  const subscription = circle.subscription
  const expired = subscription ? renewalBaseDate(subscription, today) === today : false
  const baseDate = subscription ? renewalBaseDate(subscription, today) : today
  const newExpiry = addMonths(baseDate, months)
  const price = subscription?.price ?? ''

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[460px]" data-testid="circle-renew-flow">
        <DialogHeader>
          <DialogTitle>
            {t('circles.renew.title', { name: circle.name })}
          </DialogTitle>
          <DialogDescription>
            {expired
              ? t('circles.renew.subtitleExpired')
              : t('circles.renew.subtitle')}
          </DialogDescription>
        </DialogHeader>
        <dl className="grid overflow-hidden rounded-hifi-md border border-hifi-border bg-hifi-surface text-left">
          <RenewFact label={t('circles.renew.factDuration')}>
            {t('circles.renew.factDurationValue', { months, price })}
          </RenewFact>
          <RenewFact label={t('circles.renew.factStart')}>
            {expired
              ? t('circles.renew.factStartValueExpired', { date: baseDate })
              : t('circles.renew.factStartValue', { date: baseDate })}
          </RenewFact>
          <RenewFact label={t('circles.renew.factAfterRenew')}>
            {t('circles.renew.factAfterRenewValue', { date: newExpiry })}
          </RenewFact>
          <RenewFact label={t('circles.renew.factAuto')}>
            {t('circles.renew.factAutoValue')}
          </RenewFact>
          <RenewFact label={t('circles.renew.factPayLocation')}>
            {t('circles.renew.factPayLocationValue')}
          </RenewFact>
        </dl>
        <div className="flex flex-wrap justify-end gap-2">
          <FlowButton variant="quiet" onClick={() => onOpenChange(false)}>
            {t('circles.renew.cancel')}
          </FlowButton>
          <FlowButton variant="primary" onClick={onPayInBrowser}>
            {t('circles.renew.payInBrowser')}
          </FlowButton>
        </div>
      </DialogContent>
    </Dialog>
  )
}
