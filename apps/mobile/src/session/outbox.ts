// Outbox (POL-18 card step 2) — local staging for messages sent while the Mac
// is offline (PRD §⑥ R3, relay 5-minute queue mirror on the phone).
//
// Semantics:
//   - stage(key, text): message enters the queue with queuedAt + a local
//     expireAtMs (queuedAt + TTL, default 5 minutes) — the phone-side 兜底
//     计时 that fires EVEN IF the relay never sends a failure receipt;
//   - the earliest-expiry timer sweeps due entries into onExpire (the store
//     marks them 发送失败·可重发) — no reliance on relay liveness;
//   - restage(key, text): 重发复用原消息体并重新计时 (card) — the resend path
//     re-arms the same body with a fresh 5-minute window;
//   - cap (default 50): staging beyond the cap evicts the OLDEST entry via
//     onEvicted (store marks it failed with the overflow note);
//   - remove(key): delivery succeeded — sweep the entry.
//
// Pure staging: actually sending staged messages on reconnect is the session
// controller's job (sessionRpc.ts); the outbox never touches the connection.

import type { ConnTimers } from '../conn/ConnectionManager';
import { OUTBOX_CAP } from './eventCard';

/** PRD §⑥: Mac 离线进 relay 5 分钟内存队列 — the phone mirrors the window. */
export const OUTBOX_TTL_MS = 5 * 60 * 1000;

export interface OutboxEntry {
  /** Local user entry id (the optimistic id sent with sendMessage.options). */
  key: string;
  text: string;
  queuedAtMs: number;
  expireAtMs: number;
}

export interface OutboxOptions {
  now?: () => number;
  timers?: ConnTimers;
  ttlMs?: number;
  cap?: number;
  /** Local TTL burnt out — mark 发送失败·可重发 (PRD: 超时回执失败). */
  onExpire: (entry: OutboxEntry) => void;
  /** Cap eviction (最旧淘汰) — the entry never reached a wire queue. */
  onEvicted: (entry: OutboxEntry) => void;
}

export function defaultOutboxTimers(): ConnTimers {
  return {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export class Outbox {
  private readonly now: () => number;
  private readonly timers: ConnTimers;
  private readonly ttlMs: number;
  private readonly cap: number;
  private readonly onExpire: (entry: OutboxEntry) => void;
  private readonly onEvicted: (entry: OutboxEntry) => void;
  private readonly ordered: OutboxEntry[] = [];
  private sweepTimer: unknown = null;
  private disposed = false;

  constructor(options: OutboxOptions) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultOutboxTimers();
    this.ttlMs = options.ttlMs ?? OUTBOX_TTL_MS;
    this.cap = options.cap ?? OUTBOX_CAP;
    this.onExpire = options.onExpire;
    this.onEvicted = options.onEvicted;
  }

  /** Stages a message; returns the entry plus any cap-evicted oldest entry. */
  stage(key: string, text: string): { entry: OutboxEntry; evicted: OutboxEntry | null } {
    const queuedAtMs = this.now();
    const entry: OutboxEntry = { key, text, queuedAtMs, expireAtMs: queuedAtMs + this.ttlMs };
    this.ordered.push(entry);
    let evicted: OutboxEntry | null = null;
    while (this.ordered.length > this.cap) {
      const oldest = this.ordered.shift();
      if (!oldest) break;
      evicted = oldest;
      this.onEvicted(oldest);
    }
    this.rearm();
    return { entry, evicted };
  }

  /** Resend path — same body, fresh timer window (card: 重新计时). */
  restage(key: string): OutboxEntry | null {
    const index = this.ordered.findIndex((entry) => entry.key === key);
    const current = index >= 0 ? this.ordered[index] : undefined;
    if (!current) return null;
    const queuedAtMs = this.now();
    const entry: OutboxEntry = { ...current, queuedAtMs, expireAtMs: queuedAtMs + this.ttlMs };
    this.ordered.splice(index, 1);
    this.ordered.push(entry);
    this.rearm();
    return entry;
  }

  remove(key: string): OutboxEntry | null {
    const index = this.ordered.findIndex((entry) => entry.key === key);
    if (index < 0) return null;
    const removed = this.ordered.splice(index, 1)[0];
    if (!removed) return null;
    this.rearm();
    return removed;
  }

  get(key: string): OutboxEntry | null {
    return this.ordered.find((entry) => entry.key === key) ?? null;
  }

  all(): OutboxEntry[] {
    return [...this.ordered];
  }

  size(): number {
    return this.ordered.length;
  }

  remainingMs(key: string, atMs: number = this.now()): number {
    const entry = this.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.expireAtMs - atMs);
  }

  /** Expires due entries immediately (also drives the internal sweep). */
  sweep(atMs: number = this.now()): OutboxEntry[] {
    const due = this.ordered.filter((entry) => entry.expireAtMs <= atMs);
    if (due.length === 0) return [];
    for (const entry of due) {
      const index = this.ordered.findIndex((candidate) => candidate.key === entry.key);
      if (index >= 0) this.ordered.splice(index, 1);
    }
    for (const entry of due) this.onExpire(entry);
    this.rearm();
    return due;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.ordered.length = 0;
  }

  private clearTimer(): void {
    if (this.sweepTimer !== null) {
      this.timers.clear(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** One timer for the nearest expiry — no per-entry timers. */
  private rearm(): void {
    if (this.disposed) return;
    this.clearTimer();
    if (this.ordered.length === 0) return;
    const nextMs = Math.min(...this.ordered.map((entry) => entry.expireAtMs));
    const delay = Math.max(0, nextMs - this.now());
    this.sweepTimer = this.timers.set(() => {
      this.sweepTimer = null;
      this.sweep();
    }, delay);
  }
}
