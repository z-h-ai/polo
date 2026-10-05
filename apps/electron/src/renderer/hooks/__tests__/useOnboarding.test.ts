import { describe, it, expect, mock, afterEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import {
  resolveSlugForMethod,
  apiSetupMethodToConnectionSetup,
  BASE_SLUG_FOR_METHOD,
  resolveInitialStep,
  resolveAdminLoginSuccessState,
  resolveAdminLoginFailureState,
  mapAdminLoginError,
  mapAdminPhoneAuthError,
  resolvePhoneAuthAvailability,
  sendPhoneAuthCodeWithChallenge,
  resolveAdminReloginState,
  resolveAdminKickedState,
  createAuthRequestGate,
  useOnboarding,
} from '../useOnboarding'
import type { ApiSetupMethod, OnboardingState } from '@/components/onboarding'
import type { AdminUser } from '@polo-ai/shared/admin/types'
import type {
  AdminLoginResult,
  AdminSendPhoneAuthCodeResult,
  AdminVerifyPhoneAuthCodeResult,
  SetupNeeds,
} from '../../../shared/types'

// Hook-level fencing tests need a DOM. Register only when no window exists
// yet (shared bun test process): another test file may have registered Happy
// DOM first. Pin a macOS userAgent — happy-dom defaults to a Windows one,
// which would flip `isWindows`/`PATH_SEP` in @/lib/platform for EVERY test
// file that runs after this one in the shared process.
if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
const { renderHook, act } = await import('@testing-library/react')

setupI18n()
// Pin the language: these assertions expect English strings, but the i18n
// singleton is shared across test files in a single-process run and other
// files may leave it on zh-Hans/es (navigator/locale detection also varies
// per environment). Without the pin, this file flakes on full-suite runs.
void i18n.changeLanguage('en')

// ============================================================
// resolveSlugForMethod
// ============================================================

describe('resolveSlugForMethod', () => {
  it('returns the base slug when it is available', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', null, new Set())
    expect(slug).toBe('anthropic-api')
  })

  it('reuses editingSlug when editing an existing connection', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', 'my-custom-slug', new Set(['anthropic-api']))
    expect(slug).toBe('my-custom-slug')
  })

  it('appends -2 when base slug is taken', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', null, new Set(['anthropic-api']))
    expect(slug).toBe('anthropic-api-2')
  })

  it('appends -3 when both base and -2 are taken', () => {
    const slug = resolveSlugForMethod('anthropic_api_key', null, new Set(['anthropic-api', 'anthropic-api-2']))
    expect(slug).toBe('anthropic-api-3')
  })

  it('works for all setup methods', () => {
    const methods: ApiSetupMethod[] = [
      'anthropic_api_key', 'claude_oauth',
      'pi_chatgpt_oauth', 'pi_copilot_oauth', 'pi_api_key',
    ]
    for (const method of methods) {
      const slug = resolveSlugForMethod(method, null, new Set())
      expect(slug).toBe(BASE_SLUG_FOR_METHOD[method])
    }
  })
})

// ============================================================
// apiSetupMethodToConnectionSetup
// ============================================================

