// POL-242 unit tests for src/conn/reconnect.ts — backoff sequence, close-code
// classification (认证类不重试) and replay event sequencing (按序去重).

import { describe, expect, test } from 'bun:test';

import {
  AUTH_CLOSE_CODES,
  EventSequencer,
  classifyClose,
  computeBackoffDelayMs,
} from '../reconnect';

describe('computeBackoffDelayMs', () => {
  test('exponential sequence 1s,2s,4s,8s,16s,30s with cap (jitter pinned to 1.0)', () => {
    const random = () => 0.5; // jitter = 0.8 + 0.5*0.4 = 1.0 — exact sequence
    const delays = [0, 1, 2, 3, 4, 5].map((attempt) =>
      computeBackoffDelayMs(attempt, { random }),
    );
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    // cap holds beyond the sequence
    expect(computeBackoffDelayMs(6, { random })).toBe(30_000);
    expect(computeBackoffDelayMs(50, { random })).toBe(30_000);
  });

  test('jitter stays within ±20% of the capped base', () => {
    const low = computeBackoffDelayMs(0, { random: () => 0 }); // -20%
    const high = computeBackoffDelayMs(0, { random: () => 1 }); // +20%
    expect(low).toBe(800);
    expect(high).toBe(1_200);

    // cap applies after jitter: never exceeds maxMs
    for (let i = 0; i < 50; i++) {
      const delay = computeBackoffDelayMs(10, { random: Math.random });
      expect(delay).toBeLessThanOrEqual(30_000);
      expect(delay).toBeGreaterThanOrEqual(24_000);
    }
  });

  test('negative attempts are clamped to the base delay', () => {
    expect(computeBackoffDelayMs(-3, { random: () => 0.5 })).toBe(1_000);
  });

  test('custom base/max', () => {
    expect(computeBackoffDelayMs(2, { baseMs: 250, maxMs: 700, random: () => 0.5 })).toBe(700);
  });
});

describe('classifyClose (认证类关闭码不重试)', () => {
  test('auth close codes are fatal', () => {
    // 4005: server-core WsRpc auth; 4401/4403: polo-relay unauthorized/forbidden
    expect([...AUTH_CLOSE_CODES].sort()).toEqual([4005, 4401, 4403]);
    expect(classifyClose(4005)).toBe('auth');
    expect(classifyClose(4401)).toBe('auth');
    expect(classifyClose(4403)).toBe('auth');
  });

  test('transport-level auth error kind is fatal', () => {
    expect(classifyClose(undefined, 'auth')).toBe('auth');
    expect(classifyClose(1006, 'auth')).toBe('auth');
  });

  test('everything else is retryable', () => {
    expect(classifyClose(undefined)).toBe('retryable');
    expect(classifyClose(1006)).toBe('retryable'); // abnormal close / network
    expect(classifyClose(4000)).toBe('retryable'); // relay heartbeat timeout
    expect(classifyClose(4009)).toBe('retryable'); // relay persona replaced
    expect(classifyClose(4008)).toBe('retryable'); // relay rate limit
    expect(classifyClose(1000, 'network')).toBe('retryable');
  });
});

describe('EventSequencer (replay 按序转交 + 去重)', () => {
  const evt = (seq: number) => ({ seq, id: `e${seq}` });

  test('live stream passes in order', () => {
    const sequencer = new EventSequencer();
    expect(sequencer.shouldDeliver(evt(1))).toBe(true);
    expect(sequencer.shouldDeliver(evt(2))).toBe(true);
    expect(sequencer.shouldDeliver(evt(3))).toBe(true);
    expect(sequencer.lastSeenSeq).toBe(3);
  });

  test('duplicate and late replay frames are dropped', () => {
    const sequencer = new EventSequencer();
    for (const seq of [1, 2, 3]) expect(sequencer.shouldDeliver(evt(seq))).toBe(true);
    // replay window: a duplicate 2 and an out-of-order 2 arriving late
    expect(sequencer.shouldDeliver(evt(2))).toBe(false);
    expect(sequencer.shouldDeliver({ seq: 2, id: 'e2-again' })).toBe(false);
    // missed frames replayed after the gap
    expect(sequencer.shouldDeliver(evt(4))).toBe(true);
    expect(sequencer.shouldDeliver(evt(5))).toBe(true);
  });

  test('seq-less events dedupe by envelope id (bounded window)', () => {
    const sequencer = new EventSequencer(2);
    expect(sequencer.shouldDeliver({ id: 'a' })).toBe(true);
    expect(sequencer.shouldDeliver({ id: 'a' })).toBe(false);
    expect(sequencer.shouldDeliver({ id: 'b' })).toBe(true);
    expect(sequencer.shouldDeliver({ id: 'c' })).toBe(true);
    // cap=2 FIFO: inserting 'c' evicted 'a'
    expect(sequencer.shouldDeliver({ id: 'a' })).toBe(true); // re-learned, evicts 'b'
    expect(sequencer.shouldDeliver({ id: 'c' })).toBe(false); // still remembered
    expect(sequencer.shouldDeliver({ id: 'b' })).toBe(true); // 'b' was evicted by the 'a' re-insert
  });

  test('events without seq and id always deliver', () => {
    const sequencer = new EventSequencer();
    expect(sequencer.shouldDeliver({})).toBe(true);
    expect(sequencer.shouldDeliver({})).toBe(true);
  });

  test('reset restarts sequencing for a fresh (non-replayed) session', () => {
    const sequencer = new EventSequencer();
    expect(sequencer.shouldDeliver(evt(4))).toBe(true);
    sequencer.reset();
    expect(sequencer.lastSeenSeq).toBe(0);
    expect(sequencer.shouldDeliver(evt(1))).toBe(true); // server restarted seq
    expect(sequencer.shouldDeliver(evt(1))).toBe(false);
  });
});
