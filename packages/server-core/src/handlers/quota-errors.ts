/**
 * quota-errors.ts
 *
 * Custom error classes for sendMessage quota enforcement.
 *
 * These errors use the new ErrorCode variants added to @polo-ai/shared/protocol/types:
 *   - QUOTA_EXCEEDED    → user has exceeded their monthly token quota
 *   - SERVICE_UNAVAILABLE → Admin API is unreachable or timed out (fail-closed)
 */

import type { QuotaCheckResult } from '@polo-ai/shared/admin-api'

// ---------------------------------------------------------------------------
// QuotaExceededError
// ---------------------------------------------------------------------------

/**
 * Thrown when the user's quota is exhausted (either Admin API says allowed=false
 * or effectiveRemaining <= 0 after subtracting pending usage).
 *
 * Carries the quota details from the Admin API response so the client can show
 * a meaningful error message with limits and reset information.
 */
export class QuotaExceededError extends Error {
  readonly code = 'QUOTA_EXCEEDED' as const
  readonly remaining: number
  readonly limit: number
  readonly used: number
  readonly period: string

  constructor(quota: Pick<QuotaCheckResult, 'remaining' | 'limit' | 'used' | 'period'>) {
    super(
      `Monthly token quota exceeded. You have used ${quota.used.toLocaleString()} of ` +
      `${quota.limit.toLocaleString()} tokens this period (${quota.period}). ` +
      `Quota resets at the start of the next monthly period.`
    )
    this.name = 'QuotaExceededError'
    this.remaining = quota.remaining
    this.limit = quota.limit
    this.used = quota.used
    this.period = quota.period
  }
}

// ---------------------------------------------------------------------------
// ServiceUnavailableError
// ---------------------------------------------------------------------------

/**
 * Thrown when the Admin API is unreachable or times out.
 *
 * Polo AI uses a fail-closed strategy: if quota cannot be verified, the request
 * is rejected rather than allowed through (to prevent runaway spend).
 */
export class ServiceUnavailableError extends Error {
  readonly code = 'SERVICE_UNAVAILABLE' as const

  constructor(message = 'Quota service is temporarily unavailable. Please try again in a moment.') {
    super(message)
    this.name = 'ServiceUnavailableError'
  }
}

// ---------------------------------------------------------------------------
// QuotaContext
// ---------------------------------------------------------------------------

/**
 * Quota context object created per sendMessage turn.
 * Stored alongside the session turn for downstream usage reporting.
 *
 * NOT stored on RequestContext (which is connection-scoped, not turn-scoped).
 */
export interface QuotaContext {
  /** Unique identifier for this specific request turn (crypto.randomUUID). */
  requestId: string
  /** Authenticated user ID (null for server-token / admin paths). */
  userId: string | null
  /** User's JWT token for Admin API calls. */
  userJwt: string | null
  /** Session ID this turn belongs to. */
  sessionId: string
}
