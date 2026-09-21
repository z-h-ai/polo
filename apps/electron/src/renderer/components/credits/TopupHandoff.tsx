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
          description={
            enterprise
              ? t('credits.topup.billingEntDescription')
              : t('credits.topup.billingDescription')
          }
          browserLabel={t('credits.topup.browserLabel')}
          desktopLabel={t('credits.topup.desktopLabel')}
          browserResponsibilities={
            enterprise
              ? [
                  t('credits.topup.billingEntBrowserBilling'),
                  t('credits.topup.billingEntBrowserAllocate'),
                ]
              : [
                  t('credits.topup.billingBrowserPay'),
                  t('credits.topup.billingBrowserInvoice'),
                ]
          }
          desktopResponsibilities={
            enterprise
              ? [
                  t('credits.topup.memberRequestValue'),
                  t('credits.topup.billingEntDesktopNotify'),
                ]
              : [
                  t('credits.topup.billingDesktopBalance', { balance }),
                  t('credits.topup.billingDesktopUsage'),
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
        description={t('credits.topup.description')}
        browserLabel={t('credits.topup.browserLabel')}
        desktopLabel={t('credits.topup.desktopLabel')}
        browserResponsibilities={[
          t('credits.topup.browserPay'),
          t('credits.topup.browserOrder'),
        ]}
        desktopResponsibilities={[
          t('credits.topup.desktopInitiate', { needed }),
          t('credits.topup.desktopCheckOnce'),
          t('credits.topup.desktopDraft', { balance }),
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
