// Error-shape helpers shared by the chat send path. Moved out of App.tsx so
// the gateway/admin blocked-balance contract is unit-testable.
export function readErrorField(error: unknown, field: 'errorCode' | 'code' | 'status' | 'message'): unknown {
  if (!error || typeof error !== 'object') return undefined
  return (error as Record<string, unknown>)[field]
}

export function getErrorText(error: unknown): string {
  if (error instanceof Error) return error.message
  const message = readErrorField(error, 'message')
  if (typeof message === 'string') return message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

// The Admin/gateway admission surface returns several spellings of a blocked
// balance. BUDGET_EXHAUSTED (gateway dialect) previously fell through to the
// message-regex fallback only; match it explicitly.
export function isQuotaExhaustedError(error: unknown): boolean {
  const code = String(readErrorField(error, 'errorCode') ?? readErrorField(error, 'code') ?? '').toUpperCase()
  const status = Number(readErrorField(error, 'status'))
  const message = getErrorText(error)

  return code === 'QUOTA_EXHAUSTED'
    || code === 'BUDGET_EXHAUSTED'
    || code === 'QUOTA_LIMIT_EXCEEDED'
    || code === 'USAGE_LIMIT_EXCEEDED'
    || code === 'INSUFFICIENT_QUOTA'
    || status === 429
    || /quota|额度|limit exceeded|exhausted|insufficient_quota|monthly usage|本月额度已用完/i.test(message)
}
