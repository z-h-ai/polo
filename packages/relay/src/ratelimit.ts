/**
 * Per-connection sliding-window rate limiter (PRD v1.6 §⑥): at most
 * `limit` data messages per `windowMs`; exceeding the limit is reported so the
 * server can close the connection with 4008.
 */

export class SlidingWindowLimiter {
  private readonly hits: number[] = []

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true when the message is allowed, false when the limit is exceeded. */
  check(): boolean {
    const now = this.now()
    const cutoff = now - this.windowMs
    while (this.hits.length > 0 && this.hits[0]! <= cutoff) {
      this.hits.shift()
    }
    if (this.hits.length >= this.limit) return false
    this.hits.push(now)
    return true
  }
}
