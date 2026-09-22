/**
 * useAuthFlow Hook
 *
 * Local state machine behind the POO-70 HiFi login & recovery surfaces
 * (WS-LOGIN): idle → password → phone → code → prepping → prepFailed → ready.
 *
 * The reducer is a pure function (unit-tested in
 * hooks/__tests__/useAuthFlow.test.ts) and deliberately rejects illegal
 * transitions by returning the previous state. Demo states are injected via
 * the adapter: the default `DEMO_AUTH_FLOW_ADAPTER` keeps the UI on the
 * current step (pending promises) so playground variants stay renderable.
 *
 * Integration note (main agent, App.tsx wiring): swap the adapter for the
 * admin RPC channel — `loginWithPassword`/`sendLoginCode`/`verifyLoginCode`
 * map to the phone-auth RPC surface used by onboarding/PhoneAuthStep, and
 * `prepareWorkspace` to the personal-space bootstrap that today lives in
 * the App.tsx startup state machine.
 */
import { useCallback, useMemo, useReducer } from 'react'
import {
  createExclusiveRunner,
  createPhoneAuthResendDeadline,
  normalizeMainlandPhoneInput,
  normalizeVerificationCode,
} from '@/components/onboarding/phone-auth-utils'

export type AuthFlowStep =
  | 'idle'
  | 'password'
  | 'phone'
  | 'code'
  | 'prepping'
  | 'prepFailed'
  | 'ready'

/** Login-step inline notices rendered as g4 `.inline-alert`. */
export type AuthFlowNotice = 'cancelled' | 'expired' | null

export interface AuthFlowState {
  step: AuthFlowStep
  phone: string
  code: string
  consented: boolean
  notice: AuthFlowNotice
  /** True when the last submit failed (rendered as an inline alert). */
  error: boolean
  /** Epoch ms before which the code resend button stays disabled. */
  codeResendAt: number | undefined
  /** Epoch ms when the sent verification code expires. */
  codeExpiresAt: number | undefined
}

export type AuthFlowAction =
  | { type: 'started' }
  | { type: 'modeSwitched'; mode: 'password' | 'phone' }
  | { type: 'phoneChanged'; value: string }
  | { type: 'codeChanged'; value: string }
  | { type: 'consentChanged'; value: boolean }
  | {
      type: 'codeSent'
      resendAfterSeconds: number
      expiresInSeconds: number
      /** Dispatch-site clock; the reducer itself never reads Date.now(). */
      now: number
    }
  | { type: 'loginSucceeded' }
  | { type: 'submitFailed' }
  | { type: 'prepSucceeded' }
  | { type: 'prepFailed' }
  | { type: 'prepRetried' }
  | { type: 'reloginRequested' }
  | { type: 'cancelled' }
  | { type: 'sessionExpired' }
  | { type: 'noticeDismissed' }
  | { type: 'reset' }

export const INITIAL_AUTH_FLOW_STATE: AuthFlowState = {
  step: 'idle',
  phone: '',
  code: '',
  consented: false,
  notice: null,
  error: false,
  codeResendAt: undefined,
  codeExpiresAt: undefined,
}

const LOGIN_STEPS: ReadonlyArray<AuthFlowStep> = ['password', 'phone', 'code']

function isLoginStep(step: AuthFlowStep): boolean {
  return LOGIN_STEPS.includes(step)
}

/**
 * Pure reducer. Unknown or illegal transitions leave the state untouched —
 * the state machine never invents a path that the flow does not define.
 */
