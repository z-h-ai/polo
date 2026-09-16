/**
 * useOnboarding Hook
 *
 * Manages the state machine for the onboarding wizard.
 * Flow:
 * 1. Welcome
 * 2. Git Bash (Windows only, if not found)
 * 3. Complete
 */
import { useState, useCallback, useEffect } from 'react'
import { i18n } from '@polo-ai/shared/i18n'
import type {
  OnboardingState,
  OnboardingStep,
  ApiSetupMethod,
} from '@/components/onboarding'
import type { ProviderChoice } from '@/components/onboarding/ProviderSelectStep'
import type { LocalModelSubmitData } from '@/components/onboarding/LocalModelStep'
import type { ApiKeySubmitData } from '@/components/apisetup'
import type { CustomEndpointConfig } from '@config/llm-connections'
import type {
  AdminSendPhoneAuthCodeResult,
  LlmConnectionSetup,
  SetupNeeds,
} from '../../shared/types'

interface UseOnboardingOptions {
  /** Called when onboarding is complete */
  onComplete: () => void
  /** Initial setup needs from auth state check */
  initialSetupNeeds?: SetupNeeds
  /** Start the wizard at a specific step (default: 'welcome') */
  initialStep?: OnboardingStep
  /** Pre-select an API setup method (useful when editing an existing connection) */
  initialApiSetupMethod?: ApiSetupMethod
  /** Called when user goes back from the initial step (dismisses the wizard) */
  onDismiss?: () => void
  /** Called immediately after config is saved to disk (before wizard closes).
   *  Use this to propagate billing/model changes to the UI without waiting for onComplete. */
  onConfigSaved?: () => void
  /** Slug of existing connection being edited (null = creating new) */
  editingSlug?: string | null
  /** Set of slugs already in use (for generating unique slugs when creating new) */
  existingSlugs?: Set<string>
  /**
   * Returns an opaque token issued by the configured human/device challenge.
   * Electron intentionally has no fallback token: without a real issuer, phone
   * authentication is reported as unavailable and password login remains usable.
   */
  phoneAuthChallengeProvider?: () => Promise<string | null>
}

interface UseOnboardingReturn {
  // State
  state: OnboardingState

  // Wizard actions
  handleContinue: () => void
  handleBack: () => void

  // Provider select (new flow)
  handleSelectProvider: (choice: ProviderChoice) => void

  // API Setup (legacy — kept for direct edit)
  handleSelectApiSetupMethod: (method: ApiSetupMethod) => void

  // Credentials
  handleSubmitCredential: (data: ApiKeySubmitData) => void
  handleAdminLogin: (identifier: string, password: string) => void
  handleAdminSendPhoneCode: (phone: string) => Promise<AdminSendPhoneAuthCodeResult>
  handleAdminVerifyPhoneCode: (phone: string, code: string) => Promise<boolean>
  handleAdminRelogin: () => void
  showAdminKicked: () => void

  // Local model
  handleSubmitLocalModel: (data: LocalModelSubmitData) => void
  handleStartOAuth: (methodOverride?: ApiSetupMethod, connectionSlugOverride?: string) => void

  // Claude OAuth (two-step flow)
  isWaitingForCode: boolean
  handleSubmitAuthCode: (code: string) => void
  handleCancelOAuth: () => void

  // Copilot device code (displayed during device flow)
  copilotDeviceCode?: { userCode: string; verificationUri: string }

  // Git Bash (Windows)
  handleBrowseGitBash: () => Promise<string | null>
  handleUseGitBashPath: (path: string) => void
  handleRecheckGitBash: () => void
  handleClearError: () => void

  // Skip setup ("Setup later")
  handleSkipSetup: () => void

  // Completion
  handleFinish: () => void
  handleCancel: () => void

  // Direct edit (skip method selection, jump to credentials)
  jumpToCredentials: (method: ApiSetupMethod) => void

  // Reset
  reset: () => void
}

// Base slug for each setup method (used as template key in ipc.ts)
export const BASE_SLUG_FOR_METHOD: Record<ApiSetupMethod, string> = {
  anthropic_api_key: 'anthropic-api',
  claude_oauth: 'claude-max',
  pi_chatgpt_oauth: 'chatgpt-plus',
  pi_copilot_oauth: 'github-copilot',
  pi_api_key: 'pi-api-key',
}

export function resolveInitialStep(initialSetupNeeds: SetupNeeds | undefined, fallback: OnboardingStep): OnboardingStep {
  if (initialSetupNeeds?.needsAdminLogin) {
    return 'admin-login'
  }
  return fallback
}

