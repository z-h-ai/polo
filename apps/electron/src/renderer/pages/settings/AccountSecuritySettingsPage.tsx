import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@polo-ai/ui'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { useAdminPassword } from '@/hooks/useAdminPassword'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'account-security',
}

export default function AccountSecuritySettingsPage() {
  const { t } = useTranslation()
  const passwordSettings = useAdminPassword()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const submitting = passwordSettings.status === 'submitting'

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const success = await passwordSettings.submit(password, confirmation)
    if (success) {
      setPassword('')
      setConfirmation('')
    }
  }

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title={t('settings.accountSecurity.title')}
        actions={<HeaderMenu route={routes.view.settings('account-security')} />}
      />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-3xl px-5 py-7">
            <SettingsSection
              title={t('settings.accountSecurity.password.title')}
              description={t('settings.accountSecurity.password.description')}
            >
              <SettingsCard>
                <form onSubmit={handleSubmit} className="space-y-4 p-4">
                  <div className="space-y-2">
                    <Label htmlFor="account-password">
                      {t('settings.accountSecurity.password.newPassword')}
                    </Label>
                    <Input
                      id="account-password"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value)
                        passwordSettings.clearMessage()
                      }}
                      disabled={submitting}
                      placeholder={t('settings.accountSecurity.password.placeholder')}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="account-password-confirmation">
                      {t('settings.accountSecurity.password.confirmPassword')}
                    </Label>
                    <Input
                      id="account-password-confirmation"
                      type="password"
                      autoComplete="new-password"
                      value={confirmation}
                      onChange={(event) => {
                        setConfirmation(event.target.value)
                        passwordSettings.clearMessage()
                      }}
                      disabled={submitting}
                      placeholder={t('settings.accountSecurity.password.confirmPlaceholder')}
                    />
                  </div>

                  {passwordSettings.message ? (
                    <p
                      role={passwordSettings.status === 'error' ? 'alert' : 'status'}
                      className={passwordSettings.status === 'error' ? 'text-sm text-destructive' : 'text-sm text-accent'}
                    >
                      {passwordSettings.message}
                    </p>
                  ) : null}

                  <div className="flex justify-end">
                    <Button type="submit" disabled={submitting || !password || !confirmation}>
                      {submitting ? (
                        <>
                          <Spinner className="mr-1.5" />
                          {t('settings.accountSecurity.password.submitting')}
                        </>
                      ) : (
                        t('settings.accountSecurity.password.submit')
                      )}
                    </Button>
                  </div>
                </form>
              </SettingsCard>
            </SettingsSection>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