describe('apiSetupMethodToConnectionSetup', () => {
  it('anthropic_api_key includes credential, baseUrl, defaultModel, models', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'anthropic_api_key',
      { credential: 'sk-ant-test', baseUrl: 'https://custom.api', connectionDefaultModel: 'claude-sonnet-4-6', models: ['model-a'] },
      null,
      new Set(),
    )
    expect(setup.slug).toBe('anthropic-api')
    expect(setup.credential).toBe('sk-ant-test')
    expect(setup.baseUrl).toBe('https://custom.api')
    expect(setup.defaultModel).toBe('claude-sonnet-4-6')
    expect(setup.models).toEqual(['model-a'])
  })

  it('claude_oauth includes only credential', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'claude_oauth',
      { credential: 'oauth-token-123' },
      null,
      new Set(),
    )
    expect(setup.slug).toBe('claude-max')
    expect(setup.credential).toBe('oauth-token-123')
    expect(setup.baseUrl).toBeUndefined()
  })

  it('pi_chatgpt_oauth maps to chatgpt-plus slug', () => {
    const setup = apiSetupMethodToConnectionSetup('pi_chatgpt_oauth', {}, null, new Set())
    expect(setup.slug).toBe('chatgpt-plus')
  })

  it('pi_copilot_oauth maps to github-copilot slug', () => {
    const setup = apiSetupMethodToConnectionSetup('pi_copilot_oauth', {}, null, new Set())
    expect(setup.slug).toBe('github-copilot')
  })

  it('pi_api_key includes piAuthProvider and modelSelectionMode', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'pi_api_key',
      {
        credential: 'sk-pi',
        piAuthProvider: 'anthropic',
        modelSelectionMode: 'userDefined3Tier',
      },
      null,
      new Set(),
    )
    expect(setup.slug).toBe('pi-api-key')
    expect(setup.credential).toBe('sk-pi')
    expect(setup.piAuthProvider).toBe('anthropic')
    expect(setup.modelSelectionMode).toBe('userDefined3Tier')
  })

  it('uses editingSlug when editing', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'anthropic_api_key',
      { credential: 'sk-ant' },
      'existing-connection',
      new Set(['anthropic-api']),
    )
    expect(setup.slug).toBe('existing-connection')
  })

  it('generates unique slug when base is taken', () => {
    const setup = apiSetupMethodToConnectionSetup(
      'claude_oauth',
      {},
      null,
      new Set(['claude-max']),
    )
    expect(setup.slug).toBe('claude-max-2')
  })
})

// ============================================================
// Reauth slug regression tests
// ============================================================

describe('reauth slug resolution', () => {
  it('slug override wins over null editingSlug (stale closure scenario)', () => {
    // Simulates the reauth bug: editingSlug is null (stale closure),
    // but connectionSlugOverride provides the correct slug.
    const existingSlugs = new Set(['chatgpt-plus'])

    // Without override: generates -2 (the bug)
    const wrongSlug = resolveSlugForMethod('pi_chatgpt_oauth', null, existingSlugs)
    expect(wrongSlug).toBe('chatgpt-plus-2')

    // With override: reuses existing slug (the fix)
    const correctSlug = resolveSlugForMethod('pi_chatgpt_oauth', 'chatgpt-plus', existingSlugs)
    expect(correctSlug).toBe('chatgpt-plus')
  })

  it('apiSetupMethodToConnectionSetup uses override slug for reauth', () => {
    const existingSlugs = new Set(['chatgpt-plus'])
    const setup = apiSetupMethodToConnectionSetup(
      'pi_chatgpt_oauth',
      {},
      'chatgpt-plus',  // override slug (reauth)
      existingSlugs,
    )
    expect(setup.slug).toBe('chatgpt-plus')
  })

  it('new connection flow still generates unique slugs when base is taken', () => {
    const existingSlugs = new Set(['chatgpt-plus'])
    const setup = apiSetupMethodToConnectionSetup(
      'pi_chatgpt_oauth',
      {},
      null,  // no editing slug (new connection)
      existingSlugs,
    )
    expect(setup.slug).toBe('chatgpt-plus-2')
  })

  it('copilot reauth uses override slug', () => {
    const existingSlugs = new Set(['github-copilot'])
    const slug = resolveSlugForMethod('pi_copilot_oauth', 'github-copilot', existingSlugs)
    expect(slug).toBe('github-copilot')
  })
})

// ============================================================
// Admin onboarding flow
// ============================================================

function adminState(overrides: Partial<OnboardingState> = {}): OnboardingState {
  return {
    step: 'admin-login',
    loginStatus: 'idle',
    credentialStatus: 'idle',
    completionStatus: 'saving',
    apiSetupMethod: null,
    isExistingUser: false,
    ...overrides,
  }
}

