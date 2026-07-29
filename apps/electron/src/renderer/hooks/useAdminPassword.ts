import { useCallback, useRef, useState } from 'react'
import { i18n } from '@polo-ai/shared/i18n'
import type { AdminSetPasswordResult } from '../../shared/types'

export type AdminPasswordValidationError = 'too_short' | 'mismatch'
export type AdminPasswordStatus = 'idle' | 'submitting' | 'success' | 'error'
export type AdminPasswordSubmitOutcome =
  | { success: true }
  | {
      success: false
      reason:
        | AdminPasswordValidationError
        | 'busy'
        | 'session_expired'
        | 'request_failed'
        | 'network_error'
    }

export function validateAdminPassword(
  password: string,
  confirmation: string,
): AdminPasswordValidationError | null {
  if (password.length < 8) return 'too_short'
  if (password !== confirmation) return 'mismatch'
  return null
}

export function createAdminPasswordSubmitter(
  request: (password: string) => Promise<AdminSetPasswordResult>,
): (password: string, confirmation: string) => Promise<AdminPasswordSubmitOutcome> {
  let inFlight = false

  return async (password, confirmation) => {
    if (inFlight) return { success: false, reason: 'busy' }

    const validationError = validateAdminPassword(password, confirmation)
    if (validationError) {
      return { success: false, reason: validationError }
    }

    inFlight = true
    try {
      const result = await request(password)
      if (result.success) return { success: true }
      return {
        success: false,
        reason: result.errorCode === 'UNAUTHORIZED' ? 'session_expired' : 'request_failed',
      }
    } catch {
      return { success: false, reason: 'network_error' }
    } finally {
      inFlight = false
    }
  }
}

export function useAdminPassword() {
  const [status, setStatus] = useState<AdminPasswordStatus>('idle')
  const [message, setMessage] = useState<string>()
  const submitter = useRef(
    createAdminPasswordSubmitter(password => window.electronAPI.adminSetPassword(password)),
  )

  const clearMessage = useCallback(() => {
    setStatus('idle')
    setMessage(undefined)
  }, [])

  const submit = useCallback(async (password: string, confirmation: string): Promise<boolean> => {
    const validationError = validateAdminPassword(password, confirmation)
    if (validationError) {
      setStatus('error')
      setMessage(i18n.t(`settings.accountSecurity.password.${validationError}`))
      return false
    }

    setStatus('submitting')
    setMessage(undefined)
    const outcome = await submitter.current(password, confirmation)
    if (outcome.success) {
      setStatus('success')
      setMessage(i18n.t('settings.accountSecurity.password.success'))
      return true
    }

    if (outcome.reason === 'busy') {
      return false
    }

    setStatus('error')
    switch (outcome.reason) {
      case 'too_short':
      case 'mismatch':
        setMessage(i18n.t(`settings.accountSecurity.password.${outcome.reason}`))
        break
      case 'session_expired':
        setMessage(i18n.t('settings.accountSecurity.password.sessionExpired'))
        break
      case 'network_error':
        setMessage(i18n.t('settings.accountSecurity.password.networkError'))
        break
      default:
        setMessage(i18n.t('settings.accountSecurity.password.genericError'))
    }
    return false
  }, [])

  return {
    status,
    message,
    clearMessage,
    submit,
  }
}
