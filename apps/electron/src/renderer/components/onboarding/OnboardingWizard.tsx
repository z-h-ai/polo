import { useClientWorkbenchStyle, useClientMaterialScope, clientWorkbenchFocusClassName } from '@/components/ui/client-workbench'
import { cn } from "@/lib/utils"
import { useTranslation } from "react-i18next"
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
  onAdminCancelLogin?: () => void
  onAdminSendPhoneCode?: (phone: string) => Promise<AdminSendPhoneAuthCodeResult>
  onAdminVerifyPhoneCode?: (phone: string, code: string) => Promise<boolean>
  onAdminRelogin?: () => void
  /** Quiet first-run escape hatch: forwards the existing app-quit channel. */
  onQuitApp?: () => void

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
 * Neutral fallback for state-machine steps the wizard no longer renders
 * (legacy provider-select/local-model/credentials can still be SET by
 * useOnboarding). Previously these fell through to `null` — a full white
 * screen. This card guarantees there is always a visible way forward:
 * "Continue" re-enters the rendered admin-login step (or completes the
 * wizard when no relogin handler exists). Presentation only — the state
 * machine itself is untouched.
 */
function WizardStepFallback({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation()
  return (
    <section
      data-testid="onboarding-step-fallback"
      className="flex w-full max-w-[420px] flex-col items-center rounded-[20px] border border-border bg-surface p-[30px] text-center shadow-modal-small"
    >
      <span className="grid size-[40px] flex-none place-items-center rounded-[10px] bg-foreground text-[18px] font-extrabold text-background" aria-hidden="true">
        P
      </span>
      <h1 className="mt-[14px] m-0 text-[20px] font-bold tracking-[-0.03em] text-foreground">
        Polo AI
      </h1>
      <p className="mt-[8px] m-0 text-[14px] leading-[1.55] text-foreground-60">
        {t("onboarding.stepFallback.description")}
      </p>
      <button
        type="button"
        data-testid="onboarding-step-fallback-continue"
        onClick={onContinue}
        className="mt-[20px] inline-flex min-h-[40px] w-full items-center justify-center rounded-[8px] border border-accent bg-accent px-[12px] text-[14px] font-medium text-white transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_86%,black)] client-material-control"
      >
        {t("onboarding.stepFallback.continue")}
      </button>
    </section>
  )
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
  onAdminCancelLogin,
  onAdminSendPhoneCode,
  onAdminVerifyPhoneCode,
  onAdminRelogin,
  onQuitApp,
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
            onCancel={onAdminCancelLogin}
            onQuitApp={onQuitApp}
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

      // Legacy steps (provider-select/local-model/credentials) are still set
      // by the useOnboarding state machine but no longer render their own UI.
      // Never fall through to null — show the neutral fallback so the user
      // can always continue (see WizardStepFallback above).
      default:
        return <WizardStepFallback onContinue={onAdminRelogin ?? onContinue} />
    }
  }

  const workbenchStyle = useClientWorkbenchStyle()
  useClientMaterialScope()
  const isLogin = state.step === 'admin-login'

  return (
    <div
      data-testid="onboarding-wizard"
      style={isLogin ? workbenchStyle : undefined}
      className={cn(
        // POO-105：登录根是材质作用域的画布板（93% 底板）；空间准备等其他
        // 步骤保持实色 foreground-2，不在浅色材质合同范围内。
        isLogin ? "bg-background overflow-y-auto client-material-canvas " + clientWorkbenchFocusClassName : "bg-foreground-2 overflow-y-auto",
        !className?.includes('h-full') && "h-dvh",
        className
      )}
    >
      {/* Draggable title bar region for transparent window (macOS) */}
      <div className="titlebar-drag-region fixed top-0 left-0 right-0 h-[50px] z-titlebar" />

      {/* Main content — min-h-full + flex center means: center when content fits,
          natural flow + scroll when content is taller than the viewport (mobile). */}
      <main className={cn("flex min-h-full items-center justify-center", isLogin ? "px-[24px] pb-[32px] pt-[48px] [@media(max-width:760px)]:px-[16px] [@media(max-width:760px)]:py-[20px]" : "p-4 sm:p-8")}>
        {renderStep()}
      </main>
    </div>
  )
}
