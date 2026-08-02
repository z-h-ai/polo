import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { AccountPasswordSettingsForm } from './AccountPasswordSettingsForm'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'account-security',
}

export default function AccountSecuritySettingsPage() {
  const { t } = useTranslation()
  const appShell = useOptionalAppShellContext()
  const isAdminLoggedIn = Boolean(appShell?.currentAdminUser?.username)

  return (
    <div data-testid="account-security-settings-page" className="flex h-full flex-col">
      <PanelHeader
        title={t('settings.accountSecurity.title')}
        actions={<HeaderMenu route={routes.view.settings('account-security')} />}
      />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-3xl px-5 py-7">
            {isAdminLoggedIn ? (
              <AccountPasswordSettingsForm />
            ) : (
              <p
                className="text-sm text-muted-foreground"
                data-testid="account-security-unavailable"
              >
                {t('settings.accountSecurity.unavailable')}
              </p>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
