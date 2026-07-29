import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Spinner } from '@polo-ai/ui'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsCard } from '@/components/settings/SettingsCard'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { useAdminPassword } from '@/hooks/useAdminPassword'

export function AccountPasswordSettingsForm() {
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
    <SettingsSection
      title={t('settings.accountSecurity.password.title')}
      description={t('settings.accountSecurity.password.description')}
    >
      <SettingsCard>
        <form
          data-testid="account-security-password-form"
          onSubmit={handleSubmit}
          className="space-y-4 p-4"
        >
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
  )
}
