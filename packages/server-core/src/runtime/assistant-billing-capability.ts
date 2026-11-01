/** Bounded discovery for one active identity. This never caches authorization.
 * In-flight probes are shared; failed probes are discarded. Changing scope or
 * restarting the process forces discovery, upgrades are noticed within 60s. */
export class AssistantBillingCapability<T = boolean> {
  private entry?: { key: string; expiresAt: number; value: Promise<T> }
  constructor(private readonly now = Date.now) {}
  invalidate(scope: { accountId: string; adminOrigin: string; productSpaceId: string }): void {
    if (this.entry?.key === JSON.stringify([scope.adminOrigin, scope.accountId, scope.productSpaceId])) this.entry = undefined
  }
  read(scope: { accountId: string; adminOrigin: string; productSpaceId: string }, probe: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    const key = JSON.stringify([scope.adminOrigin, scope.accountId, scope.productSpaceId])
    if (this.entry?.key !== key || this.entry.expiresAt <= this.now()) {
      const entry = { key, expiresAt: this.now() + 60_000, value: Promise.resolve().then(probe) }
      this.entry = entry
      void entry.value.catch(() => { if (this.entry === entry) this.entry = undefined })
    }
    const value = this.entry.value
    if (!signal) return value
    // Cancel only this waiter. The shared bounded HTTP probe may serve others.
    return new Promise<T>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      void value.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
}
