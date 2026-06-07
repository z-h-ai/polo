/**
 * Polo AI WebUI — Login Page
 *
 * Flow:
 * 1. Mount → GET /auth/me → if valid, redirect to main
 * 2. GET /api/public-config → ensure platformMode
 * 3. POST /auth/login with username+password
 * 4. GET /api/config for wsUrl
 * 5. Redirect to main workspace (with original redirect URL preserved)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import SharedLoginPage from '@/pages/LoginPage'
import {
  LoginError,
  checkExistingSession,
  extractRedirectUrl,
  fetchPostLoginConfig,
  fetchPublicConfig,
  performPlatformLogin,
} from './login-logic'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'initializing' | 'form' | 'loading' | 'redirecting' | 'config_error'

// ---------------------------------------------------------------------------
// Icons (inline SVG — no external dependency)
// ---------------------------------------------------------------------------

function SpinnerIcon() {
  return (
    <svg
      aria-hidden="true"
      className="inline-block w-4 h-4 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// LoginPage component
// ---------------------------------------------------------------------------

export default function LoginPage() {
  const [phase, setPhase] = useState<Phase>('initializing')
  const [configError, setConfigError] = useState<string | null>(null)
  const redirectUrlRef = useRef<string>('/')
  const initRef = useRef(false)

  // Extract redirect URL from the current page URL
  useEffect(() => {
    try {
      redirectUrlRef.current = extractRedirectUrl(new URL(window.location.href))
    } catch {
      redirectUrlRef.current = '/'
    }
  }, [])

  // On mount: check for existing session, then fetch config
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    async function initialize() {
      // 1. Check for existing session
      const session = await checkExistingSession()
      if (session.authenticated) {
        setPhase('redirecting')
        window.location.href = redirectUrlRef.current
        return
      }

      // 2. Fetch public config
      try {
        const config = await fetchPublicConfig()

        if (!config.platformMode) {
          setConfigError('Platform mode not enabled')
          setPhase('config_error')
          return
        }

        if (!config.adminUrl) {
          setConfigError('Admin service not configured')
          setPhase('config_error')
          return
        }

        setPhase('form')
      } catch (err) {
        const msg = err instanceof LoginError ? err.message : 'Service temporarily unavailable'
        setConfigError(msg)
        setPhase('config_error')
      }
    }

    void initialize()
  }, [])

  const handleSuccess = useCallback(() => {
    setPhase('redirecting')
    window.location.href = redirectUrlRef.current
  }, [])

  const handleConfigError = useCallback((message: string) => {
    setConfigError(message)
    setPhase('config_error')
  }, [])

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (phase === 'initializing' || phase === 'redirecting') {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <SpinnerIcon />
      </div>
    )
  }

  if (phase === 'config_error') {
    return (
      <div className="login-card" role="main">
        <div className="login-logo">
          <span className="login-logo-mark">P</span>
        </div>
        <h1 className="login-title">Polo AI</h1>
        <div
          role="alert"
          data-testid="config-error"
          className="login-error login-error--visible"
        >
          {configError}
        </div>
      </div>
    )
  }

  return (
    <SharedLoginPage
      login={performPlatformLogin}
      fetchPostLoginConfig={fetchPostLoginConfig}
      onSuccess={handleSuccess}
      onConfigError={handleConfigError}
      getErrorMessage={(error) => error instanceof LoginError ? error.message : undefined}
    />
  )
}
