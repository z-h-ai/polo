import { useCallback, useState } from 'react'
import { i18n } from '@polo-ai/shared/i18n'

export type AdminPasswordValidationError = 'too_short' | 'mismatch'
export type AdminPasswordStatus = 'idle' | 'submitting' | 'success' | 'error'

export function validateAdminPassword(
  password: string,
  confirmation: string,
): AdminPasswordValidationError | null {
  if (password.length < 8) return 'too_short'
  if (password !== confirmation) return 'mismatch'
  return null
}

export function useAdminPassword() {
  const [status, setStatus] = useState<AdminPasswordStatus>('idle')
  const [message, setMessage] = useState<string>()

  const clearMessage = useCallback(() => {
    setStatus('idle')
    setMessage(undefined)
  }, [])

  const submit = useCallback(async (password: string, confirmation: string): Promise<boolean> => {
    if (status === 'submitting') return false

    const validationError = validateAdminPassword(password, confirmation)
    if (validationError) {
      setStatus('error')
      setMessage(i18n.t(`settings.accountSecurity.password.${validationError}`))
      return false
    }

    setStatus('submitting')
    setMessage(undefined)
    try {
      const result = await window.electronAPI.adminSetPassword(password)
      if (!result.success) {
        setStatus('error')
        setMessage(
          result.errorCode === 'UNAUTHORIZED'
            ? i18n.t('settings.accountSecurity.password.sessionExpired')
            : i18n.t('settings.accountSecurity.password.genericError'),
        )
        return false
      }

      setStatus('success')
      setMessage(i18n.t('settings.accountSecurity.password.success'))
      return true
    } catch {
      setStatus('error')
      setMessage(i18n.t('settings.accountSecurity.password.networkError'))
      return false
    }
  }, [status])

  return {
    status,
    message,
    clearMessage,
    submit,
  }
}
