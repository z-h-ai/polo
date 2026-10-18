// POL-18 unit tests for the local staging outbox (bun test; fake clock, no
// real timers, no connection).
//
// Card 自检 matrix covered here:
//   - Mac 离线入暂存：queuedAt + 本地 5 分钟兜底倒计时
//   - 本地超时置失败（不依赖 relay 回执，onExpire 驱动）
//   - 重发复用原消息体并重新计时（restage 重置 queuedAt/expireAt）
//   - 暂存条数上限与最旧淘汰策略（cap → onEvicted FIFO）
//   - relay 失败回执路径由 controller 测试覆盖（sessionStore.test.ts）

import { describe, expect, test } from 'bun:test';

import { Outbox, OUTBOX_TTL_MS } from '../outbox';
import type { OutboxEntry } from '../outbox';

// ---------------------------------------------------------------------------
// Fake clock — same deterministic-timer pattern as the conn layer tests
// ---------------------------------------------------------------------------

interface FakeClock {
  now: () => number;
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  advance: (ms: number) => void;
  pendingCount: () => number;
}

function makeFakeClock(start = 1_000_000): FakeClock {
  let current = start;
  let seq = 0;
  const scheduled = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => current,
    timers: {
      set(fn, ms) {
        const id = ++seq;
        scheduled.set(id, { at: current + ms, fn });
        return id;
      },
      clear(handle) {
        scheduled.delete(handle as number);
      },
    },
    advance(ms) {
      const deadline = current + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of scheduled) {
          if (timer.at <= deadline && timer.at < nextAt) {
            nextAt = timer.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        current = nextAt;
        const timer = scheduled.get(nextId);
        scheduled.delete(nextId);
        timer?.fn();
      }
      current = deadline;
    },
    pendingCount: () => scheduled.size,
  };
}

interface Harness {
  clock: FakeClock;
  expired: OutboxEntry[];
  evicted: OutboxEntry[];
  make: (options?: { ttlMs?: number; cap?: number }) => Outbox;
}

function makeHarness(): Harness {
  const clock = makeFakeClock();
  const expired: OutboxEntry[] = [];
  const evicted: OutboxEntry[] = [];
  return {
    clock,
    expired,
    evicted,
    make(options) {
      return new Outbox({
        now: clock.now,
        timers: clock.timers,
        ttlMs: options?.ttlMs,
        cap: options?.cap,
        onExpire: (entry) => expired.push(entry),
        onEvicted: (entry) => evicted.push(entry),
      });
    },
  };
}

// ---------------------------------------------------------------------------

describe('Outbox staging basics', () => {
  test('stage carries the body and a local 5-minute window', () => {
    const h = makeHarness();
    const outbox = h.make();
    const { entry, evicted } = outbox.stage('m1', '跑一次部署');
    expect(evicted).toBeNull();
    expect(entry.key).toBe('m1');
    expect(entry.text).toBe('跑一次部署');
    expect(entry.queuedAtMs).toBe(h.clock.now());
    expect(entry.expireAtMs).toBe(h.clock.now() + OUTBOX_TTL_MS);
    expect(outbox.size()).toBe(1);
    expect(outbox.remainingMs('m1')).toBe(OUTBOX_TTL_MS);
  });

  test('remove drops the entry (delivery succeeded)', () => {
    const h = makeHarness();
    const outbox = h.make();
    outbox.stage('m1', 'a');
    expect(outbox.remove('m1')?.key).toBe('m1');
    expect(outbox.size()).toBe(0);
    expect(outbox.remove('m1')).toBeNull();
  });

  test('drain order mirrors queuedAt (oldest first)', () => {
    const h = makeHarness();
    const outbox = h.make();
    outbox.stage('m1', 'first');
    h.clock.advance(1000);
    outbox.stage('m2', 'second');
    expect(outbox.all().map((entry) => entry.key)).toEqual(['m1', 'm2']);
  });
});

