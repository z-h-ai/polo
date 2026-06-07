import React, { useCallback, useEffect, useRef, useState } from 'react'

export interface LoginUser {
  id: string
  username: string
  role: string
}

export interface LoginResult {
  user: LoginUser
}

export interface PostLoginConfig {
  wsUrl: string
}

export type LoginErrorLike = {
  code?: string
  retryAfterSeconds?: number
  message?: string
}

export interface LoginPageProps {
  login?: (username: string, password: string) => Promise<LoginResult>
  fetchPostLoginConfig?: () => Promise<PostLoginConfig>
  onSuccess?: () => void
  onConfigError?: (message: string) => void
  getErrorMessage?: (error: unknown) => string | undefined
}

type Phase = 'idle' | 'submitting'

type ElectronLoginAdapterDeps = {
  invokeAuth?: (channel: string, ...args: unknown[]) => Promise<LoginResult>
}

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

export function createElectronLoginAdapter(deps: ElectronLoginAdapterDeps = {}) {
  return async (username: string, password: string): Promise<LoginResult> => {
    if (deps.invokeAuth) {
      return deps.invokeAuth('auth:login', username, password)
    }
    const api = window.electronAPI as typeof window.electronAPI & {
      authLogin?: (username: string, password: string) => Promise<LoginResult>
    }
    if (!api.authLogin) {
      throw { code: 'network_error', message: 'Electron auth IPC is unavailable' }
    }
    return api.authLogin(username, password)
  }
}

export function getLoginErrorMessage(error: unknown): string {
  const err = toLoginErrorLike(error)
  if (err.code === 'invalid_credentials') return '用户名或密码错误'
  if (err.code === 'account_disabled') return '账号已被禁用，请联系管理员'
  if (err.code === 'rate_limited') {
    const seconds = err.retryAfterSeconds ?? 0
    return `请 ${seconds} 秒后再试`
  }
  if (err.code === 'network_error') return '无法连接服务器，请检查网络连接'
  return err.message || '登录失败，请稍后再试'
}

export default function LoginPage({
  login = createElectronLoginAdapter(),
  fetchPostLoginConfig = defaultFetchPostLoginConfig,
  onSuccess = defaultNavigateToApp,
  onConfigError = defaultNavigateToConfigError,
  getErrorMessage: getCustomErrorMessage,
}: LoginPageProps) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [rateLimitRemaining, setRateLimitRemaining] = useState(0)
  const errorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (error) {
      errorRef.current?.focus()
    }
  }, [error])

  useEffect(() => {
    if (rateLimitRemaining <= 0) return undefined
    const timer = window.setInterval(() => {
      setRateLimitRemaining((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [rateLimitRemaining])

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (phase === 'submitting' || rateLimitRemaining > 0) return

    setError(null)
    setPhase('submitting')

    try {
      await login(username, password)
      try {
        await fetchPostLoginConfig()
      } catch (configError) {
        const message = configError instanceof Error ? configError.message : 'Failed to fetch config'
        onConfigError(message)
        return
      }
      onSuccess()
    } catch (loginError) {
      const message = getCustomErrorMessage?.(loginError) ?? getLoginErrorMessage(loginError)
      const err = toLoginErrorLike(loginError)
      setError(message)
      if (err.code === 'rate_limited') {
        setRateLimitRemaining(err.retryAfterSeconds ?? 0)
      }
    } finally {
      setPhase('idle')
    }
  }, [
    fetchPostLoginConfig,
    getCustomErrorMessage,
    login,
    onConfigError,
    onSuccess,
    password,
    phase,
    rateLimitRemaining,
    username,
  ])

  const clearError = useCallback(() => {
    if (error) setError(null)
  }, [error])

  const isSubmitting = phase === 'submitting'
  const isRateLimited = rateLimitRemaining > 0
  const isDisabled = isSubmitting || isRateLimited

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
            onChange={(event) => {
              setUsername(event.target.value)
              clearError()
            }}
            placeholder="Enter your username"
            className="login-input"
            disabled={isDisabled}
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
            onChange={(event) => {
              setPassword(event.target.value)
              clearError()
            }}
            placeholder="Enter your password"
            className="login-input"
            disabled={isDisabled}
            aria-required="true"
          />
        </div>

        <button
          type="submit"
          disabled={isDisabled || !username.trim() || !password.trim()}
          className="login-btn"
          data-testid="login-submit"
          aria-busy={isSubmitting}
        >
          {isSubmitting ? (
            <>
              <SpinnerIcon />
              <span>Signing in...</span>
            </>
          ) : (
            'Login'
          )}
        </button>
      </form>

      {error && (
        <div
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          data-testid="login-error"
          className="login-error login-error--visible"
        >
          {isRateLimited ? `请 ${rateLimitRemaining} 秒后再试` : error}
        </div>
      )}
    </div>
  )
}

async function defaultFetchPostLoginConfig(): Promise<PostLoginConfig> {
  return window.electronAPI.getServerConfig()
    .then(() => ({ wsUrl: 'electron' }))
    .catch(() => {
      throw new Error('Failed to fetch config')
    })
}

function defaultNavigateToApp() {
  window.location.hash = '#/'
}

function defaultNavigateToConfigError(message: string) {
  const url = new URL(window.location.href)
  url.hash = `#/config-error?message=${encodeURIComponent(message)}`
  window.location.href = url.toString()
}

function toLoginErrorLike(error: unknown): LoginErrorLike {
  if (error && typeof error === 'object') return error as LoginErrorLike
  if (error instanceof Error) return { message: error.message }
  return {}
}
