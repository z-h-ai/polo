/**
 * SubscribeFlow — paid circle subscription via the system browser
 * (POO-70 M07, C-R08). Payment completes in the browser; the desktop app
 * only initiates and re-checks. The return-fail state shows the submitted
 * order and offers a re-check — it never fakes an expiry.
 */

import { RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  HandoffCard,
  StateCard,
  SystemScreen,
  type StateCardFact,
} from '@/components/hifi'
import { FlowButton } from './flowButtons'
import type { CircleSummary } from './types'

export interface SubscribeFlowProps {
  circle: CircleSummary
  /** 'handoff' — browser payment step; 'return-fail' — order submitted, status unconfirmed. */
  variant: 'handoff' | 'return-fail'
  /** Renewal-repurchase handoff (already expired) labels the title differently. */
  restore?: boolean
  onCancel: () => void
  /** 在浏览器继续 — opens the system browser. */
  onContinueInBrowser: () => void
  /** 重新核对 — re-check the subscription status. */
  onRecheck?: () => void
  /** 返回我的圈子 (return-fail only). */
  onBackToList?: () => void
}

export function SubscribeFlow({
  circle,
  variant,
  restore = false,
  onCancel,
  onContinueInBrowser,
  onRecheck,
  onBackToList,
}: SubscribeFlowProps) {
  const { t } = useTranslation()
  const price = circle.subscription?.price ?? ''

  if (variant === 'return-fail') {
    const facts: StateCardFact[] = [
      { label: t('circles.pay.factOrder'), value: t('circles.pay.factOrderValue') },
      {
        label: t('circles.pay.factMembership'),
        value: t('circles.pay.factMembershipValue'),
      },
      { label: t('circles.pay.factNext'), value: t('circles.pay.factNextValue') },
    ]
    return (
      <SystemScreen maxWidth={520}>
        <StateCard
          data-testid="circle-subscribe-return-fail"
          icon={{ kind: 'destructive' }}
          eyebrow={t('circles.pay.returnFailEyebrow')}
          title={t('circles.pay.returnFailTitle')}
          description={t('circles.pay.returnFailDescription')}
          facts={facts}
          actions={
            <>
              {onBackToList && (
                <FlowButton variant="quiet" onClick={onBackToList}>
                  {t('circles.pay.back')}
                </FlowButton>
              )}
              {onRecheck && (
                <FlowButton variant="primary" onClick={onRecheck}>
                  <RotateCw className="size-3.5" aria-hidden="true" />
                  {t('circles.pay.recheck')}
                </FlowButton>
              )}
            </>
          }
        />
      </SystemScreen>
    )
  }

  return (
    <SystemScreen maxWidth={640}>
      <HandoffCard
        data-testid="circle-subscribe-handoff"
        eyebrow={t('circles.pay.eyebrow')}
        title={
          restore
            ? t('circles.pay.titleRestore', { name: circle.name, price })
            : t('circles.pay.title', { name: circle.name, price })
        }
        description={t('circles.pay.handoffDescription')}
        browserLabel={t('circles.pay.browserLabel')}
        desktopLabel={t('circles.pay.desktopLabel')}
        browserResponsibilities={[
          t('circles.pay.browserPay'),
          t('circles.pay.browserOrder'),
        ]}
        desktopResponsibilities={[
          t('circles.pay.desktopInitiate', { price }),
          t('circles.pay.desktopRecheck'),
          t('circles.pay.desktopRules'),
        ]}
        actions={
          <>
            <FlowButton variant="quiet" onClick={onCancel}>
              {t('common.cancel')}
            </FlowButton>
            <FlowButton variant="primary" onClick={onContinueInBrowser}>
              {t('circles.pay.continue')}
            </FlowButton>
          </>
        }
      />
    </SystemScreen>
  )
}
