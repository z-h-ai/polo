export function normalizeMainlandPhoneInput(value: string): string {
  const digits = value.replace(/\D/g, "")
  return (digits.length > 11 && digits.startsWith("86") ? digits.slice(2) : digits).slice(0, 11)
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
  resendSeconds: number
}

export type PhoneAuthFormAction =
  | { type: 'phoneChanged'; value: string }
  | { type: 'codeChanged'; value: string }
  | { type: 'consentChanged'; value: boolean }
  | { type: 'codeSent'; resendAfter: number }
  | { type: 'countdownTicked' }
  | { type: 'phoneEditRequested' }

export const INITIAL_PHONE_AUTH_FORM_STATE: PhoneAuthFormState = {
  mode: 'entry',
  phone: '',
  code: '',
  consented: false,
  resendSeconds: 0,
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
        resendSeconds: Math.max(0, Math.ceil(action.resendAfter)),
      }
    case 'countdownTicked':
      return {
        ...state,
        resendSeconds: Math.max(0, state.resendSeconds - 1),
      }
    case 'phoneEditRequested':
      return {
        ...state,
        mode: 'entry',
        code: '',
        resendSeconds: 0,
      }
  }
}

export function canSendPhoneAuthCode(state: PhoneAuthFormState): boolean {
  return state.consented && /^1\d{10}$/.test(state.phone)
}

export function canVerifyPhoneAuthCode(state: PhoneAuthFormState): boolean {
  return state.mode === 'verify' && state.code.length === 6
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
