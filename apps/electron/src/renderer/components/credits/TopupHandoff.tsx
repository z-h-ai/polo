/**
 * TopupHandoff — browser topup / billing handoff (POO-70 M09).
 *
 * Wraps the shared hifi HandoffCard in a SystemScreen: the topup itself
 * completes in the system browser, the desktop app initiates and then
 * checks the arrival once. Variants cover the pre-send block entry, the
 * mid-stream cut entry, and the account-menu billing pages for personal
 * and enterprise spaces.
 */

import { useTranslation } from 'react-i18next'
import { HandoffCard, SystemScreen } from '@/components/hifi'
import { FlowButton } from '@/components/tab-browser/circles/flowButtons'

export type TopupHandoffVariant =
  | 'topup'            // P-M09-BROWSER — from the pre-send gate
  | 'topup-stream'     // P-M09-BROWSER-STREAM — from the mid-stream cut
  | 'billing'          // P-M09-BROWSER-MENU — personal 充值与账单
  | 'billing-enterprise' // P-M09-BROWSER-MENU-ENT — enterprise credits & billing

export interface TopupHandoffProps {
  variant?: TopupHandoffVariant
  /** Current balance snapshot shown on the topup variants. */
  balance?: number
  /** Credits the pending send needs. */
  needed?: number
  onCancel: () => void
  /** 在浏览器继续 / 在浏览器查看账单. */
  onContinueInBrowser: () => void
}

export function TopupHandoff({
  variant = 'topup',
  balance = 0,
  needed = 0,
  onCancel,
  onContinueInBrowser,
}: TopupHandoffProps) {
  const { t } = useTranslation()

  if (variant === 'billing' || variant === 'billing-enterprise') {
    const enterprise = variant === 'billing-enterprise'
    return (
      <SystemScreen maxWidth={640}>
        <HandoffCard
          data-testid={`topup-handoff-${variant}`}
          eyebrow={
            enterprise
              ? t('credits.topup.billingEntEyebrow')
              : t('credits.topup.billingEyebrow')
          }
          title={
            enterprise
              ? t('credits.topup.billingEntTitle')
              : t('credits.topup.billingTitle')
          }
          facts={
            enterprise
              ? [
                  {
                    label: t('credits.topup.fact.entSource'),
                    value: t('credits.topup.fact.entSourceValue'),
                  },
                  {
                    label: t('credits.topup.fact.entRequest'),
                    value: t('credits.topup.fact.entRequestValue'),
                  },
                  {
                    label: t('credits.topup.fact.entBilling'),
                    value: t('credits.topup.fact.entBillingValue'),
                  },
                  {
                    label: t('credits.topup.fact.entEffect'),
                    value: t('credits.topup.fact.entEffectValue'),
                  },
                ]
              : [
                  {
                    label: t('credits.topup.fact.balance'),
                    value: t('credits.topup.fact.balanceValue', { balance }),
                  },
                  {
                    label: t('credits.topup.fact.usage'),
                    value: t('credits.topup.fact.usageValue'),
                  },
                  {
                    label: t('credits.topup.fact.method'),
                    value: t('credits.topup.fact.methodValue'),
                  },
                  {
                    label: t('credits.topup.fact.done'),
                    value: t('credits.topup.fact.doneValue'),
                  },
                ]
          }
          actions={
            <>
              <FlowButton variant="quiet" onClick={onCancel}>
                {t('common.cancel')}
              </FlowButton>
              <FlowButton variant="primary" onClick={onContinueInBrowser}>
                {enterprise
                  ? t('credits.topup.viewBilling')
                  : t('credits.topup.continue')}
              </FlowButton>
            </>
          }
        />
      </SystemScreen>
    )
  }

  return (
    <SystemScreen maxWidth={640}>
      <HandoffCard
        data-testid={`topup-handoff-${variant}`}
        eyebrow={t('credits.topup.eyebrow')}
        title={t('credits.topup.title')}
        facts={[
          {
            label: t('credits.topup.fact.balance'),
            value: t('credits.topup.fact.balanceValue', { balance }),
          },
          {
            label: t('credits.topup.fact.needed'),
            value: t('credits.topup.fact.neededValue', { needed }),
          },
          {
            label: t('credits.topup.fact.method'),
            value: t('credits.topup.fact.methodValue'),
          },
          {
            label: t('credits.topup.fact.confirm'),
            value: t('credits.topup.fact.confirmValue'),
          },
        ]}
        actions={
          <>
            <FlowButton variant="quiet" onClick={onCancel}>
              {t('common.cancel')}
            </FlowButton>
            <FlowButton variant="primary" onClick={onContinueInBrowser}>
              {t('credits.topup.continue')}
            </FlowButton>
          </>
        }
      />
    </SystemScreen>
  )
}
