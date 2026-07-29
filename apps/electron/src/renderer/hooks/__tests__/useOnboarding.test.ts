import { describe, it, expect, mock } from 'bun:test'
import { setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import {
  resolveSlugForMethod,
  apiSetupMethodToConnectionSetup,
  BASE_SLUG_FOR_METHOD,
  resolveInitialStep,
  resolveAdminLoginSuccessState,
  resolveAdminLoginFailureState,
  mapAdminPhoneAuthError,
  resolvePhoneAuthAvailability,
  sendPhoneAuthCodeWithChallenge,
  resolveAdminReloginState,
  resolveAdminKickedState,
} from '../useOnboarding'
import type { ApiSetupMethod, OnboardingState } from '@/components/onboarding'
import type { SetupNeeds } from '../../../shared/types'

setupI18n()

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
      errorMessage: 'stale error',
    }))

    expect(next.step).toBe('admin-login')
    expect(next.loginStatus).toBe('idle')
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
