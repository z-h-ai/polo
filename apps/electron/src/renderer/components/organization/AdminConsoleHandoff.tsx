/**
 * AdminConsoleHandoff — enterprise admin console browser handoff
 * (POO-70 M10, P-M10-ADMIN-BROWSER). The console itself lives in the
 * system browser; Polo opens it and re-checks the management
 * qualification once the user returns (toast, see accountSettings.
 * adminReturnToast).
 */

import { useTranslation } from 'react-i18next'
import { HandoffCard, SystemScreen } from '@/components/hifi'
import { FlowButton } from '@/components/tab-browser/circles/flowButtons'

export interface AdminConsoleHandoffProps {
  organizationName: string
  /** Localized role label (e.g. t('organization.role.owner')). */
  roleLabel: string
  onCancel: () => void
  /** 在浏览器打开 — opens the system browser. */
  onOpenInBrowser: () => void
}

export function AdminConsoleHandoff({
  organizationName,
  roleLabel,
  onCancel,
  onOpenInBrowser,
}: AdminConsoleHandoffProps) {
  const { t } = useTranslation()
  return (
    <SystemScreen maxWidth={640}>
      <HandoffCard
        data-testid="admin-console-handoff"
        eyebrow={t('accountSettings.adminHandoff.eyebrow')}
        title={t('accountSettings.adminHandoff.title', { name: organizationName })}
        facts={[
          { label: t('accountSettings.adminHandoff.fact.role'), value: roleLabel },
          {
            label: t('accountSettings.adminHandoff.fact.scope'),
            value: t('accountSettings.adminHandoff.fact.scopeValue'),
          },
          {
            label: t('accountSettings.adminHandoff.fact.done'),
            value: t('accountSettings.adminHandoff.fact.doneValue'),
          },
        ]}
        actions={
          <>
            <FlowButton variant="quiet" onClick={onCancel}>
              {t('common.cancel')}
            </FlowButton>
            <FlowButton variant="primary" onClick={onOpenInBrowser}>
              {t('accountSettings.adminHandoff.continue')}
            </FlowButton>
          </>
        }
      />
    </SystemScreen>
  )
}
