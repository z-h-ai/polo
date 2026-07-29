import React, { useCallback, useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { initReactI18next } from 'react-i18next'
import { setupI18n } from '@polo-ai/shared/i18n'
import { AdminLoginStep } from '../../src/renderer/components/onboarding/AdminLoginStep'
import { AccountPasswordSettingsForm } from '../../src/renderer/pages/settings/AccountPasswordSettingsForm'
import type { AdminSendPhoneAuthCodeResult } from '../../src/shared/types'

setupI18n([initReactI18next])

type Stage = 'loading' | 'login' | 'security' | 'complete'

declare global {
  interface Window {
    phoneAuthE2e: {
      showLogin(): void
    }
  }
}

function Harness() {
  const [stage, setStage] = useState<Stage>('loading')
  const [phoneAuthEnabled, setPhoneAuthEnabled] = useState<boolean>()
  const [errorMessage, setErrorMessage] = useState<string>()
  const [isLoading, setIsLoading] = useState(false)
  const [lastIdentifier, setLastIdentifier] = useState('')

  const loadDiscovery = useCallback(async () => {
    const authConfig = await window.electronAPI.adminGetAuthConfig()
    if (!authConfig.phoneAuthEnabled) {
      setPhoneAuthEnabled(false)
      setStage('login')
      return
    }

    const discovery = await window.electronAPI.adminGetPhoneAuthChallengeConfig()
    setPhoneAuthEnabled(discovery.success)
    if (!discovery.success) {
      setErrorMessage('phone_auth_configuration_error')
    }
    setStage('login')
  }, [])

  useEffect(() => {
    void loadDiscovery()
  }, [loadDiscovery])

  useEffect(() => {
    window.phoneAuthE2e = {
      showLogin() {
        setErrorMessage(undefined)
        setLastIdentifier('')
        setStage('login')
      },
    }
  }, [])

  const sendPhoneCode = async (phone: string): Promise<AdminSendPhoneAuthCodeResult> => {
    setErrorMessage(undefined)
    const challenge = await window.electronAPI.adminAcquirePhoneAuthChallenge()
    if (challenge.success === false) {
      setErrorMessage(challenge.errorCode)
      return challenge
    }
    const result = await window.electronAPI.adminSendPhoneAuthCode(
      phone,
      challenge.challengeToken,
    )
    if (result.success) {
      document.body.dataset.phoneAuthResendAfter = String(result.resendAfter)
    }
    if (result.success === false) setErrorMessage(result.errorCode)
    return result
  }

  const verifyPhoneCode = async (phone: string, code: string): Promise<boolean> => {
    setIsLoading(true)
    setErrorMessage(undefined)
    try {
      const result = await window.electronAPI.adminVerifyPhoneAuthCode(phone, code)
      if (result.success === false) {
        setErrorMessage(result.errorCode)
        return false
      }
      document.body.dataset.lastPhoneNewUser = String(result.isNewUser)
      setStage('security')
      return true
    } finally {
      setIsLoading(false)
    }
  }

  const passwordLogin = async (identifier: string, password: string) => {
    setIsLoading(true)
    setErrorMessage(undefined)
    try {
      const result = await window.electronAPI.adminLogin(identifier, password)
      if (result.success === false) {
        setErrorMessage(result.errorCode)
        return
      }
      setLastIdentifier(identifier)
      setStage('complete')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <main
      id="phone-auth-e2e-root"
      data-stage={stage}
      data-last-identifier={lastIdentifier}
    >
      {stage === 'loading' ? <p>Loading</p> : null}
      {stage === 'login' ? (
        <AdminLoginStep
          errorMessage={errorMessage}
          isLoading={isLoading}
          phoneAuthEnabled={phoneAuthEnabled}
          onClearError={() => setErrorMessage(undefined)}
          onSendPhoneCode={sendPhoneCode}
          onVerifyPhoneCode={verifyPhoneCode}
          onSubmit={passwordLogin}
        />
      ) : null}
      {stage === 'security' ? (
        <AccountPasswordSettingsForm />
      ) : null}
      {stage === 'complete' ? <p role="status">login_complete</p> : null}
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />)
