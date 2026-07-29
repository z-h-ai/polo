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

export function createPhoneAuthChallengeToken(): string {
  return globalThis.crypto.randomUUID()
}
