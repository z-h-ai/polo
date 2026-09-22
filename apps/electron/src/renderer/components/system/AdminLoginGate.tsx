import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  useAuthFlow,
  type AuthFlowAdapter,
} from '@/hooks/useAuthFlow'
import { maskMainlandPhone } from '@/components/onboarding/phone-auth-utils'
import { HifiActionButton } from './primitives'
import { LoginScreen } from './LoginScreen'
import { SystemStatePage } from './SystemStatePage'

interface AdminLoginGateProps {
  /**
   * Continues the boot flow once credentials are accepted: the same
   * completion the legacy wizard drives (admin user refresh, workspace
   * reload, organization routing). While it runs the gate shows the
   * P-M01-PERSONAL-PREP preparing screen; rejection shows P-M01-PREP-FAIL.
   */
  onComplete: () => Promise<void>
  /**
   * Fired right after a successful login, before onComplete — parity with
   * the wizard's onConfigSaved (LLM connection refresh).
   */
  onLoginAccepted?: () => void
}

/**
 * AdminLoginGate — the real-auth mount of the g4 login-split (WS-LOGIN,
 * P-M01-*): LoginScreen for the credential steps backed by the admin RPC
 * channel, then the personal-space bootstrap screens while onComplete runs.
 *
 * App.tsx renders this gate instead of the legacy wizard whenever
 * `setupNeeds.needsAdminLogin` is set (fresh boot without a session and
 * auth-failure re-entry both route here).
 */
export function AdminLoginGate({ onComplete, onLoginAccepted }: AdminLoginGateProps) {
  const { t } = useTranslation()

  // The adapter closes over latest callbacks via refs so a stable identity
  // keeps the useAuthFlow reducer and its exclusive submit runner alive.
  const onCompleteRef = React.useRef(onComplete)
  onCompleteRef.current = onComplete
  const onLoginAcceptedRef = React.useRef(onLoginAccepted)
  onLoginAcceptedRef.current = onLoginAccepted

  const adapter = React.useMemo<AuthFlowAdapter>(() => ({
    loginWithPassword: async (phone, password) => {
      const result = await window.electronAPI.adminLogin(phone, password)
      return { ok: result.success }
    },
    sendLoginCode: async (phone) => {
      const challenge = await window.electronAPI.adminAcquirePhoneAuthChallenge()
      if (!challenge.success) throw new Error(challenge.errorCode ?? 'phone_auth_unavailable')
      const result = await window.electronAPI.adminSendPhoneAuthCode(
        phone,
        challenge.challengeToken,
      )
      if (!result.success) throw new Error(result.errorCode ?? 'phone_code_send_failed')
      // The admin send response carries no timing contract; use the same
      // 59s resend / 5min expiry windows as the prototype countdowns.
      return { resendAfterSeconds: 59, expiresInSeconds: 300 }
    },
    verifyLoginCode: async (phone, code) => {
      const result = await window.electronAPI.adminVerifyPhoneAuthCode(phone, code)
      return { ok: result.success }
    },
    prepareWorkspace: async () => {
      onLoginAcceptedRef.current?.()
      await onCompleteRef.current()
    },
  }), [])

  const flow = useAuthFlow({ adapter })
  const { state } = flow

  React.useEffect(() => {
    if (state.step === 'idle') flow.start()
  }, [state.step, flow])

  if (state.step === 'prepping') {
    return (
      <SystemStatePage
        variant="ambient"
        icon={{ kind: 'spinning' }}
        eyebrow={t('login.prep.eyebrow')}
        title={t('login.prep.title')}
        facts={[
          { label: t('login.prep.fact.account'), value: maskMainlandPhone(state.phone) },
        ]}
      />
    )
  }

  if (state.step === 'prepFailed') {
    return (
      <SystemStatePage
        variant="ambient"
        icon={{ kind: 'destructive' }}
        eyebrow={t('login.prepFail.eyebrow')}
        title={t('login.prepFail.title')}
        description={t('login.prepFail.description')}
        facts={[
          { label: t('login.prepFail.fact.account'), value: maskMainlandPhone(state.phone) },
        ]}
        actions={
          <>
            <HifiActionButton onClick={flow.relogin}>
              {t('login.prepFail.action.relogin')}
            </HifiActionButton>
            <HifiActionButton
              variant="primary"
              onClick={() => { void flow.retryPreparation() }}
            >
              {t('login.prepFail.action.retry')}
            </HifiActionButton>
          </>
        }
      />
    )
  }

  // Login steps (and the momentary 'ready' before the parent unmounts us).
  return <LoginScreen flow={flow} />
}
