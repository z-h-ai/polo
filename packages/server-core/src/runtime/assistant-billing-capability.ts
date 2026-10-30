/** Bounded discovery for one active identity. This never caches authorization.
 * In-flight probes are shared; failed probes are discarded. Changing scope or
 * restarting the process forces discovery, upgrades are noticed within 60s. */
export class AssistantBillingCapability {
  private entry?: { key: string; expiresAt: number; value: Promise<boolean> }
  constructor(private readonly now = Date.now) {}
  read(scope: { accountId: string; adminOrigin: string; productSpaceId: string }, probe: () => Promise<boolean>): Promise<boolean> {
    const key = JSON.stringify([scope.adminOrigin, scope.accountId, scope.productSpaceId])
    if (this.entry?.key === key && this.entry.expiresAt > this.now()) return this.entry.value
    const entry = { key, expiresAt: this.now() + 60_000, value: Promise.resolve().then(probe) }
    this.entry = entry
    void entry.value.catch(() => { if (this.entry === entry) this.entry = undefined })
    return entry.value
  }
}
