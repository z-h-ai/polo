/**
 * Cross-package reservation contract (POL-280 P2).
 *
 * The local gateway's per-query admission reservation (QUERY_TEXT_RESERVATION_BYTES) must stay
 * >= the worker's wire text cap (TEXT_LIMIT in pi-agent-server) so admission always reserves at
 * least the bytes a completed result may retain — the invariant "reservation >= final retained
 * bytes". The two packages must not depend on each other, so the invariant is pinned here where
 * both source trees are importable (relative source imports, mirroring the shared wire test).
 */
import { describe, expect, it } from 'bun:test'
import {
  GLOBAL_QUERY_SLOTS, GLOBAL_TEXT_BUDGET_BYTES,
  PER_CAPABILITY_QUERY_SLOTS, PER_CAPABILITY_TEXT_BUDGET_BYTES,
  QUERY_TEXT_RESERVATION_BYTES,
} from '../app-api-run-state'
import { TEXT_LIMIT } from '../../../../../../packages/pi-agent-server/src/host-completion-protocol.ts'

describe('query text reservation contract', () => {
  it('QUERY_TEXT_RESERVATION_BYTES >= worker TEXT_LIMIT (reservation >= final retained bytes)', () => {
    expect(QUERY_TEXT_RESERVATION_BYTES).toBeGreaterThanOrEqual(TEXT_LIMIT)
  })

  it('admission byte budgets stay exactly slots x reservation (slots remain the binding cap)', () => {
    expect(PER_CAPABILITY_TEXT_BUDGET_BYTES).toBe(PER_CAPABILITY_QUERY_SLOTS * QUERY_TEXT_RESERVATION_BYTES)
    expect(GLOBAL_TEXT_BUDGET_BYTES).toBe(GLOBAL_QUERY_SLOTS * QUERY_TEXT_RESERVATION_BYTES)
  })
})
