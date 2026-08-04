import { isValidMainlandChinaPhone } from '@z-h-ai/shared/admin/schemas'

export function normalizeMainlandPhoneInput(value: string): string {
  const compact = value.replace(/[\s-]/g, "")
  if (compact.startsWith("+86")) return compact.slice(3)
  return compact.length > 11 && compact.startsWith("86")
    ? compact.slice(2)
    : compact
}

export function normalizeVerificationCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6)
}

export function maskMainlandPhone(phone: string): string {
  return phone.length === 11
    ? `+86 ${phone.slice(0, 3)} •••• ${phone.slice(-4)}`
    : `+86 ${phone}`
}

export function resolvePreferredAdminLoginMode(
  phoneAuthEnabled: boolean | undefined,
): 'phone' | 'password' {
  return phoneAuthEnabled === true ? 'phone' : 'password'
}

export interface PhoneAuthFormState {
  mode: 'entry' | 'verify'
  phone: string
  code: string
  consented: boolean
}

export type PhoneAuthFormAction =
  | { type: 'phoneChanged'; value: string }
  | { type: 'codeChanged'; value: string }
  | { type: 'consentChanged'; value: boolean }
  | { type: 'codeSent' }
  | { type: 'phoneEditRequested' }

export const INITIAL_PHONE_AUTH_FORM_STATE: PhoneAuthFormState = {
  mode: 'entry',
  phone: '',
  code: '',
  consented: false,
}

export function reducePhoneAuthForm(
  state: PhoneAuthFormState,
  action: PhoneAuthFormAction,
): PhoneAuthFormState {
  switch (action.type) {
    case 'phoneChanged':
      return {
        ...state,
        phone: normalizeMainlandPhoneInput(action.value),
      }
    case 'codeChanged':
      return {
        ...state,
        code: normalizeVerificationCode(action.value),
      }
    case 'consentChanged':
      return {
        ...state,
        consented: action.value,
      }
    case 'codeSent':
      return {
        ...state,
        mode: 'verify',
        code: '',
      }
    case 'phoneEditRequested':
      return {
        ...state,
        mode: 'entry',
        code: '',
      }
  }
}

export function canSendPhoneAuthCode(state: PhoneAuthFormState): boolean {
  return state.consented && isValidMainlandChinaPhone(state.phone)
}

export function canVerifyPhoneAuthCode(state: PhoneAuthFormState): boolean {
  return state.mode === 'verify' && state.code.length === 6
}

export function createPhoneAuthResendDeadline(
  resendAfter: number,
  now = Date.now(),
): number {
  return now + Math.max(0, Math.ceil(resendAfter)) * 1_000
}

export function getRemainingPhoneAuthResendSeconds(
  deadline: number | undefined,
  now = Date.now(),
): number {
  if (deadline === undefined || !Number.isFinite(deadline)) return 0
  return Math.max(0, Math.ceil((deadline - now) / 1_000))
}

export interface ExclusiveRunner {
  run<T>(task: () => Promise<T>): Promise<T | undefined>
}

export function createExclusiveRunner(): ExclusiveRunner {
  let inFlight = false
  return {
    async run<T>(task: () => Promise<T>): Promise<T | undefined> {
      if (inFlight) return undefined
      inFlight = true
      try {
        return await task()
      } finally {
        inFlight = false
      }
    },
  }
}