export function mapAdminLoginError(error: unknown): string {
  const errorLike = error as { errorCode?: string; message?: string; status?: number } | undefined
  if (typeof errorLike?.status === 'number' && errorLike.status >= 500) {
    return i18n.t('onboarding.adminLogin.genericError')
  }
  if (errorLike?.errorCode === 'INVALID_CREDENTIALS' || errorLike?.errorCode === 'invalid_credentials') {
    return i18n.t('onboarding.adminLogin.invalidCredentials')
  }
  if (errorLike?.errorCode === 'ACCOUNT_DISABLED' || errorLike?.errorCode === 'account_disabled') {
    return i18n.t('onboarding.adminLogin.accountDisabled')
  }
  if (errorLike?.errorCode === 'NETWORK_ERROR') {
    return i18n.t('onboarding.adminLogin.networkError')
  }
  const message = error instanceof Error ? error.message : errorLike?.message
  if (message && /network|fetch|failed to reach|connection/i.test(message)) {
    return i18n.t('onboarding.adminLogin.networkError')
  }

  return message || i18n.t('onboarding.adminLogin.genericError')
}

export function mapAdminPhoneAuthError(error: unknown): string {
  const errorLike = error as {
    errorCode?: string
    message?: string
    retryAfter?: number
    status?: number
  } | undefined

  if (typeof errorLike?.status === 'number' && errorLike.status >= 500) {
    return i18n.t('onboarding.adminLogin.phoneAuthUnavailable')
  }

  switch (errorLike?.errorCode) {
    case 'invalid_phone':
      return i18n.t('onboarding.adminLogin.invalidPhone')
    case 'verification_code_invalid':
      return i18n.t('onboarding.adminLogin.verificationCodeInvalid')
    case 'verification_code_expired':
      return i18n.t('onboarding.adminLogin.verificationCodeExpired')
    case 'verification_attempts_exceeded':
      return i18n.t('onboarding.adminLogin.verificationAttemptsExceeded')
    case 'sms_rate_limited':
      return i18n.t('onboarding.adminLogin.smsRateLimited', {
        count: Math.max(1, Math.ceil(errorLike.retryAfter ?? 60)),
      })
    case 'invalid_credentials':
      return i18n.t('onboarding.adminLogin.challengeFailed')
    case 'phone_auth_disabled':
      return i18n.t('onboarding.adminLogin.phoneAuthDisabled')
    case 'phone_not_registered':
      return i18n.t('onboarding.adminLogin.phoneNotRegistered')
    case 'sms_send_failed':
    case 'phone_auth_configuration_error':
      return i18n.t('onboarding.adminLogin.phoneAuthUnavailable')
    case 'NETWORK_ERROR':
      return i18n.t('onboarding.adminLogin.networkError')
  }

  if (
    error instanceof Error && /network|fetch|failed to reach|connection/i.test(error.message)
  ) {
    return i18n.t('onboarding.adminLogin.networkError')
  }

  return i18n.t('onboarding.adminLogin.genericError')
}

export function resolvePhoneAuthAvailability(
  serverEnabled: boolean,
  challengeProvider: UseOnboardingOptions['phoneAuthChallengeProvider'],
  discoveryAvailable: boolean,
): boolean {
  return (
    serverEnabled
    && discoveryAvailable
    && typeof challengeProvider === 'function'
  )
}

export async function sendPhoneAuthCodeWithChallenge(
  phone: string,
  challengeProvider: UseOnboardingOptions['phoneAuthChallengeProvider'],
  send: (phone: string, challengeToken: string) => Promise<AdminSendPhoneAuthCodeResult>,
): Promise<AdminSendPhoneAuthCodeResult> {
  if (!challengeProvider) {
    return { success: false, errorCode: 'phone_auth_configuration_error' }
  }

  try {
    const challengeToken = await challengeProvider()
    if (!challengeToken?.trim()) {
      return { success: false, errorCode: 'phone_auth_configuration_error' }
    }
    return await send(phone, challengeToken)
  } catch {
    return { success: false, errorCode: 'phone_auth_configuration_error' }
  }
}

export function resolveAdminLoginSuccessState(state: OnboardingState): OnboardingState {
  return {
    ...state,
    loginStatus: 'success',
    completionStatus: 'complete',
    errorMessage: undefined,
    step: 'complete',
  }
}

export function resolveAdminLoginFailureState(state: OnboardingState, error: unknown): OnboardingState {
  return {
    ...state,
    loginStatus: 'error',
    errorMessage: mapAdminLoginError(error),
  }
}

export function resolveAdminReloginState(state: OnboardingState): OnboardingState {
  return {
    ...state,
    step: 'admin-login',
    loginStatus: 'idle',
    phoneAuthEnabled: undefined,
    errorMessage: undefined,
  }
}