describe('admin onboarding flow', () => {
  it('starts at admin-login when admin login is required', () => {
    const setupNeeds: SetupNeeds = {
      needsBillingConfig: false,
      needsCredentials: false,
      needsAdminLogin: true,
      isFullyConfigured: false,
    }

    expect(resolveInitialStep(setupNeeds, 'provider-select')).toBe('admin-login')
  })

  it('moves to complete after admin login succeeds', () => {
    const next = resolveAdminLoginSuccessState(adminState({ loginStatus: 'waiting' }))

    expect(next.step).toBe('complete')
    expect(next.loginStatus).toBe('success')
    expect(next.completionStatus).toBe('complete')
    expect(next.errorMessage).toBeUndefined()
  })

  it('maps admin login failure to a localized error message', () => {
    const next = resolveAdminLoginFailureState(
      adminState({ loginStatus: 'waiting' }),
      { success: false, errorCode: 'INVALID_CREDENTIALS' },
    )

    expect(next.step).toBe('admin-login')
    expect(next.loginStatus).toBe('error')
    expect(next.errorMessage).toBe('Username or password is incorrect.')
  })

  it('maps stable phone auth errors without exposing server messages', () => {
    expect(mapAdminPhoneAuthError({
      success: false,
      errorCode: 'verification_code_expired',
      message: 'internal provider detail',
    })).toBe('The verification code has expired. Request a new one.')

    expect(mapAdminPhoneAuthError({
      success: false,
      errorCode: 'sms_rate_limited',
      retryAfter: 42,
    })).toBe('Too many requests. Try again in 42 seconds.')

    expect(mapAdminPhoneAuthError({
      success: false,
      errorCode: 'phone_auth_configuration_error',
      message: 'secret stack',
      status: 503,
    })).toBe('Phone verification is temporarily unavailable. Please try again later.')

    expect(mapAdminPhoneAuthError({
      success: false,
      errorCode: 'invalid_credentials',
      message: 'challenge verifier secret detail',
    })).toBe('Verification challenge failed. Please try again.')
  })

  it('maps all 5xx login and phone failures before business codes or messages', () => {
    expect(mapAdminLoginError({
      errorCode: 'INVALID_CREDENTIALS',
      message: 'sensitive upstream credential detail',
      status: 500,
    })).toBe(i18n.t('onboarding.adminLogin.genericError'))

    expect(mapAdminPhoneAuthError({
      errorCode: 'verification_code_expired',
      message: 'sensitive provider stack',
      status: 500,
    })).toBe(i18n.t('onboarding.adminLogin.phoneAuthUnavailable'))

    expect(mapAdminPhoneAuthError({
      errorCode: 'sms_rate_limited',
      message: 'sensitive rate-limit backend detail',
      retryAfter: 86_400,
      status: 503,
    })).toBe(i18n.t('onboarding.adminLogin.phoneAuthUnavailable'))
  })

  it('falls back to password login when no real challenge issuer is configured', () => {
    expect(resolvePhoneAuthAvailability(true, undefined, true)).toBe(false)
    expect(resolvePhoneAuthAvailability(false, async () => 'signed-token', true)).toBe(false)
    expect(resolvePhoneAuthAvailability(true, async () => 'signed-token', false)).toBe(false)
    expect(resolvePhoneAuthAvailability(true, async () => 'signed-token', true)).toBe(true)
  })

  it('does not send a code without an issuer-signed challenge token', async () => {
    const send = mock(async () => ({
      success: true as const,
      accepted: true,
      expiresIn: 300,
      resendAfter: 60,
    }))

    expect(await sendPhoneAuthCodeWithChallenge('13800138000', undefined, send)).toEqual({
      success: false,
      errorCode: 'phone_auth_configuration_error',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('passes the opaque challenge token through without transforming it', async () => {
    const send = mock(async () => ({
      success: true as const,
      accepted: true,
      expiresIn: 300,
      resendAfter: 47,
    }))

    const result = await sendPhoneAuthCodeWithChallenge(
      '13800138000',
      async () => 'issuer-signed-opaque-token',
      send,
    )

    expect(result).toMatchObject({ success: true, resendAfter: 47 })
    expect(send).toHaveBeenCalledWith('13800138000', 'issuer-signed-opaque-token')
  })

  it('moves from kicked back to admin-login when relogin is requested', () => {
    const next = resolveAdminReloginState(adminState({
      step: 'admin-kicked',
      phoneAuthEnabled: true,
      errorMessage: 'stale error',
    }))

    expect(next.step).toBe('admin-login')
    expect(next.loginStatus).toBe('idle')
    expect(next.phoneAuthEnabled).toBeUndefined()
    expect(next.errorMessage).toBeUndefined()
  })

  it('moves to admin-kicked when the revoked-token signal is shown', () => {
    const next = resolveAdminKickedState(adminState({
      step: 'complete',
      loginStatus: 'success',
      errorMessage: 'stale error',
    }))

    expect(next.step).toBe('admin-kicked')
    expect(next.loginStatus).toBe('idle')
    expect(next.errorMessage).toBeUndefined()
  })
})

// ============================================================
// P70-AUTH-01: suspended/revoked/invalidated rejections map to
// stable localized copy — server messages are never surfaced.
// ============================================================

describe('admin login rejection mapping', () => {
  for (const language of ['zh-Hans', 'en']) {
    it(`localizes typed transport and safe protocol failures in ${language} without changing denial precedence`, async () => {
      await i18n.changeLanguage(language)
      try {
        for (const errorCode of ['TIMEOUT', 'NETWORK_ERROR']) {
          const failure = { errorCode, message: 'Admin request timed out' }
          expect(mapAdminLoginError(failure)).toBe(i18n.t('onboarding.adminLogin.networkError'))
          expect(mapAdminPhoneAuthError(failure)).toBe(i18n.t('onboarding.adminLogin.networkError'))
        }
        for (const failure of [
          { errorCode: 'UNKNOWN_ERROR', message: 'Admin request failed' },
          { errorCode: 'FORBIDDEN', status: 403, message: 'Admin request is not permitted' },
          new Error('Safe protocol diagnostic'),
        ]) {
          expect(mapAdminLoginError(failure)).toBe(i18n.t('onboarding.adminLogin.genericError'))
        }
        expect(mapAdminLoginError({ errorCode: 'invalid_credentials', status: 401 })).toBe(i18n.t('onboarding.adminLogin.invalidCredentials'))
        expect(mapAdminLoginError({ errorCode: 'account_disabled', status: 403 })).toBe(i18n.t('onboarding.adminLogin.accountDisabled'))
        expect(mapAdminLoginError({ errorCode: 'TOKEN_EXPIRED', status: 401 })).toBe(i18n.t('onboarding.adminLogin.genericError'))
        expect(mapAdminLoginError({ errorCode: 'TIMEOUT', status: 503 })).toBe(i18n.t('onboarding.adminLogin.genericError'))
        expect(mapAdminPhoneAuthError({ errorCode: 'TIMEOUT', status: 503 })).toBe(i18n.t('onboarding.adminLogin.phoneAuthUnavailable'))
      } finally {
        await i18n.changeLanguage('en')
      }
    })
  }

  it('maps 401 and session-invalid codes to the stable sign-in failure copy', () => {
    const expected = i18n.t('onboarding.adminLogin.genericError')

    expect(mapAdminLoginError({
      errorCode: 'UNAUTHORIZED',
      message: 'Admin session is no longer valid',
      status: 401,
    })).toBe(expected)
    expect(mapAdminLoginError({ errorCode: 'TOKEN_REVOKED' })).toBe(expected)
    expect(mapAdminLoginError({ errorCode: 'TOKEN_EXPIRED' })).toBe(expected)
    expect(mapAdminLoginError({ errorCode: 'INVALID_TOKEN' })).toBe(expected)
    expect(mapAdminLoginError({ status: 401 })).toBe(expected)
  })

  it('maps suspended membership/organization denials to the account-disabled copy', () => {
    const expected = i18n.t('onboarding.adminLogin.accountDisabled')

    expect(mapAdminLoginError({ errorCode: 'MEMBERSHIP_SUSPENDED' })).toBe(expected)
    expect(mapAdminLoginError({ errorCode: 'MEMBERSHIP_REMOVED' })).toBe(expected)
    expect(mapAdminLoginError({
      errorCode: 'ORGANIZATION_UNAVAILABLE',
      message: 'internal organization detail',
    })).toBe(expected)
    expect(mapAdminLoginError({ errorCode: 'ACCOUNT_DISABLED' })).toBe(expected)
  })

  it('keeps wrong-password copy when the real chain reports 401 with a business code', () => {
    // The server login route answers wrong passwords with 401 while keeping
    // the business errorCode — the bare-401 fallback must not shadow it.
    expect(mapAdminLoginError({
      errorCode: 'invalid_credentials',
      message: 'Invalid username or password',
      status: 401,
    })).toBe(i18n.t('onboarding.adminLogin.invalidCredentials'))

    expect(mapAdminLoginError({
      errorCode: 'account_disabled',
      status: 401,
    })).toBe(i18n.t('onboarding.adminLogin.accountDisabled'))

    expect(mapAdminLoginError({
      errorCode: 'membership_suspended',
      status: 401,
    })).toBe(i18n.t('onboarding.adminLogin.accountDisabled'))
  })
})

// ============================================================
// P70-AUTH-03: login session owner epoch fence.
// ============================================================

describe('createAuthRequestGate', () => {
  it('keeps a captured epoch current until the gate is cancelled', () => {
    const gate = createAuthRequestGate()
    const stale = gate.begin()

    expect(gate.isCurrent(stale)).toBe(true)

    gate.cancel()
    expect(gate.isCurrent(stale)).toBe(false)

    const fresh = gate.begin()
    expect(gate.isCurrent(fresh)).toBe(true)
    expect(fresh).not.toBe(stale)
  })

  it('stays usable after repeated cancellations', () => {
    const gate = createAuthRequestGate()
    gate.cancel()
    gate.cancel()

    const epoch = gate.begin()
    expect(gate.isCurrent(epoch)).toBe(true)

    gate.cancel()
    expect(gate.isCurrent(epoch)).toBe(false)
  })
})

// ============================================================
// P70-AUTH-03 hook behaviour: single-flight submits, cancellation
// and stale receipts (useOnboarding + mocked electronAPI).
// ============================================================

function makeDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function adminUser(id: string): AdminUser {
  return { id, username: id, displayName: null, role: 'admin', groupIds: [] }
}

const ADMIN_SETUP_NEEDS: SetupNeeds = {
  needsBillingConfig: false,
  needsCredentials: false,
  needsAdminLogin: true,
  isFullyConfigured: false,
}

function installElectronApi(overrides: Record<string, unknown> = {}): void {
  const base = {
    checkGitBash: async () => ({ platform: 'darwin', found: true }),
    adminGetAuthConfig: async () => ({ phoneAuthEnabled: false }),
    adminGetPhoneAuthChallengeConfig: async () => ({
      success: false as const,
      errorCode: 'phone_auth_configuration_error',
    }),
    adminLogin: async () => ({ success: false as const, errorCode: 'UNKNOWN_ERROR' }),
    adminSendPhoneAuthCode: async () => ({ success: false as const, errorCode: 'NETWORK_ERROR' }),
    adminVerifyPhoneAuthCode: async () => ({
      success: false as const,
      errorCode: 'verification_code_invalid',
    }),
    clearClaudeOAuthState: async () => undefined,
  }
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { ...base, ...overrides }
}

function renderAdminLoginHooks(
  handlers: {
    onComplete?: () => void
    onDismiss?: () => void
    onConfigSaved?: () => void
    phoneAuthChallengeProvider?: () => Promise<string | null>
    initialStep?: 'welcome' | 'admin-login'
  } = {},
) {
  return renderHook(() => useOnboarding({
    onComplete: handlers.onComplete ?? (() => {}),
    initialSetupNeeds: ADMIN_SETUP_NEEDS,
    initialStep: handlers.initialStep,
    onDismiss: handlers.onDismiss,
    onConfigSaved: handlers.onConfigSaved,
    phoneAuthChallengeProvider: handlers.phoneAuthChallengeProvider,
  }))
}

describe('admin login session fencing (hook)', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('keeps a typed password timeout failed until an explicit same-account retry succeeds', async () => {
    const adminLogin = mock(async () => ({ success: false as const, errorCode: 'TIMEOUT', message: 'Admin request timed out' }))
    installElectronApi({ adminLogin })
    const onConfigSaved = mock(() => {})
    const { result } = renderAdminLoginHooks({ onConfigSaved })
    await act(async () => { await result.current.handleAdminLogin('user-a', 'pw') })
    expect(result.current.state.step).toBe('admin-login')
    expect(result.current.state.loginStatus).toBe('error')
    expect(result.current.state.errorMessage).toBe(i18n.t('onboarding.adminLogin.networkError'))
    expect(adminLogin).toHaveBeenCalledTimes(1)
    expect(onConfigSaved).not.toHaveBeenCalled()
    const retry = mock(async () => ({ success: true as const, user: adminUser('user-a') }))
    installElectronApi({ adminLogin: retry })
    await act(async () => { await result.current.handleAdminLogin('user-a', 'pw') })
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith('user-a', 'pw')
    expect(result.current.state.step).toBe('complete')
    expect(onConfigSaved).toHaveBeenCalledTimes(1)
  })

  it('does not automatically send or verify again after typed phone timeouts', async () => {
    const failure = { success: false as const, errorCode: 'TIMEOUT', message: 'Admin request timed out' }
    const send = mock(async () => failure)
    const verify = mock(async () => failure)
    const challenge = mock(async () => 'issuer-signed-opaque-token')
    installElectronApi({ adminSendPhoneAuthCode: send, adminVerifyPhoneAuthCode: verify })
    const { result } = renderAdminLoginHooks({ phoneAuthChallengeProvider: challenge })
    await act(async () => { expect(await result.current.handleAdminSendPhoneCode('13800138000')).toEqual(failure) })
    expect(result.current.state.errorMessage).toBe(i18n.t('onboarding.adminLogin.networkError'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(challenge).toHaveBeenCalledTimes(1)
    expect(verify).not.toHaveBeenCalled()
    await act(async () => { expect(await result.current.handleAdminVerifyPhoneCode('13800138000', '123456')).toBe(false) })
    expect(result.current.state.step).toBe('admin-login')
    expect(result.current.state.loginStatus).toBe('error')
    expect(result.current.state.errorMessage).toBe(i18n.t('onboarding.adminLogin.networkError'))
    expect(send).toHaveBeenCalledTimes(1)
    expect(verify).toHaveBeenCalledTimes(1)
    expect(challenge).toHaveBeenCalledTimes(1)
  })

  it('fires exactly one login RPC for a double submit, then completes once', async () => {
    const deferred = makeDeferred<AdminLoginResult>()
    const adminLogin = mock(() => deferred.promise)
    installElectronApi({ adminLogin })
    const onConfigSaved = mock(() => {})
    const { result } = renderAdminLoginHooks({ onConfigSaved })

    await act(async () => {
      void result.current.handleAdminLogin('user-a', 'pw')
    })
    await act(async () => {
      void result.current.handleAdminLogin('user-a', 'pw')
    })

    expect(adminLogin).toHaveBeenCalledTimes(1)
    expect(result.current.state.loginStatus).toBe('waiting')

    await act(async () => {
      deferred.resolve({ success: true, user: adminUser('user-a') })
      await deferred.promise
    })

    expect(result.current.state.step).toBe('complete')
    expect(onConfigSaved).toHaveBeenCalledTimes(1)
  })

  it('drops the receipt of a cancelled password login', async () => {
    const deferred = makeDeferred<AdminLoginResult>()
    const adminLogin = mock(() => deferred.promise)
    installElectronApi({ adminLogin })
    const onDismiss = mock(() => {})
    const onConfigSaved = mock(() => {})
    const onComplete = mock(() => {})
    const { result } = renderAdminLoginHooks({ onDismiss, onConfigSaved, onComplete })

    await act(async () => {
      void result.current.handleAdminLogin('user-a', 'pw')
    })
    act(() => {
      result.current.handleBack()
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)

    await act(async () => {
      deferred.resolve({ success: true, user: adminUser('user-a') })
      await deferred.promise
    })

    expect(result.current.state.step).toBe('admin-login')
    expect(onConfigSaved).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('fences the in-flight receipt when back dismisses from the initial step', async () => {
    const deferred = makeDeferred<AdminLoginResult>()
    const adminLogin = mock(() => deferred.promise)
    installElectronApi({ adminLogin })
    const onDismiss = mock(() => {})
    const onConfigSaved = mock(() => {})
    const { result } = renderAdminLoginHooks({
      onDismiss,
      onConfigSaved,
      initialStep: 'admin-login',
    })

    await act(async () => {
      void result.current.handleAdminLogin('user-a', 'pw')
    })
    // state.step === initialStep here: handleBack takes the early-return
    // path, which must fence the intent exactly like the admin-login branch.
    act(() => {
      result.current.handleBack()
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)

    await act(async () => {
      deferred.resolve({ success: true, user: adminUser('user-a') })
      await deferred.promise
    })

    expect(result.current.state.step).toBe('admin-login')
    expect(onConfigSaved).not.toHaveBeenCalled()
  })

  it('late receipt of a cancelled intent cannot overwrite the newer account', async () => {
    const staleReceipt = makeDeferred<AdminLoginResult>()
    let call = 0
    const adminLogin = mock(() => {
      call += 1
      return call === 1
        ? staleReceipt.promise
        : Promise.resolve({ success: true, user: adminUser('user-b') })
    })
    installElectronApi({ adminLogin })
    const onDismiss = mock(() => {})
    const onConfigSaved = mock(() => {})
    const { result } = renderAdminLoginHooks({ onDismiss, onConfigSaved })

    await act(async () => {
      void result.current.handleAdminLogin('user-a', 'pw')
    })
    act(() => {
      result.current.handleBack()
    })
    await act(async () => {
      void result.current.handleAdminLogin('user-b', 'pw2')
    })

    expect(result.current.state.step).toBe('complete')
    expect(onConfigSaved).toHaveBeenCalledTimes(1)

    await act(async () => {
      staleReceipt.resolve({ success: true, user: adminUser('user-a') })
      await staleReceipt.promise
    })

    expect(onConfigSaved).toHaveBeenCalledTimes(1)
    expect(result.current.state.step).toBe('complete')
  })

  it('fires exactly one verify RPC for a double submit; the repeat resolves false', async () => {
    const deferred = makeDeferred<AdminVerifyPhoneAuthCodeResult>()
    const adminVerifyPhoneAuthCode = mock(() => deferred.promise)
    installElectronApi({ adminVerifyPhoneAuthCode })
    const onConfigSaved = mock(() => {})
    const { result } = renderAdminLoginHooks({ onConfigSaved })

    let firstOutcome: boolean | undefined
    let secondOutcome: boolean | undefined
    await act(async () => {
      void result.current.handleAdminVerifyPhoneCode('138****8000', '123456')
        .then(outcome => { firstOutcome = outcome })
    })
    await act(async () => {
      void result.current.handleAdminVerifyPhoneCode('138****8000', '123456')
        .then(outcome => { secondOutcome = outcome })
    })

    expect(adminVerifyPhoneAuthCode).toHaveBeenCalledTimes(1)
    expect(secondOutcome).toBe(false)

    await act(async () => {
      deferred.resolve({ success: true, user: adminUser('user-a'), isNewUser: false })
      await deferred.promise
    })

    expect(firstOutcome).toBe(true)
    expect(result.current.state.step).toBe('complete')
    expect(onConfigSaved).toHaveBeenCalledTimes(1)
  })

  it('drops the receipt of a cancelled phone verification', async () => {
    const deferred = makeDeferred<AdminVerifyPhoneAuthCodeResult>()
    const adminVerifyPhoneAuthCode = mock(() => deferred.promise)
    installElectronApi({ adminVerifyPhoneAuthCode })
    const onDismiss = mock(() => {})
    const onConfigSaved = mock(() => {})
    const { result } = renderAdminLoginHooks({ onDismiss, onConfigSaved })

    await act(async () => {
      void result.current.handleAdminVerifyPhoneCode('138****8000', '123456')
    })
    act(() => {
      result.current.handleBack()
    })

    await act(async () => {
      deferred.resolve({ success: true, user: adminUser('user-a'), isNewUser: false })
      await deferred.promise
    })

    expect(result.current.state.step).toBe('admin-login')
    expect(onConfigSaved).not.toHaveBeenCalled()
  })

  it('fires exactly one send-code RPC for a double submit without re-running the challenge', async () => {
    const deferred = makeDeferred<AdminSendPhoneAuthCodeResult>()
    const adminSendPhoneAuthCode = mock(() => deferred.promise)
    installElectronApi({ adminSendPhoneAuthCode })
    const challengeProvider = mock(async () => 'issuer-signed-opaque-token')
    const { result } = renderAdminLoginHooks({ phoneAuthChallengeProvider: challengeProvider })

    let firstResult: AdminSendPhoneAuthCodeResult | undefined
    let secondResult: AdminSendPhoneAuthCodeResult | undefined
    await act(async () => {
      void result.current.handleAdminSendPhoneCode('13800138000')
        .then(sendResult => { firstResult = sendResult })
    })
    await act(async () => {
      void result.current.handleAdminSendPhoneCode('13800138000')
        .then(sendResult => { secondResult = sendResult })
    })

    expect(challengeProvider).toHaveBeenCalledTimes(1)
    expect(adminSendPhoneAuthCode).toHaveBeenCalledTimes(1)
    expect(secondResult).toEqual({ success: false, errorCode: 'duplicate_request' })

    await act(async () => {
      deferred.resolve({ success: true, accepted: true, expiresIn: 300, resendAfter: 60 })
      await deferred.promise
    })

    expect(firstResult).toEqual({ success: true, accepted: true, expiresIn: 300, resendAfter: 60 })
  })
})
