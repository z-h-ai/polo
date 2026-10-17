/**
 * Unit tests for the relay offline queue, sliding-window limiter and TTL cache
 * (POL-11). Pure in-memory, injectable clocks — no network.
 */

import { describe, expect, test } from 'bun:test'
import { TtlCache } from '../auth.ts'
import { buildControlEnvelope, parsePersona, serializeEnvelope } from '../envelope.ts'
import { OfflineQueue } from '../queue.ts'
import { SlidingWindowLimiter } from '../ratelimit.ts'

describe('persona parsing', () => {
  test('phone:/mac: prefixes parse, others rejected', () => {
    expect(parsePersona('phone:p1')).toEqual({ side: 'phone', id: 'p1', persona: 'phone:p1' })
    expect(parsePersona('mac:m1')).toEqual({ side: 'mac', id: 'm1', persona: 'mac:m1' })
    expect(parsePersona('relay')).toBeNull()
    expect(parsePersona('phone:')).toBeNull()
    expect(parsePersona('nonsense')).toBeNull()
  })

  test('control envelope carries metadata only and serializes', () => {
    const envelope = buildControlEnvelope('phone:p1', { type: 'delivery_failed', reason: 'mac_offline' }, 123)
    const parsed = JSON.parse(serializeEnvelope(envelope)) as Record<string, unknown>
    expect(parsed).toMatchObject({ v: 1, from: 'relay', to: 'phone:p1', kind: 'control', payload: { type: 'delivery_failed', reason: 'mac_offline' } })
  })
})

describe('OfflineQueue', () => {
  const envelopeOf = (seq: number) => ({
    v: 1 as const,
    from: 'phone:p1',
    to: `mac:m${seq}`,
    kind: 'rpc',
    payload: { seq },
  })

  test('drain returns entries oldest-first and empties the queue', () => {
    let t = 1_000
    const queue = new OfflineQueue({ ttlMs: 5_000, maxPerMac: 10, sweepIntervalMs: 0, now: () => t })
    queue.enqueue('m1', envelopeOf(1), 'user-1')
    t += 10
    queue.enqueue('m1', envelopeOf(2), 'user-1')
    queue.enqueue('m1', envelopeOf(3), 'user-1')

    const drained = queue.drain('m1')
    expect(drained.map((e) => (e.payload as { seq: number }).seq)).toEqual([1, 2, 3])
    expect(drained.every((e) => typeof e.queuedAt === 'number' && e.queuedAt > 0)).toBe(true)
    expect(queue.pendingCount('m1')).toBe(0)
    queue.dispose()
  })

  test('drain drops entries that expired unswept and reports them via onExpire', () => {
    let t = 1_000
    const expired: number[] = []
    const queue = new OfflineQueue({
      ttlMs: 500,
      maxPerMac: 10,
      sweepIntervalMs: 0,
      onExpire: (entry) => expired.push((entry.envelope.payload as { seq: number }).seq),
      now: () => t,
    })
    queue.enqueue('m1', envelopeOf(1), 'user-1')
    t += 600 // entry 1 is past its TTL; the background sweep never ran
    queue.enqueue('m1', envelopeOf(2), 'user-1')

    const drained = queue.drain('m1')
    expect(drained.map((e) => (e.payload as { seq: number }).seq)).toEqual([2])
    expect(expired).toEqual([1])
    expect(queue.pendingCount('m1')).toBe(0)
    queue.dispose()
  })

  test('sweep drops expired entries and reports them via onExpire', () => {
    let t = 1_000
    const expired: number[] = []
    const queue = new OfflineQueue({
      ttlMs: 500,
      maxPerMac: 10,
      sweepIntervalMs: 0,
      onExpire: (entry) => expired.push((entry.envelope.payload as { seq: number }).seq),
      now: () => t,
    })
    queue.enqueue('m1', envelopeOf(1), 'user-1')
    queue.enqueue('m1', envelopeOf(2), 'user-1')
    t += 501
    queue.enqueue('m1', envelopeOf(3), 'user-1')

    queue.sweep()
    expect(expired).toEqual([1, 2])
    expect(queue.pendingCount('m1')).toBe(1)
    queue.dispose()
  })

  test('per-mac cap rejects further enqueues with null', () => {
    const queue = new OfflineQueue({ ttlMs: 5_000, maxPerMac: 2, sweepIntervalMs: 0, now: () => 1 })
    expect(queue.enqueue('m1', envelopeOf(1), 'user-1')).not.toBeNull()
    expect(queue.enqueue('m1', envelopeOf(2), 'user-1')).not.toBeNull()
    expect(queue.enqueue('m1', envelopeOf(3), 'user-1')).toBeNull()
    expect(queue.pendingCount('m1')).toBe(2)
    queue.dispose()
  })
})

describe('SlidingWindowLimiter', () => {
  test('allows up to the limit inside the window, then blocks; recovers after', () => {
    let t = 0
    const limiter = new SlidingWindowLimiter(3, 1_000, () => t)
    expect(limiter.check()).toBe(true)
    expect(limiter.check()).toBe(true)
    expect(limiter.check()).toBe(true)
    expect(limiter.check()).toBe(false)

    t += 1_001
    expect(limiter.check()).toBe(true)
  })
})

describe('TtlCache', () => {
  test('entries expire after ttl', () => {
    let t = 0
    const cache = new TtlCache<string, number>(100, () => t)
    cache.set('k', 42)
    expect(cache.get('k')).toBe(42)
    t += 101
    expect(cache.get('k')).toBeUndefined()
    cache.set('k', 7)
    expect(cache.get('k')).toBe(7)
    cache.delete('k')
    expect(cache.get('k')).toBeUndefined()
  })

  test('maxEntries evicts the oldest insertion as a hard memory bound', () => {
    let t = 0
    const cache = new TtlCache<string, number>(1_000, () => t, 2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })
})
