/**
 * In-memory offline queue (PRD v1.6 §⑥ v1.6 回写): when a Mac is offline,
 * phone→mac envelopes are staged for up to 5 minutes and delivered in
 * `queuedAt` order as soon as the Mac reconnects. Expired entries are dropped
 * and the sending phone receives a `delivery_failed`/`mac_offline` receipt.
 *
 * Memory only — a process restart clears everything, matching the "no
 * persistence" boundary of the relay.
 */

import type { Envelope } from './envelope.ts'

export interface QueueEntry {
  envelope: Envelope
  macDeviceId: string
  /** Authenticated userId of the sending phone (binds expiry receipts to the owner). */
  ownerUserId: string
  queuedAt: number
  expiresAt: number
}

export interface OfflineQueueOptions {
  ttlMs: number
  maxPerMac: number
  /** Sweep cadence; 0 disables the background timer (tests drain manually). */
  sweepIntervalMs?: number
  onExpire?: (entry: QueueEntry) => void
  now?: () => number
}

export class OfflineQueue {
  private readonly queues = new Map<string, QueueEntry[]>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: OfflineQueueOptions) {
    const sweep = options.sweepIntervalMs ?? Math.min(Math.max(options.ttlMs / 4, 20), 30_000)
    if (sweep > 0) {
      this.timer = setInterval(() => this.sweep(), sweep)
      this.timer.unref?.()
    }
  }

  /** Stages an envelope; returns the entry, or null when the per-mac queue is full. */
  enqueue(macDeviceId: string, envelope: Envelope, ownerUserId: string): QueueEntry | null {
    const now = this.options.now ? this.options.now() : Date.now()
    let queue = this.queues.get(macDeviceId)
    if (!queue) {
      queue = []
      this.queues.set(macDeviceId, queue)
    }
    if (queue.length >= this.options.maxPerMac) return null
    const entry: QueueEntry = {
      envelope: { ...envelope, queuedAt: now },
      macDeviceId,
      ownerUserId,
      queuedAt: now,
      expiresAt: now + this.options.ttlMs,
    }
    queue.push(entry)
    return entry
  }

  /**
   * Removes and returns pending envelopes for a Mac, oldest first. Entries that
   * expired while staged (sweep has not run yet) are dropped here as well and
   * reported through onExpire — TTL is enforced at delivery time, not just by
   * the background sweep.
   */
  drain(macDeviceId: string): Envelope[] {
    const queue = this.queues.get(macDeviceId)
    if (!queue || queue.length === 0) return []
    this.queues.delete(macDeviceId)
    const now = this.options.now ? this.options.now() : Date.now()
    const fresh: QueueEntry[] = []
    const expired: QueueEntry[] = []
    for (const entry of queue) {
      if (entry.expiresAt <= now) expired.push(entry)
      else fresh.push(entry)
    }
    for (const entry of expired) this.options.onExpire?.(entry)
    return fresh
      .slice()
      .sort((a, b) => a.queuedAt - b.queuedAt)
      .map((entry) => entry.envelope)
  }

  pendingCount(macDeviceId: string): number {
    return this.queues.get(macDeviceId)?.length ?? 0
  }

  /** Drops expired entries and reports each to the onExpire callback. */
  sweep(): QueueEntry[] {
    const now = this.options.now ? this.options.now() : Date.now()
    const expired: QueueEntry[] = []
    for (const [macDeviceId, queue] of this.queues) {
      const remaining = queue.filter((entry) => {
        if (entry.expiresAt <= now) {
          expired.push(entry)
          return false
        }
        return true
      })
      if (remaining.length === 0) this.queues.delete(macDeviceId)
      else this.queues.set(macDeviceId, remaining)
    }
    for (const entry of expired) this.options.onExpire?.(entry)
    return expired
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.queues.clear()
  }
}
