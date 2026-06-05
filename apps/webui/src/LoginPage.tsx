/**
 * Polo AI WebUI — Login Page
 *
 * Flow:
 * 1. Mount → GET /auth/me → if valid, redirect to main
 * 2. GET /api/public-config → get adminUrl and platformMode
 * 3. Show error if platformMode=false or adminUrl=null
 * 4. POST {adminUrl}/api/auth/login with username+password
 * 5. POST /auth/session with returned token
 * 6. GET /api/config for wsUrl
 * 7. Redirect to main workspace (with original redirect URL preserved)
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  LoginError,
  checkExistingSession,
  extractRedirectUrl,
  fetchPostLoginConfig,
  fetchPublicConfig,
  performAdminLogin,
  setPoloSession,
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
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const adminUrlRef = useRef<string | null>(null)
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

        adminUrlRef.current = config.adminUrl
        setPhase('form')
      } catch (err) {
        const msg = err instanceof LoginError ? err.message : 'Service temporarily unavailable'
        setConfigError(msg)
        setPhase('config_error')
      }
    }

    void initialize()
  }, [])

  // Submit handler
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault()
      if (!adminUrlRef.current) return
      setError(null)
      setPhase('loading')

      try {
        // 1. Login against Admin
        const token = await performAdminLogin(adminUrlRef.current, username, password)

        // 2. Set Polo session cookie
        await setPoloSession(token)

        // 3. Fetch post-login config (for wsUrl — not strictly needed for redirect)
        await fetchPostLoginConfig()

        // 4. Redirect
        setPhase('redirecting')
        window.location.href = redirectUrlRef.current
      } catch (err) {
        const msg = err instanceof LoginError ? err.message : 'An unexpected error occurred'
        setError(msg)
        setPhase('form')
      }
    },
    [username, password],
  )

  // Clear error when user edits inputs
  const handleUsernameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setUsername(e.target.value)
    if (error) setError(null)
  }, [error])

  const handlePasswordChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value)
    if (error) setError(null)
  }, [error])

  const isSubmitDisabled = !username.trim() || !password.trim() || phase === 'loading'

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
    <div className="login-card" role="main">
      <div className="login-logo" aria-hidden="true">
        <span className="login-logo-mark">P</span>
      </div>
      <h1 className="login-title">Polo AI</h1>
      <p className="login-subtitle">Sign in to continue</p>

      <form onSubmit={handleSubmit} noValidate>
        <div className="login-field">
          <label htmlFor="username" className="login-label">
            Username
          </label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={handleUsernameChange}
            placeholder="Enter your username"
            className="login-input"
            disabled={phase === 'loading'}
            aria-required="true"
          />
        </div>

        <div className="login-field">
          <label htmlFor="password" className="login-label">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={handlePasswordChange}
            placeholder="Enter your password"
            className="login-input"
            disabled={phase === 'loading'}
            aria-required="true"
          />
        </div>

        <button
          type="submit"
          disabled={isSubmitDisabled}
          className="login-btn"
          data-testid="login-submit"
        >
          {phase === 'loading' ? (
            <>
              <SpinnerIcon />
              <span>Signing in…</span>
            </>
          ) : (
            'Login'
          )}
        </button>
      </form>

      {error && (
        <div
          role="alert"
          data-testid="login-error"
          className="login-error login-error--visible"
        >
          {error}
        </div>
      )}
    </div>
  )
}
