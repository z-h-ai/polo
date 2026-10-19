/**
 * polo-relay entrypoint: `bun run packages/relay/src/index.ts`.
 *
 * Env: POLO_RELAY_PORT, POLO_RELAY_JWT_SECRET (shared with polo-admin
 * JWT_SECRET), POLO_ADMIN_BASE_URL, … — see src/config.ts and the repo-root
 * .env.example.
 *
 * /asr (POL-245): streaming ASR proxy on the same port. Supplier selection via
 * POLO_RELAY_ASR_DEFAULT_SUPPLIER (volcengine | mock — use `mock` for local
 * dev), rate-card overrides via POLO_RELAY_ASR_RATE_CARDS_JSON. Upstream
 * volcano credentials come only from VOLCENGINE_ASR_APPID /
 * VOLCENGINE_ASR_ACCESS_TOKEN / VOLCENGINE_ASR_RESOURCE_ID at deploy time
 * (secrets never enter the repo or docs; unconfigured volcano → handshake
 * close 4405 supplier_unavailable — loud failure, no silent fallback).
 */

import { loadRelayConfig } from './config.ts'
import { startRelayServer } from './server.ts'

if (import.meta.main) {
  let handle
  try {
    handle = startRelayServer({ config: loadRelayConfig(process.env) })
  } catch (error) {
    console.error(`[relay] failed to start: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  console.log(`[relay] listening on ws://0.0.0.0:${handle.port} (admin=${process.env['POLO_ADMIN_BASE_URL'] ?? 'http://127.0.0.1:3000'})`)

  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[relay] ${signal} received, closing server (queued envelopes are dropped — memory only)`)
    handle.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}