export function resolveAdminKickedState(state: OnboardingState): OnboardingState {
  return {
    ...state,
    step: 'admin-kicked',
    loginStatus: 'idle',
    errorMessage: undefined,
  }
}

/**
 * Generate a unique slug for a new connection.
 * If the base slug is taken, appends -2, -3, etc.
 * When editingSlug is provided, reuses that slug (editing existing connection).
 */
export function resolveSlugForMethod(
  method: ApiSetupMethod,
  editingSlug: string | null,
  existingSlugs: Set<string>,
): string {
  // Editing an existing connection — reuse its slug
  if (editingSlug) return editingSlug

  const base = BASE_SLUG_FOR_METHOD[method]
  if (!existingSlugs.has(base)) return base

  let i = 2
  while (existingSlugs.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}

// Map ApiSetupMethod to LlmConnectionSetup for the new unified connection system
function isLoopbackEndpoint(baseUrl?: string): boolean {
  if (!baseUrl?.trim()) return false
  try {
    const hostname = new URL(baseUrl.trim()).hostname
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1'
  } catch {
    return false
  }
}

export function apiSetupMethodToConnectionSetup(
  method: ApiSetupMethod,
  options: {
    credential?: string
    baseUrl?: string
    connectionDefaultModel?: string
    models?: string[]
    piAuthProvider?: string
    modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
    customEndpoint?: CustomEndpointConfig
    iamCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
    awsRegion?: string
    bedrockAuthMethod?: 'iam_credentials' | 'environment'
  },
  editingSlug: string | null,
  existingSlugs: Set<string>,
): LlmConnectionSetup {
  const slug = resolveSlugForMethod(method, editingSlug, existingSlugs)

  switch (method) {
    case 'anthropic_api_key':
      return {
        slug,
        credential: options.credential,
        baseUrl: options.baseUrl,
        defaultModel: options.connectionDefaultModel,
        models: options.models,
        customEndpoint: options.customEndpoint,
      }
    case 'claude_oauth':
      return {
        slug,
        credential: options.credential,
      }
    case 'pi_chatgpt_oauth':
    case 'pi_copilot_oauth':
      return {
        slug,
        credential: options.credential,
      }
    case 'pi_api_key':
      return {
        slug,
        credential: options.credential,
        baseUrl: options.baseUrl,
        defaultModel: options.connectionDefaultModel,
        models: options.models,
        piAuthProvider: options.piAuthProvider,
        modelSelectionMode: options.modelSelectionMode,
        customEndpoint: options.customEndpoint,
        iamCredentials: options.iamCredentials,
        awsRegion: options.awsRegion,
        bedrockAuthMethod: options.bedrockAuthMethod,
      }
  }
}

export function useOnboarding({
  onComplete,
  initialSetupNeeds,
  initialStep = 'welcome',
  initialApiSetupMethod,
  onDismiss,
  onConfigSaved,
  editingSlug = null,
  existingSlugs = new Set(),
  phoneAuthChallengeProvider,
}: UseOnboardingOptions): UseOnboardingReturn {
  const resolvedInitialStep = resolveInitialStep(initialSetupNeeds, initialStep)

  // Main wizard state
  const [state, setState] = useState<OnboardingState>({
    step: resolvedInitialStep,
    loginStatus: 'idle',
    credentialStatus: 'idle',
    completionStatus: 'saving',
    apiSetupMethod: initialApiSetupMethod ?? null,
    isExistingUser: initialSetupNeeds?.needsBillingConfig ?? false,
    gitBashStatus: undefined,
    isRecheckingGitBash: false,
    isCheckingGitBash: true, // Start as true until check completes
  })

  useEffect(() => {
    if (!initialSetupNeeds?.needsAdminLogin) return
    setState(s => {
      if (s.step === 'admin-login' || s.step === 'admin-kicked') return s
      return {
        ...s,
        step: 'admin-login',
        loginStatus: 'idle',
        errorMessage: undefined,
      }
    })
  }, [initialSetupNeeds?.needsAdminLogin])

  useEffect(() => {
    if (state.step !== 'admin-login' || state.phoneAuthEnabled !== undefined) return
    let cancelled = false
    window.electronAPI.adminGetAuthConfig()
      .then(async result => {
        if (!cancelled) {
          const discovery = result.phoneAuthEnabled
            ? await window.electronAPI.adminGetPhoneAuthChallengeConfig()
                .catch(() => ({ success: false as const }))
            : { success: false as const }
          if (cancelled) return
          const phoneAuthEnabled = resolvePhoneAuthAvailability(
            result.phoneAuthEnabled,
            phoneAuthChallengeProvider,
            discovery.success,
          )
          setState(s => ({
            ...s,
            phoneAuthEnabled,
            ...(result.phoneAuthEnabled && !phoneAuthEnabled
              ? { errorMessage: mapAdminPhoneAuthError({ errorCode: 'phone_auth_configuration_error' }) }
              : {}),
          }))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState(s => ({ ...s, phoneAuthEnabled: false }))
        }
      })
    return () => {
      cancelled = true
    }
  }, [phoneAuthChallengeProvider, state.step, state.phoneAuthEnabled])

  // Check Git Bash on Windows at mount. If missing, redirect to git-bash step.
  useEffect(() => {
    const checkGitBash = async () => {
      try {
        const status = await window.electronAPI.checkGitBash()
        setState(s => ({
          ...s,
          gitBashStatus: status,
          isCheckingGitBash: false,
          // Redirect to git-bash step when missing on Windows
          ...(status.platform === 'win32' && !status.found && s.step !== 'admin-login' && s.step !== 'admin-kicked'
            ? { step: 'git-bash' as const }
            : {}),
        }))
      } catch (error) {
        console.error('[Onboarding] Failed to check Git Bash:', error)
        // Even on error, allow continuing (will skip git-bash step)
        setState(s => ({ ...s, isCheckingGitBash: false }))
      }
    }
    checkGitBash()
  }, [])

  // Save configuration using the new unified LLM connection API
  // Returns true on success, false on failure (sets errorMessage on failure)
  // `methodOverride` lets callers pass the method explicitly to avoid stale-closure issues
  // (e.g. when called from an async OAuth flow whose closure predates the state update).
  const handleSaveConfig = useCallback(async (
    credential?: string,
    options?: {
      baseUrl?: string
      connectionDefaultModel?: string
      models?: string[]
      piAuthProvider?: string
      modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
      customEndpoint?: CustomEndpointConfig
      iamCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
      awsRegion?: string
      bedrockAuthMethod?: 'iam_credentials' | 'environment'
    },
    methodOverride?: ApiSetupMethod,
    connectionSlugOverride?: string,
    updateOnly?: boolean,
  ): Promise<boolean> => {
    const method = methodOverride ?? state.apiSetupMethod
    if (!method) {
      return false
    }

    setState(s => ({ ...s, completionStatus: 'saving' }))

    try {
      // Build connection setup from UI state
      const setup = apiSetupMethodToConnectionSetup(method, {
        credential,
        baseUrl: options?.baseUrl,
        connectionDefaultModel: options?.connectionDefaultModel,
        models: options?.models,
        piAuthProvider: options?.piAuthProvider,
        modelSelectionMode: options?.modelSelectionMode,
        customEndpoint: options?.customEndpoint,
        iamCredentials: options?.iamCredentials,
        awsRegion: options?.awsRegion,
        bedrockAuthMethod: options?.bedrockAuthMethod,
      }, connectionSlugOverride ?? editingSlug, existingSlugs)
      // Use new unified API
      const result = await window.electronAPI.setupLlmConnection(
        updateOnly ? { ...setup, updateOnly: true } : setup
      )

      if (result.success) {
        setState(s => ({ ...s, completionStatus: 'complete' }))
        // Notify caller immediately so UI can reflect billing/model changes
        onConfigSaved?.()
        return true
      } else {
        console.error('[Onboarding] Save failed:', result.error)
        setState(s => ({
          ...s,
          completionStatus: 'saving',
          errorMessage: result.error || 'Failed to save configuration',
        }))
        return false
      }
    } catch (error) {
      console.error('[Onboarding] handleSaveConfig error:', error)
      setState(s => ({
        ...s,
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
      return false
    }
  }, [state.apiSetupMethod, onConfigSaved, editingSlug, existingSlugs])

  // Continue to next step
  const handleContinue = useCallback(async () => {
    switch (state.step) {
      case 'provider-select':
        setState(s => ({ ...s, step: 'complete' }))
        break

      case 'admin-login':
      case 'admin-kicked':
        break

      case 'welcome':
        // On Windows, check if Git Bash is needed
        if (state.gitBashStatus?.platform === 'win32' && !state.gitBashStatus?.found) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else {
          setState(s => ({ ...s, step: 'complete', completionStatus: 'complete' }))
        }
        break

      case 'git-bash':
        setState(s => ({ ...s, step: 'complete', completionStatus: 'complete' }))
        break

      case 'local-model':
        // Handled by handleSubmitLocalModel
        break

      case 'credentials':
        // Handled by handleSubmitCredential
        break

      case 'complete':
        onComplete()
        break
    }
  }, [state.step, state.gitBashStatus, state.apiSetupMethod, onComplete])

  // Go back to previous step. If at the initial step, call onDismiss instead.
  const handleBack = useCallback(() => {
    if (state.step === initialStep && onDismiss) {
      onDismiss()
      return
    }
    switch (state.step) {
      case 'git-bash':
        if (onDismiss) {
          onDismiss()
        }
        break
      case 'provider-select':
        // If on Windows and Git Bash was needed, go back to git-bash step
        if (state.gitBashStatus?.platform === 'win32' && state.gitBashStatus?.found === false) {
          setState(s => ({ ...s, step: 'git-bash' }))
        } else if (onDismiss) {
          onDismiss()
        }
        break
      case 'credentials':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
      case 'local-model':
        setState(s => ({ ...s, step: 'provider-select', credentialStatus: 'idle', errorMessage: undefined }))
        break
      case 'admin-login':
      case 'admin-kicked':
        if (onDismiss) {
          onDismiss()
        }
        break
    }
  }, [state.step, state.gitBashStatus, initialStep, onDismiss])

  const handleAdminLogin = useCallback(async (identifier: string, password: string) => {
    setState(s => ({ ...s, loginStatus: 'waiting', errorMessage: undefined }))

    try {
      const result = await window.electronAPI.adminLogin(identifier, password)
      if (result.success) {
        setState(resolveAdminLoginSuccessState)
        onConfigSaved?.()
        return
      }

      setState(s => resolveAdminLoginFailureState(s, result))
    } catch (error) {
      setState(s => resolveAdminLoginFailureState(s, error))
    }
  }, [onConfigSaved])

  const handleAdminSendPhoneCode = useCallback(async (
    phone: string,
  ): Promise<AdminSendPhoneAuthCodeResult> => {
    setState(s => ({ ...s, loginStatus: 'waiting', errorMessage: undefined }))

    try {
      const result = await sendPhoneAuthCodeWithChallenge(
        phone,
        phoneAuthChallengeProvider,
        (normalizedPhone, challengeToken) =>
          window.electronAPI.adminSendPhoneAuthCode(normalizedPhone, challengeToken),
      )
      if (result.success) {
        setState(s => ({ ...s, loginStatus: 'idle', errorMessage: undefined }))
        return result
      }
      setState(s => ({
        ...s,
        loginStatus: 'error',
        errorMessage: mapAdminPhoneAuthError(result),
      }))
      return result
    } catch (error) {
      setState(s => ({
        ...s,
        loginStatus: 'error',
        errorMessage: mapAdminPhoneAuthError(error),
      }))
      return { success: false, errorCode: 'NETWORK_ERROR' }
    }
  }, [phoneAuthChallengeProvider])

  const handleAdminVerifyPhoneCode = useCallback(async (phone: string, code: string): Promise<boolean> => {
    setState(s => ({ ...s, loginStatus: 'waiting', errorMessage: undefined }))

    try {
      const result = await window.electronAPI.adminVerifyPhoneAuthCode(phone, code)
      if (result.success) {
        setState(resolveAdminLoginSuccessState)
        onConfigSaved?.()
        return true
      }
      setState(s => ({
        ...s,
        loginStatus: 'error',
        errorMessage: mapAdminPhoneAuthError(result),
      }))
      return false
    } catch (error) {
      setState(s => ({
        ...s,
        loginStatus: 'error',
        errorMessage: mapAdminPhoneAuthError(error),
      }))
      return false
    }
  }, [onConfigSaved])

  const handleAdminRelogin = useCallback(() => {
    setState(resolveAdminReloginState)
  }, [])

  const showAdminKicked = useCallback(() => {
    setState(resolveAdminKickedState)
  }, [])

  // Select API setup method (legacy — kept for direct edit flows)
  const handleSelectApiSetupMethod = useCallback((method: ApiSetupMethod) => {
    setState(s => ({ ...s, apiSetupMethod: method }))
  }, [])

  // Submit credential (API key + optional endpoint config)
  // Tests the connection first before saving to catch issues early
  const handleSubmitCredential = useCallback(async (data: ApiKeySubmitData) => {
    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    const isPiApiKeyFlow = state.apiSetupMethod === 'pi_api_key'

    try {
      // Bedrock (Pi+amazon-bedrock) — skip API key validation and connection test
      if (data.bedrockAuthMethod) {
        const saved = await handleSaveConfig(undefined, {
          baseUrl: data.baseUrl,
          connectionDefaultModel: data.connectionDefaultModel,
          models: data.models,
          piAuthProvider: data.piAuthProvider,
          modelSelectionMode: data.modelSelectionMode,
          iamCredentials: data.iamCredentials,
          awsRegion: data.awsRegion,
          bedrockAuthMethod: data.bedrockAuthMethod,
        })
        if (saved) {
          setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
        } else {
          setState(s => ({ ...s, credentialStatus: 'error' }))
        }
        return
      }

      // When editing an existing connection, API key is optional (empty = keep existing credential)
      if (!data.apiKey.trim() && editingSlug) {
        const saved = await handleSaveConfig(undefined, {
          baseUrl: data.baseUrl,
          connectionDefaultModel: data.connectionDefaultModel,
          models: data.models,
          piAuthProvider: data.piAuthProvider,
          modelSelectionMode: data.modelSelectionMode,
          customEndpoint: data.customEndpoint,
        })
        if (saved) {
          setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
        } else {
          setState(s => ({ ...s, credentialStatus: 'error' }))
        }
        return
      }

      // API key validation differs by endpoint locality:
      // - Local/loopback custom endpoints may be keyless (e.g. Ollama)
      // - Non-local endpoints require an API key
      const isLoopbackCustomEndpoint = isLoopbackEndpoint(data.baseUrl)
      if (isPiApiKeyFlow) {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      } else {
        if (!data.apiKey.trim() && !isLoopbackCustomEndpoint) {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: 'Please enter a valid API key',
          }))
          return
        }
      }

      // Validate connection by spawning a lightweight subprocess test.
      // Custom endpoint protocol routes through PiAgent at runtime, so test with Pi too.
      const setupTestProvider = data.customEndpoint ? 'pi' : (isPiApiKeyFlow ? 'pi' : 'anthropic')
      const testResult = await window.electronAPI.testLlmConnectionSetup({
        provider: setupTestProvider,
        apiKey: data.apiKey,
        baseUrl: data.baseUrl,
        model: data.models?.[0],
        piAuthProvider: data.piAuthProvider,
        customEndpoint: data.customEndpoint,
      })

      if (!testResult.success) {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: testResult.error || 'Connection test failed',
        }))
        return
      }

      const saved = await handleSaveConfig(data.apiKey, {
        baseUrl: data.baseUrl,
        connectionDefaultModel: data.connectionDefaultModel,
        models: data.models,
        piAuthProvider: data.piAuthProvider,
        modelSelectionMode: data.modelSelectionMode,
        customEndpoint: data.customEndpoint,
      })

      if (saved) {
        setState(s => ({
          ...s,
          credentialStatus: 'success',
          step: 'complete',
        }))
      } else {
        // Save failed — error is already set by handleSaveConfig, stay on credentials step
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Validation failed',
      }))
    }
  }, [handleSaveConfig, state.apiSetupMethod])

  // Save config, validate the connection, and update state accordingly.
  // Shared by all OAuth flows after tokens are captured.
  // `method` is passed explicitly to break the stale-closure chain — the OAuth
  // await crosses renders, so handleSaveConfig's closure may have an outdated
  // state.apiSetupMethod.
  const saveAndValidateConnection = useCallback(async (connectionSlug: string, method: ApiSetupMethod, credential?: string, updateOnly?: boolean): Promise<boolean> => {
    const saved = await handleSaveConfig(credential, undefined, method, connectionSlug, updateOnly)
    if (!saved) {
      setState(s => ({ ...s, credentialStatus: 'error' }))
      return false
    }
    const testResult = await window.electronAPI.testLlmConnection(connectionSlug)
    if (testResult.success) {
      setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
      return true
    } else {
      setState(s => ({ ...s, credentialStatus: 'error', errorMessage: testResult.error || 'Connection test failed' }))
      return false
    }
  }, [handleSaveConfig])

  // Two-step OAuth flow state
  const [isWaitingForCode, setIsWaitingForCode] = useState(false)

  // Copilot device code (displayed during device flow)
  const [copilotDeviceCode, setCopilotDeviceCode] = useState<{ userCode: string; verificationUri: string } | undefined>()

  // Start OAuth flow (Claude or ChatGPT depending on selected method)
  const handleStartOAuth = useCallback(async (methodOverride?: ApiSetupMethod, connectionSlugOverride?: string) => {
    const effectiveMethod = methodOverride ?? state.apiSetupMethod

    if (methodOverride && methodOverride !== state.apiSetupMethod) {
      setState(s => ({
        ...s,
        apiSetupMethod: methodOverride,
        step: 'credentials',
        credentialStatus: 'validating',
        errorMessage: undefined,
      }))
    } else {
      setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))
    }

    if (!effectiveMethod) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: 'Select an authentication method first.',
      }))
      return
    }

    try {
      // ChatGPT OAuth (single-step flow - opens browser, captures tokens automatically)
      if (effectiveMethod === 'pi_chatgpt_oauth') {
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug
        const result = await window.electronAPI.startChatGptOAuth(connectionSlug)

        if (result.success) {
          await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth)
        } else {
          setState(s => ({
            ...s,
            credentialStatus: 'error',
            errorMessage: result.error || 'ChatGPT authentication failed',
          }))
        }
        return
      }

      // Copilot OAuth (device flow — polls for token after user enters code on GitHub)
      if (effectiveMethod === 'pi_copilot_oauth') {
        const effectiveEditingSlug = connectionSlugOverride ?? editingSlug
        const isReauth = !!effectiveEditingSlug
        const connectionSlug = apiSetupMethodToConnectionSetup(effectiveMethod, {}, effectiveEditingSlug, existingSlugs).slug

        // Subscribe to device code event before starting the flow
        const cleanup = window.electronAPI.onCopilotDeviceCode((data) => {
          setCopilotDeviceCode(data)
        })

        try {
          const result = await window.electronAPI.startCopilotOAuth(connectionSlug)

          if (result.success) {
            await saveAndValidateConnection(connectionSlug, effectiveMethod, undefined, isReauth)
          } else {
            setState(s => ({
              ...s,
              credentialStatus: 'error',
              errorMessage: result.error || 'GitHub authentication failed',
            }))
          }
        } finally {
          cleanup()
          setCopilotDeviceCode(undefined)
        }
        return
      }

      // Claude OAuth (two-step flow - opens browser, user copies code)
      // Remaining method must be claude_oauth
      if (effectiveMethod !== 'claude_oauth') {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: 'This connection uses API keys, not OAuth.',
        }))
        return
      }

      const result = await window.electronAPI.startClaudeOAuth()

      if (result.success) {
        // Browser opened successfully, now waiting for user to copy the code
        setIsWaitingForCode(true)
        setState(s => ({ ...s, credentialStatus: 'idle' }))
      } else {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: result.error || 'Failed to start OAuth',
        }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'OAuth failed',
      }))
    }
  }, [state.apiSetupMethod, saveAndValidateConnection, editingSlug, existingSlugs])

  // Map ProviderChoice → ApiSetupMethod and navigate to the right step
  const handleSelectProvider = useCallback((choice: ProviderChoice) => {
    const CHOICE_TO_METHOD: Record<Exclude<ProviderChoice, 'local'>, ApiSetupMethod> = {
      claude: 'claude_oauth',
      chatgpt: 'pi_chatgpt_oauth',
      copilot: 'pi_copilot_oauth',
      api_key: 'pi_api_key',
    }

    if (choice === 'local') {
      // Local uses anthropic_api_key with custom endpoint (Ollama doesn't need an API key)
      setState(s => ({ ...s, step: 'local-model', apiSetupMethod: 'anthropic_api_key', credentialStatus: 'idle', errorMessage: undefined }))
      return
    }

    const method = CHOICE_TO_METHOD[choice]
    setState(s => ({
      ...s,
      apiSetupMethod: method,
      step: 'credentials',
      credentialStatus: 'idle',
      errorMessage: undefined,
    }))

    // OAuth methods start immediately
    if (choice === 'claude' || choice === 'chatgpt' || choice === 'copilot') {
      // Defer to next tick so state is updated before handleStartOAuth reads it
      setTimeout(() => handleStartOAuth(method), 0)
    }
  }, [handleStartOAuth])

  // Submit authorization code (second step of OAuth flow)
  const handleSubmitAuthCode = useCallback(async (code: string) => {
    if (!code.trim()) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: 'Please enter the authorization code',
      }))
      return
    }

    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    try {
      const connectionSlug = apiSetupMethodToConnectionSetup('claude_oauth', {}, editingSlug, existingSlugs).slug
      const result = await window.electronAPI.exchangeClaudeCode(code.trim(), connectionSlug)

      if (result.success && result.token) {
        setIsWaitingForCode(false)
        await saveAndValidateConnection(connectionSlug, 'claude_oauth', result.token, !!editingSlug)
      } else {
        setState(s => ({
          ...s,
          credentialStatus: 'error',
          errorMessage: result.error || 'Failed to exchange code',
        }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to exchange code',
      }))
    }
  }, [saveAndValidateConnection, editingSlug, existingSlugs])

  // Submit local model configuration (Ollama or any OpenAI-compatible local server)
  const handleSubmitLocalModel = useCallback(async (data: LocalModelSubmitData) => {
    setState(s => ({ ...s, credentialStatus: 'validating', errorMessage: undefined }))

    try {
      // apiSetupMethod was set to 'anthropic_api_key' when entering local-model step
      const saved = await handleSaveConfig(undefined, {
        baseUrl: data.baseUrl,
        connectionDefaultModel: data.model,
        models: data.models,
        customEndpoint: { api: 'openai-completions' },
      })

      if (saved) {
        setState(s => ({ ...s, credentialStatus: 'success', step: 'complete' }))
      } else {
        setState(s => ({ ...s, credentialStatus: 'error' }))
      }
    } catch (error) {
      setState(s => ({
        ...s,
        credentialStatus: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to save configuration',
      }))
    }
  }, [handleSaveConfig])

  // Cancel OAuth flow
  const handleCancelOAuth = useCallback(async () => {
    setIsWaitingForCode(false)
    setState(s => ({ ...s, credentialStatus: 'idle', errorMessage: undefined }))
    // Clear OAuth state on backend
    await window.electronAPI.clearClaudeOAuthState()
  }, [])

  // Git Bash handlers (Windows only)
  const handleBrowseGitBash = useCallback(async () => {
    return window.electronAPI.browseForGitBash()
  }, [])

  const handleUseGitBashPath = useCallback(async (path: string) => {
    const result = await window.electronAPI.setGitBashPath(path)
    if (result.success) {
      // Update state to mark Git Bash as found and continue
      setState(s => ({
        ...s,
        gitBashStatus: { ...s.gitBashStatus!, found: true, path },
        step: 'complete',
        completionStatus: 'complete',
      }))
    } else {
      setState(s => ({
        ...s,
        errorMessage: result.error || 'Invalid path',
      }))
    }
  }, [])

  const handleRecheckGitBash = useCallback(async () => {
    setState(s => ({ ...s, isRecheckingGitBash: true }))
    try {
      const status = await window.electronAPI.checkGitBash()
      setState(s => ({
        ...s,
        gitBashStatus: status,
        isRecheckingGitBash: false,
        // If found, automatically continue to next step
        step: status.found ? 'complete' : s.step,
        completionStatus: status.found ? 'complete' : s.completionStatus,
      }))
    } catch (error) {
      console.error('[Onboarding] Failed to recheck Git Bash:', error)
      setState(s => ({ ...s, isRecheckingGitBash: false }))
    }
  }, [])

  const handleClearError = useCallback(() => {
    setState(s => ({ ...s, errorMessage: undefined }))
  }, [])

  // Skip setup — user chose "Setup later"
  const handleSkipSetup = useCallback(async () => {
    try {
      await window.electronAPI.deferSetup()
    } catch (error) {
      console.error('[Onboarding] Failed to defer setup:', error)
    }
    onComplete()
  }, [onComplete])

  // Finish onboarding
  const handleFinish = useCallback(() => {
    onComplete()
  }, [onComplete])

  // Cancel onboarding
  const handleCancel = useCallback(() => {
    setState(s => ({ ...s, step: 'welcome' }))
  }, [])

  // Jump directly to credentials step with a pre-set method (for editing existing connections)
  const jumpToCredentials = useCallback((method: ApiSetupMethod) => {
    setState(s => ({
      ...s,
      step: 'credentials' as const,
      apiSetupMethod: method,
      credentialStatus: 'idle' as const,
      errorMessage: undefined,
    }))
  }, [])

  // Reset onboarding to initial state (used after logout or modal close)
  const reset = useCallback(() => {
    setState({
      step: resolvedInitialStep,
      loginStatus: 'idle',
      credentialStatus: 'idle',
      completionStatus: 'saving',
      apiSetupMethod: initialApiSetupMethod ?? null,
      isExistingUser: initialSetupNeeds?.needsBillingConfig ?? false,
      errorMessage: undefined,
    })
    setIsWaitingForCode(false)
    // Clean up any pending OAuth state
    window.electronAPI.clearClaudeOAuthState().catch(() => {
      // Ignore errors - state may not exist
    })
  }, [resolvedInitialStep, initialApiSetupMethod, initialSetupNeeds?.needsBillingConfig])

  return {
    state,
    handleContinue,
    handleBack,
    handleSelectProvider,
    handleSelectApiSetupMethod,
    handleSubmitCredential,
    handleAdminLogin,
    handleAdminSendPhoneCode,
    handleAdminVerifyPhoneCode,
    handleAdminRelogin,
    showAdminKicked,
    handleSubmitLocalModel,
    handleStartOAuth,
    // Two-step OAuth flow
    isWaitingForCode,
    handleSubmitAuthCode,
    handleCancelOAuth,
    // Copilot device code
    copilotDeviceCode,
    // Git Bash (Windows)
    handleBrowseGitBash,
    handleUseGitBashPath,
    handleRecheckGitBash,
    handleClearError,
    handleSkipSetup,
    handleFinish,
    handleCancel,
    jumpToCredentials,
    reset,
  }
}
