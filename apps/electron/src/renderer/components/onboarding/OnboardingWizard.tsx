import { cn } from "@/lib/utils"
import { WelcomeStep } from "./WelcomeStep"
import type { ApiSetupMethod } from "./APISetupStep"
import type { ProviderChoice } from "./ProviderSelectStep"
import type { CredentialStatus } from "./CredentialsStep"
import type { LocalModelSubmitData } from "./LocalModelStep"
import { CompletionStep } from "./CompletionStep"
import { GitBashWarning, type GitBashStatus } from "./GitBashWarning"
import { AdminLoginStep } from "./AdminLoginStep"
import { AdminKickedStep } from "./AdminKickedStep"
import type { ApiKeySubmitData } from "../apisetup"
import type { CustomEndpointApi } from '@config/llm-connections'
import type { AdminSendPhoneAuthCodeResult } from '../../../shared/types'

export type OnboardingStep =
  | 'admin-login'
  | 'admin-kicked'
  | 'welcome'
  | 'git-bash'
  | 'provider-select'
  | 'local-model'
  | 'credentials'
  | 'complete'

export type LoginStatus = 'idle' | 'waiting' | 'success' | 'error'

export interface OnboardingState {
  step: OnboardingStep
  loginStatus: LoginStatus
  credentialStatus: CredentialStatus
  completionStatus: 'saving' | 'complete'
  apiSetupMethod: ApiSetupMethod | null
  isExistingUser: boolean
  phoneAuthEnabled?: boolean
  errorMessage?: string
  gitBashStatus?: GitBashStatus
  isRecheckingGitBash?: boolean
  isCheckingGitBash?: boolean
}

interface OnboardingWizardProps {
  /** Current state of the wizard */
  state: OnboardingState

  // Event handlers
  onContinue: () => void
  onBack: () => void
  onSelectApiSetupMethod: (method: ApiSetupMethod) => void
  onSubmitCredential: (data: ApiKeySubmitData) => void
  onStartOAuth?: (methodOverride?: ApiSetupMethod) => void
  onFinish: () => void
  onAdminLogin?: (identifier: string, password: string) => void
  onAdminSendPhoneCode?: (phone: string) => Promise<AdminSendPhoneAuthCodeResult>
  onAdminVerifyPhoneCode?: (phone: string, code: string) => Promise<boolean>
  onAdminRelogin?: () => void

  // Claude OAuth (two-step flow)
  isWaitingForCode?: boolean
  onSubmitAuthCode?: (code: string) => void
  onCancelOAuth?: () => void

  // Copilot device flow
  copilotDeviceCode?: { userCode: string; verificationUri: string }

  // Git Bash (Windows)
  onBrowseGitBash?: () => Promise<string | null>
  onUseGitBashPath?: (path: string) => void
  onRecheckGitBash?: () => void
  onClearError?: () => void

  // Provider select (new flow)
  onSelectProvider?: (choice: ProviderChoice) => void
  /** Called when user chooses "Setup later" on provider select */
  onSkipSetup?: () => void

  // Local model
  onSubmitLocalModel?: (data: LocalModelSubmitData) => void

  // Edit mode (pre-fill existing connection values)
  editInitialValues?: {
    apiKey?: string
    baseUrl?: string
    connectionDefaultModel?: string
    activePreset?: string
    models?: string[]
    customApi?: CustomEndpointApi
  }

  className?: string
}

/**
 * OnboardingWizard - Full-screen onboarding flow container
 *
 * Manages the step-by-step flow for setting up Polo AI:
 * 1. Welcome
 * 2. Provider Select (Claude / ChatGPT / Copilot / API Key / Local)
 * 3. Credentials (API Key or OAuth) or Local Model
 * 4. Completion
 */
export function OnboardingWizard({
  state,
  onContinue,
  onBack,
  onFinish,
  onAdminLogin,
  onAdminSendPhoneCode,
  onAdminVerifyPhoneCode,
  onAdminRelogin,
  // Git Bash (Windows)
  onBrowseGitBash,
  onUseGitBashPath,
  onRecheckGitBash,
  onClearError,
  className
}: OnboardingWizardProps) {
  const renderStep = () => {
    switch (state.step) {
      case 'admin-login':
        return (
          <AdminLoginStep
            errorMessage={state.errorMessage}
            isLoading={state.loginStatus === 'waiting'}
            phoneAuthEnabled={state.phoneAuthEnabled}
            onClearError={onClearError!}
            onSendPhoneCode={onAdminSendPhoneCode!}
            onVerifyPhoneCode={onAdminVerifyPhoneCode!}
            onSubmit={onAdminLogin!}
          />
        )

      case 'admin-kicked':
        return <AdminKickedStep onRelogin={onAdminRelogin!} />

      case 'welcome':
        return (
          <WelcomeStep
            isExistingUser={state.isExistingUser}
            onContinue={onContinue}
            isLoading={state.isCheckingGitBash}
          />
        )

      case 'git-bash':
        return (
          <GitBashWarning
            status={state.gitBashStatus!}
            onBrowse={onBrowseGitBash!}
            onUsePath={onUseGitBashPath!}
            onRecheck={onRecheckGitBash!}
            onBack={onBack}
            isRechecking={state.isRecheckingGitBash}
            errorMessage={state.errorMessage}
            onClearError={onClearError}
          />
        )

      case 'complete':
        return (
          <CompletionStep
            status={state.completionStatus}
            onFinish={onFinish}
          />
        )

      default:
        return null
    }
  }

  return (
    <div
      className={cn(
        "bg-foreground-2 overflow-y-auto",
        !className?.includes('h-full') && "h-dvh",
        className
      )}
    >
      {/* Draggable title bar region for transparent window (macOS) */}
      <div className="titlebar-drag-region fixed top-0 left-0 right-0 h-[50px] z-titlebar" />

      {/* Main content — min-h-full + flex center means: center when content fits,
          natural flow + scroll when content is taller than the viewport (mobile). */}
      <main className="flex min-h-full items-center justify-center p-4 sm:p-8">
        {renderStep()}
      </main>
    </div>
  )
}
