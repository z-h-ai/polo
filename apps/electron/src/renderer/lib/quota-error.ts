// Error-shape helpers shared by the chat send path. Moved out of App.tsx so
// the gateway/admin blocked-balance contract is unit-testable.
//
// Classification contract (journey review #1): a blocked send is either
// INSUFFICIENT CREDIT (payer must recharge — shared code table + HTTP 402) or
// a PERIOD QUOTA limit (HTTP 429). Both are recognized ONLY from trusted
// structured fields (errorCode/code/status) — message-text regex guessing is
// deliberately gone: an unknown error class must never be talked into a
// billing category. The period-reset copy is likewise conditional: it renders
// only when the server itself provided a reset fact.
// Direct-module import (NOT the '@polo-ai/shared/credentials' barrel): the
// barrel re-exports the koffi-based native write-lock backends, and a
// renderer import would drag that native binary into the vite bundle
// (rollup parse error on koffi.node — v0.21.6 first-build failure).
import { isInsufficientCreditCode } from '@polo-ai/shared/credentials/insufficient-credit-codes'

export function readErrorField(error: unknown, field: 'errorCode' | 'code' | 'status' | 'message'): unknown {
  if (!error || typeof error !== 'object') return undefined
  return (error as Record<string, unknown>)[field]
}

function readResetField(error: unknown, field: 'quotaResetAt' | 'resetAt' | 'rateLimitResetAt'): unknown {
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

/** Structured error code as sent (case preserved — the shared table mixes
 * snake_case and SCREAMING_CASE spellings on purpose). */
export function readErrorCode(error: unknown): string {
  const raw = readErrorField(error, 'errorCode') ?? readErrorField(error, 'code')
  return typeof raw === 'string' ? raw : ''
}

/** The shared table pins exact spellings; real transports vary in case. Match
 * the code verbatim first, then against the table's canonical casing forms —
 * still code-only, never message guessing. */
function codeMatchesInsufficientCreditTable(code: string): boolean {
  if (!code) return false
  return isInsufficientCreditCode(code)
    || isInsufficientCreditCode(code.toLowerCase())
    || isInsufficientCreditCode(code.toUpperCase())
}

/** Payer lacks allowance: the shared classification list (admin runtime +
 * legacy gateway dialects) or the HTTP 402 admission status. */
export function isInsufficientCreditError(error: unknown): boolean {
  return codeMatchesInsufficientCreditTable(readErrorCode(error))
    || Number(readErrorField(error, 'status')) === 402
}

/** Period quota exhaustion: an explicit 429 from a trusted admission surface.
 * WITHOUT a server-provided reset fact this must stay promise-free copy. */
export function isPeriodQuotaError(error: unknown): boolean {
  return Number(readErrorField(error, 'status')) === 429
}

/** Server-provided period-reset fact (epoch ms), when it explicitly supplied
 * one. Only its presence may unlock "resets at …" copy; anything absent stays
 * absent — the UI never fabricates a reset promise. */
export function readQuotaResetAt(error: unknown): number | undefined {
  for (const field of ['quotaResetAt', 'resetAt', 'rateLimitResetAt'] as const) {
    const value = readResetField(error, field)
    const parsed = Number(value)
    if (value !== undefined && value !== null && value !== '' && Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return undefined
}

/** Blocking-send gate kept for the existing call sites: TRUE for either
 * billing class (the latch distinguishes them; the send gate only blocks). */
export function isQuotaExhaustedError(error: unknown): boolean {
  return isInsufficientCreditError(error) || isPeriodQuotaError(error)
}