export function reduceAuthFlow(
  state: AuthFlowState,
  action: AuthFlowAction,
): AuthFlowState {
  switch (action.type) {
    case 'started':
      if (state.step !== 'idle') return state
      return { ...state, step: 'password' }
    case 'modeSwitched':
      // Any login entry (including the code step) may switch back to the
      // password / phone entries (P-M01-LOGIN-CODE “切换为密码登录”).
      if (!isLoginStep(state.step)) return state
      if (action.mode !== 'password' && action.mode !== 'phone') return state
      if (state.step === action.mode) return state
      return {
        ...state,
        step: action.mode,
        error: false,
        codeResendAt: undefined,
        codeExpiresAt: undefined,
      }
    case 'phoneChanged':
      return { ...state, phone: normalizeMainlandPhoneInput(action.value) }
    case 'codeChanged':
      if (state.step !== 'code') return state
      return { ...state, code: normalizeVerificationCode(action.value) }
    case 'consentChanged':
      return { ...state, consented: action.value }
    case 'codeSent': {
      if (state.step !== 'phone') return state
      const now = action.now
      return {
        ...state,
        step: 'code',
        code: '',
        error: false,
        notice: null,
        codeResendAt: createPhoneAuthResendDeadline(
          action.resendAfterSeconds,
          now,
        ),
        codeExpiresAt: now + Math.max(0, action.expiresInSeconds) * 1_000,
      }
    }
    case 'loginSucceeded':
      if (!isLoginStep(state.step)) return state
      return {
        ...state,
        step: 'prepping',
        error: false,
        notice: null,
      }
    case 'submitFailed':
      if (!isLoginStep(state.step)) return state
      return { ...state, error: true }
    case 'prepSucceeded':
      if (state.step !== 'prepping') return state
      return { ...state, step: 'ready' }
    case 'prepFailed':
      if (state.step !== 'prepping') return state
      return { ...state, step: 'prepFailed' }
    case 'prepRetried':
      if (state.step !== 'prepFailed') return state
      return { ...state, step: 'prepping', error: false }
    case 'reloginRequested':
      if (state.step !== 'prepFailed') return state
      return {
        ...state,
        step: 'password',
        error: false,
        notice: null,
        codeResendAt: undefined,
        codeExpiresAt: undefined,
      }
    case 'cancelled':
      if (!isLoginStep(state.step)) return state
      // C-R08: the cancelled surface keeps the login entry retryable with a
      // no-side-effect notice, and always lands back on the password entry.
      return { ...state, step: 'password', notice: 'cancelled', error: false }
    case 'sessionExpired':
      // Expired sessions ask for a fresh login; previous actions are never
      // replayed implicitly (the caller decides the follow-up target).
      return { ...state, step: 'password', notice: 'expired', error: false }
    case 'noticeDismissed':
      return { ...state, notice: null }
    case 'reset':
      return INITIAL_AUTH_FLOW_STATE
  }
}

/** Result contract shared by the password / code submit adapters. */
export interface AuthSubmitResult {
  ok: boolean
}

export interface AuthFlowAdapter {
  loginWithPassword(phone: string, password: string): Promise<AuthSubmitResult>
  sendLoginCode(phone: string): Promise<{
    resendAfterSeconds: number
    expiresInSeconds: number
  }>
  verifyLoginCode(phone: string, code: string): Promise<AuthSubmitResult>
  /** Resolves when the personal workspace is prepared; rejects on failure. */
  prepareWorkspace(): Promise<void>
}

/**
 * Demo adapter: code sending resolves (so the countdown runs), while logins
 * and workspace preparation stay pending — the mounted surface never
 * transitions away, which is exactly what playground variants need.
 */
export const DEMO_AUTH_FLOW_ADAPTER: AuthFlowAdapter = {
  loginWithPassword: () => new Promise<AuthSubmitResult>(() => {}),
  sendLoginCode: async () => ({
    resendAfterSeconds: 59,
    expiresInSeconds: 300,
  }),
  verifyLoginCode: () => new Promise<AuthSubmitResult>(() => {}),
  prepareWorkspace: () => new Promise<void>(() => {}),
}

export interface UseAuthFlowOptions {
  /** Defaults to the never-resolving demo adapter. */
  adapter?: AuthFlowAdapter
}

