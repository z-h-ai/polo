import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import { AccountPasswordSettingsForm } from './AccountPasswordSettingsForm'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'account-security',
}

export default function AccountSecuritySettingsPage() {
  const { t } = useTranslation()

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={t('settings.accountSecurity.title')}
        actions={<HeaderMenu route={routes.view.settings('account-security')} />}
      />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-3xl px-5 py-7">
            <AccountPasswordSettingsForm />
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
