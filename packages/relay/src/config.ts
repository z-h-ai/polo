/**
 * polo-relay configuration (PRD v1.6 §⑥, POL-11).
 *
 * All knobs come from environment variables; defaults follow the §⑥ 定稿值
 * (5min offline queue / 60s auth cache / 30s heartbeat). Time-based values are
 * injectable in tests by constructing RelayConfig directly.
 */

export interface RelayConfig {
  /** Listen port. Env: POLO_RELAY_PORT. */
  port: number
  /** Shared HS256 secret (same as polo-admin JWT_SECRET, >= 32 chars). Env: POLO_RELAY_JWT_SECRET. */
  jwtSecret: string
  /** Base URL of polo-admin. Env: POLO_ADMIN_BASE_URL (legacy alias: POLO_RELAY_ADMIN_URL). */
  adminBaseUrl: string
  /** Expected JWT iss. Env: POLO_RELAY_JWT_ISSUER. */
  jwtIssuer: string
  /** Expected JWT aud. Env: POLO_RELAY_JWT_AUDIENCE. */
  jwtAudience: string
  /** Per-connection message rate limit (msg/s). Env: POLO_RELAY_MAX_MSG_PER_SEC. */
  maxMsgPerSec: number
  /** Offline queue TTL per envelope, ms. Env: POLO_RELAY_OFFLINE_QUEUE_TTL_MS. */
  offlineQueueTtlMs: number
  /** Max queued envelopes per macDeviceId. Env: POLO_RELAY_OFFLINE_QUEUE_MAX_PER_MAC. */
  offlineQueueMaxPerMac: number
  /** TTL for introspection & check-access caches, ms. Env: POLO_RELAY_AUTH_CACHE_TTL_MS. */
  authCacheTtlMs: number
  /** Server heartbeat ping interval, ms (0 disables — tests). Env: POLO_RELAY_HEARTBEAT_INTERVAL_MS. */
  heartbeatIntervalMs: number
  /** Kill a connection with no liveness evidence for this long, ms. Env: POLO_RELAY_HEARTBEAT_TIMEOUT_MS. */
  heartbeatTimeoutMs: number
  /** Max WS payload bytes accepted. Env: POLO_RELAY_MAX_PAYLOAD_BYTES. */
  maxPayloadBytes: number
}

function intFromEnv(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[relay] env ${key} must be a positive integer, got: ${raw}`)
  }
  return parsed
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]
  if (value === undefined || value.trim() === '') {
    throw new Error(`[relay] env ${key} is required (shared with polo-admin JWT_SECRET)`)
  }
  return value.trim()
}

export function loadRelayConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  const jwtSecret = required(env, 'POLO_RELAY_JWT_SECRET')
  if (jwtSecret.length < 32) {
    // Matches polo-admin: JWT_SECRET must be at least 32 characters.
    throw new Error('[relay] POLO_RELAY_JWT_SECRET must contain at least 32 characters')
  }
  const adminBaseUrl = (env['POLO_ADMIN_BASE_URL'] ?? env['POLO_RELAY_ADMIN_URL'] ?? 'http://127.0.0.1:3000').trim()
  return {
    port: intFromEnv(env, 'POLO_RELAY_PORT', 8787),
    jwtSecret,
    adminBaseUrl: adminBaseUrl.replace(/\/+$/, ''),
    jwtIssuer: env['POLO_RELAY_JWT_ISSUER']?.trim() || 'polo-admin',
    jwtAudience: env['POLO_RELAY_JWT_AUDIENCE']?.trim() || 'polo-client',
    maxMsgPerSec: intFromEnv(env, 'POLO_RELAY_MAX_MSG_PER_SEC', 20),
    offlineQueueTtlMs: intFromEnv(env, 'POLO_RELAY_OFFLINE_QUEUE_TTL_MS', 300_000),
    offlineQueueMaxPerMac: intFromEnv(env, 'POLO_RELAY_OFFLINE_QUEUE_MAX_PER_MAC', 200),
    authCacheTtlMs: intFromEnv(env, 'POLO_RELAY_AUTH_CACHE_TTL_MS', 60_000),
    heartbeatIntervalMs: env['POLO_RELAY_HEARTBEAT_INTERVAL_MS'] !== undefined
      ? intFromEnv(env, 'POLO_RELAY_HEARTBEAT_INTERVAL_MS', 30_000)
      : 30_000,
    heartbeatTimeoutMs: intFromEnv(env, 'POLO_RELAY_HEARTBEAT_TIMEOUT_MS', 60_000),
    maxPayloadBytes: intFromEnv(env, 'POLO_RELAY_MAX_PAYLOAD_BYTES', 1_048_576),
  }
}
