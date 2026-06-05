/**
 * Shared types for the Admin API client.
 *
 * Contract: spec-polo-ai.md §6.1 / shared-contract.md §2
 */

// ─── checkQuota ───────────────────────────────────────────────────────────────

/** Optional payload sent with POST /api/quota/check */
export interface QuotaCheckInput {
  /** Estimated token count for the upcoming request (optional hint) */
  estimatedTokens?: number;
}

/** Result returned by POST /api/quota/check */
export interface QuotaCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  used: number;
  period: string;
}

// ─── reportUsage ─────────────────────────────────────────────────────────────

/** Payload sent with POST /api/quota/usage */
export interface UsageReportInput {
  requestId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Result returned by POST /api/quota/usage */
export interface UsageReportResult {
  recorded: boolean;
  totalUsed: number;
  remaining: number;
}

// ─── getQuotaStatus ──────────────────────────────────────────────────────────

/** A single row in the usage breakdown by model */
export interface UsageBreakdownEntry {
  model: string;
  tokens: number;
}

/** Result returned by GET /api/quota/status */
export interface QuotaStatus {
  userId: string;
  period: string;
  limit: number;
  used: number;
  remaining: number;
  usageBreakdown: UsageBreakdownEntry[];
}