export function useAuthFlow({ adapter = DEMO_AUTH_FLOW_ADAPTER }: UseAuthFlowOptions = {}) {
  const [state, dispatch] = useReducer(reduceAuthFlow, INITIAL_AUTH_FLOW_STATE)
  const submitRunner = useMemo(createExclusiveRunner, [])

  const start = useCallback(() => dispatch({ type: 'started' }), [])
  const switchMode = useCallback(
    (mode: 'password' | 'phone') => dispatch({ type: 'modeSwitched', mode }),
    [],
  )
  const setPhone = useCallback(
    (value: string) => dispatch({ type: 'phoneChanged', value }),
    [],
  )
  const setCode = useCallback(
    (value: string) => dispatch({ type: 'codeChanged', value }),
    [],
  )
  const setConsented = useCallback(
    (value: boolean) => dispatch({ type: 'consentChanged', value }),
    [],
  )
  const dismissNotice = useCallback(
    () => dispatch({ type: 'noticeDismissed' }),
    [],
  )
  const retryPrep = useCallback(() => dispatch({ type: 'prepRetried' }), [])
  const relogin = useCallback(
    () => dispatch({ type: 'reloginRequested' }),
    [],
  )
  const markSessionExpired = useCallback(
    () => dispatch({ type: 'sessionExpired' }),
    [],
  )
  const cancel = useCallback(() => dispatch({ type: 'cancelled' }), [])

  const sendCode = useCallback(
    async (phone: string) => {
      try {
        const result = await submitRunner.run(() => adapter.sendLoginCode(phone))
        if (!result) return
        dispatch({
          type: 'codeSent',
          resendAfterSeconds: result.resendAfterSeconds,
          expiresInSeconds: result.expiresInSeconds,
          now: Date.now(),
        })
      } catch {
        // Sending failed (network / provider): surface it inline instead of
        // letting the rejection escape as unhandled.
        dispatch({ type: 'submitFailed' })
      }
    },
    [adapter, submitRunner],
  )

  const prepareAfterLogin = useCallback(async () => {
    dispatch({ type: 'loginSucceeded' })
    try {
      await adapter.prepareWorkspace()
      dispatch({ type: 'prepSucceeded' })
    } catch {
      dispatch({ type: 'prepFailed' })
    }
  }, [adapter])

  const submitPassword = useCallback(
    async (phone: string, password: string) => {
      try {
        await submitRunner.run(async () => {
          const result = await adapter.loginWithPassword(phone, password)
          if (!result.ok) {
            dispatch({ type: 'submitFailed' })
            return
          }
          await prepareAfterLogin()
        })
      } catch {
        dispatch({ type: 'submitFailed' })
      }
    },
    [adapter, prepareAfterLogin, submitRunner],
  )

  const submitCode = useCallback(
    async (phone: string, code: string) => {
      try {
        await submitRunner.run(async () => {
          const result = await adapter.verifyLoginCode(phone, code)
          if (!result.ok) {
            dispatch({ type: 'submitFailed' })
            return
          }
          await prepareAfterLogin()
        })
      } catch {
        dispatch({ type: 'submitFailed' })
      }
    },
    [adapter, prepareAfterLogin, submitRunner],
  )

  // Real wiring (P-M01-PERSONAL-PREP-FAIL): retry re-enters the preparing
  // screen and actually re-runs the adapter, unlike `retryPrep` which only
  // moves the state machine (playground variants stay renderable).
  const retryPreparation = useCallback(async () => {
    if (state.step !== 'prepFailed') return
    dispatch({ type: 'prepRetried' })
    try {
      await adapter.prepareWorkspace()
      dispatch({ type: 'prepSucceeded' })
    } catch {
      dispatch({ type: 'prepFailed' })
    }
  }, [adapter, state.step])

  return {
    state,
    /** Convenience view for surfaces that only render the login steps. */
    isLoginStep: isLoginStep(state.step),
    start,
    switchMode,
    setPhone,
    setCode,
    setConsented,
    sendCode,
    submitPassword,
    submitCode,
    cancel,
    markSessionExpired,
    dismissNotice,
    retryPrep,
    retryPreparation,
    relogin,
  }
}

export type UseAuthFlowReturn = ReturnType<typeof useAuthFlow>