describe('Outbox local TTL expiry (本地 5 分钟兜底)', () => {
  test('sweep fires onExpire at expireAtMs without any relay receipt', () => {
    const h = makeHarness();
    const outbox = h.make();
    outbox.stage('m1', 'a');
    h.clock.advance(OUTBOX_TTL_MS - 1);
    expect(outbox.sweep()).toHaveLength(0);
    expect(h.expired).toHaveLength(0);
    h.clock.advance(1);
    outbox.sweep();
    expect(h.expired.map((entry) => entry.key)).toEqual(['m1']);
    expect(outbox.size()).toBe(0);
  });

  test('internal timer expires without an external sweep call', () => {
    const h = makeHarness();
    const outbox = h.make();
    outbox.stage('m1', 'a');
    expect(h.clock.pendingCount()).toBe(1);
    h.clock.advance(OUTBOX_TTL_MS + 5_000);
    expect(h.expired.map((entry) => entry.key)).toEqual(['m1']);
    expect(h.clock.pendingCount()).toBe(0);
  });

  test('expiry is per-entry: later entries keep counting after the first fires', () => {
    const h = makeHarness();
    const outbox = h.make();
    outbox.stage('m1', 'a');
    h.clock.advance(60_000);
    outbox.stage('m2', 'b');
    // m1 is due at TTL, m2 at 60s+TTL — sweep one minute before m2's window ends.
    h.clock.advance(OUTBOX_TTL_MS - 1);
    expect(h.expired.map((entry) => entry.key)).toEqual(['m1']);
    expect(outbox.get('m2')).not.toBeNull();
    h.clock.advance(1);
    expect(h.expired.map((entry) => entry.key)).toEqual(['m1', 'm2']);
  });

  test('remove cancels the pending expiry', () => {
    const h = makeHarness();
    const outbox = h.make();
    outbox.stage('m1', 'a');
    outbox.remove('m1');
    h.clock.advance(OUTBOX_TTL_MS * 2);
    expect(h.expired).toHaveLength(0);
  });
});

describe('Outbox resend re-timing (重发复用并重新计时)', () => {
  test('restage keeps the body and restarts the window', () => {
    const h = makeHarness();
    const outbox = h.make();
    outbox.stage('m1', '重发我');
    h.clock.advance(4 * 60_000); // 1 minute left
    const restaged = outbox.restage('m1');
    expect(restaged?.text).toBe('重发我');
    expect(restaged?.queuedAtMs).toBe(h.clock.now());
    expect(restaged?.expireAtMs).toBe(h.clock.now() + OUTBOX_TTL_MS);
    // Re-armed: the previously imminent expiry no longer fires.
    h.clock.advance(OUTBOX_TTL_MS - 60_000);
    expect(h.expired).toHaveLength(0);
    h.clock.advance(60_000);
    expect(h.expired.map((entry) => entry.key)).toEqual(['m1']);
  });

  test('restage moves the entry to the back of the drain order', () => {
    const h = makeHarness();
    const outbox = h.make();
    outbox.stage('m1', 'a');
    outbox.stage('m2', 'b');
    outbox.restage('m1');
    expect(outbox.all().map((entry) => entry.key)).toEqual(['m2', 'm1']);
  });

  test('restage of an unknown key is a no-op', () => {
    const h = makeHarness();
    const outbox = h.make();
    expect(outbox.restage('nope')).toBeNull();
  });
});

describe('Outbox cap + oldest eviction (上限与最旧淘汰)', () => {
  test('overflow evicts the oldest through onEvicted', () => {
    const h = makeHarness();
    const outbox = h.make({ cap: 2 });
    outbox.stage('m1', 'a');
    outbox.stage('m2', 'b');
    const { evicted } = outbox.stage('m3', 'c');
    expect(evicted?.key).toBe('m1');
    expect(h.evicted.map((entry) => entry.key)).toEqual(['m1']);
    expect(outbox.all().map((entry) => entry.key)).toEqual(['m2', 'm3']);
  });

  test('default cap is the OUTBOX_CAP copy constant', () => {
    const h = makeHarness();
    const outbox = h.make();
    for (let index = 0; index < 51; index += 1) {
      outbox.stage(`m${index}`, 'x');
    }
    expect(outbox.size()).toBe(50);
    expect(h.evicted.map((entry) => entry.key)).toEqual(['m0']);
  });
});

describe('Outbox dispose', () => {
  test('dispose clears timers and entries', () => {
    const h = makeHarness();
    const outbox = h.make();
    outbox.stage('m1', 'a');
    outbox.dispose();
    expect(outbox.size()).toBe(0);
    expect(h.clock.pendingCount()).toBe(0);
    h.clock.advance(OUTBOX_TTL_MS * 2);
    expect(h.expired).toHaveLength(0);
  });
});
