// Reconnect/backoff primitives for the mobile conn layer (POL-17 card step 4).
//
// Pure functions and classes only — every behavior here is unit tested in
// src/conn/__tests__/reconnect.test.ts and reused by lanChannel/relayChannel/
// ConnectionManager. Wire semantics verified against:
//   - packages/server-core/src/transport/client.ts (close 4005 = auth, 4004 =
//     protocol version, 4001 = handshake timeout; backoff 1s * 2^n capped,
//     reset after a stable connection — scheduleBackoffReset precedent)
//   - packages/relay/src/server.ts (close 4401 unauthorized / 4403 forbidden
//     = auth; 4009 replaced / 4008 rate limited / 4000 heartbeat = retryable)
//   - apps/electron/src/main/relay-client/client.ts (±20% jitter precedent)

export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 30_000;

/**
 * Exponential backoff with cap and ±20% jitter: base * 2^attempt, capped at
 * maxMs. attempt is 0-based (the first retry uses `base`). `random` is
 * injectable so tests can pin the jitter (pass () => 1 for the exact sequence).
 */
export function computeBackoffDelayMs(
  attempt: number,
  options: { baseMs?: number; maxMs?: number; random?: () => number } = {},
): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const rng = options.random ?? Math.random;
  const capped = Math.min(base * Math.pow(2, Math.max(0, attempt)), max);
  const jitter = 0.8 + rng() * 0.4;
  // Cap AFTER jitter: the delay never exceeds maxMs (card: 上限封顶).
  return Math.round(Math.min(capped * jitter, max));
}

// ---------------------------------------------------------------------------
// Failure classification — auth failures never retry (card: 认证类关闭码不重试)
// ---------------------------------------------------------------------------

/** A close/error classification with only the two outcomes the manager needs. */
export type CloseClassification = 'auth' | 'retryable';

/**
 * Auth close codes:
 *   - 4005: server-core WsRpcServer auth failure (server.ts close 'Auth failed')
 *   - 4401 / 4403: polo-relay unauthorized / forbidden (packages/relay CLOSE_CODE)
 */
export const AUTH_CLOSE_CODES: ReadonlySet<number> = new Set([4005, 4401, 4403]);

/**
 * Decides whether a channel failure may be retried. `errorKind` mirrors
 * TransportConnectionErrorKind ('auth' comes from close 4005 or the
 * AUTH_FAILED error envelope on the LAN path).
 */
export function classifyClose(
  closeCode: number | undefined,
  errorKind?: string,
): CloseClassification {
  if (typeof closeCode === 'number' && AUTH_CLOSE_CODES.has(closeCode)) return 'auth';
  if (errorKind === 'auth') return 'auth';
  return 'retryable';
}

// ---------------------------------------------------------------------------
// Replay event sequencing — 按序转交 + 去重 (card step 4)
// ---------------------------------------------------------------------------

const DEFAULT_SEEN_ID_CAP = 256;

/**
 * Gates event frames for delivery so replayed streams arrive 按序、不丢、不重:
 *   - events carrying `seq` are delivered only when seq increases past the
 *     highest seq seen (server replay frames and live frames interleave —
 *     duplicates and late replay frames are dropped by the seq guard);
 *   - seq-less events are deduped by envelope id over a bounded window.
 * Reset when a fresh (non-replayed) session is acknowledged.
 */
export class EventSequencer {
  private lastSeq = 0;
  private readonly seenIds = new Set<string>();
  private readonly seenIdOrder: string[] = [];
  private readonly seenIdCap: number;

  constructor(seenIdCap: number = DEFAULT_SEEN_ID_CAP) {
    this.seenIdCap = seenIdCap > 0 ? seenIdCap : DEFAULT_SEEN_ID_CAP;
  }

  shouldDeliver(event: { seq?: number; id?: string }): boolean {
    const seq = event.seq;
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      if (seq <= this.lastSeq) return false; // duplicate / late replay frame
      this.lastSeq = seq;
      if (event.id !== undefined) this.remember(event.id);
      return true;
    }
    if (event.id !== undefined) {
      if (this.seenIds.has(event.id)) return false;
      this.remember(event.id);
    }
    return true;
  }

  /** Highest seq accepted so far (reconnect handshake `lastSeq` source). */
  get lastSeenSeq(): number {
    return this.lastSeq;
  }

  /** Fresh session — the server restarts per-client seq from scratch. */
  reset(): void {
    this.lastSeq = 0;
    this.seenIds.clear();
    this.seenIdOrder.length = 0;
  }

  private remember(id: string): void {
    if (this.seenIds.has(id)) return;
    this.seenIds.add(id);
    this.seenIdOrder.push(id);
    while (this.seenIdOrder.length > this.seenIdCap) {
      const evicted = this.seenIdOrder.shift();
      if (evicted !== undefined) this.seenIds.delete(evicted);
    }
  }
}
