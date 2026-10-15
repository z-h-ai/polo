import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CONFIG_DIR } from '@polo-ai/shared/config'
import { AdminError } from '@polo-ai/shared/admin'
import { BillingOutbox, type AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import { billingRuntimeAdmissionResponseSchema, billingUsageSchema, type BillingRuntimeAdmissionInput, type BillingRuntimeUsageInput } from '@polo-ai/shared/admin/billing-runtime-contract'
import type { ManagedBillingHooks, ManagedBillingResult } from '@polo-ai/shared/credentials/managed-billing-observation'

export interface AssistantBillingTransport {
  start(scope: AssistantBillingJournalScope, input: { subjectKind: 'polo_assistant'; productSpaceId: string; runId: string }): Promise<unknown>
  admit(scope: AssistantBillingJournalScope, runId: string, input: BillingRuntimeAdmissionInput): Promise<unknown>
  report(scope: AssistantBillingJournalScope, input: BillingRuntimeUsageInput): Promise<{ settlement?: 'pending' | 'confirmed' | 'no_charge' }>
  inspect(scope: AssistantBillingJournalScope, runId: string, requestId: string): Promise<{ settlement?: 'pending' | 'confirmed' | 'no_charge' }>
  finish(scope: AssistantBillingJournalScope, runId: string, input: { status: 'completed' | 'unknown' | 'failed' }): Promise<unknown>
}

/** One immutable run/request per actual HTTP attempt, including tools and
 * utility completions. Recovery only settles original work; it cannot send AI. */
export class AssistantBillingCoordinator {
  private live = new Set<string>()
  private recovering = false
  private offset = 0
  private pendingWrites = new Map<string, { scope: AssistantBillingJournalScope; receipt: BillingRuntimeUsageInput }>()
  constructor(private readonly outbox: BillingOutbox<AssistantBillingJournalScope>, private readonly transport: () => AssistantBillingTransport | null) {}
  hooks(originalScope: AssistantBillingJournalScope, isCurrent: () => boolean): ManagedBillingHooks {
    const scope = { ...originalScope }
    const assertCurrent = () => { if (!isCurrent()) throw new Error('Original assistant billing scope changed') }
    return { beforeSend: async facts => {
      assertCurrent()
      const transport = this.transport()
      if (!transport) throw new Error('Trusted assistant billing is unavailable')
      const runId = randomUUID(), requestId = randomUUID()
      const admission = { ...facts, productSpaceId: scope.productSpaceId, requestId }
      const key = this.outbox.stageAdmission(scope, runId, admission)
      this.live.add(key)
      let started = false
      try {
        await transport.start(scope, { subjectKind: 'polo_assistant', productSpaceId: scope.productSpaceId, runId })
        started = true
        assertCurrent()
        const admitted = billingRuntimeAdmissionResponseSchema.parse(await transport.admit(scope, runId, admission))
        if (admitted.request.requestId !== requestId) throw new Error('Assistant admission changed its original identity')
        let completed = false
        return { providerCorrelation: admitted.request.providerCorrelation, assertCurrent,
          complete: async (result: ManagedBillingResult) => {
            if (completed) return
            // Disk failure must surface. Never pretend an unjournaled receipt
            // is safe to drop, even when provider output was already streamed.
            const receipt = billingUsageSchema.parse({ ...result, productSpaceId: scope.productSpaceId, runId, requestId })
            completed = true
            // Bounded by the existing admission journal capacity. A temporary
            // disk error retains these exact final facts in memory for retry;
            // recovery never replaces them with an unknown/zero observation.
            this.pendingWrites.set(key, { scope, receipt })
            this.live.delete(key)
            this.outbox.stageReceipt(scope, receipt)
            this.pendingWrites.delete(key)
            await this.settle(key, scope, receipt).catch(() => {})
          } }
      } catch (error) {
        this.live.delete(key)
        const definitivelyDenied = error instanceof AdminError && (
          ['insufficient_credit', 'quota_exhausted', 'budget_exhausted'].includes(error.errorCode)
          || error.status !== undefined && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status))
        if (!started && definitivelyDenied) this.outbox.discardRejectedAdmission(key)
        else {
          let finished = false
          await transport.finish(scope, runId, { status: 'failed' }).then(() => { finished = true }).catch(() => {})
          if (started && definitivelyDenied && finished) this.outbox.discardRejectedAdmission(key)
        }
        throw error
      }
    } }
  }
  private async settle(key: string, scope: AssistantBillingJournalScope, receipt: BillingRuntimeUsageInput): Promise<void> {
    const transport = this.transport()
    if (!transport) return
    const ack = await transport.report(scope, receipt)
    if (!ack.settlement) return
    // Finish before retirement, so a lost terminal acknowledgement is also
    // recoverable. Retries keep the exact original receipt and run status.
    await transport.finish(scope, receipt.runId, { status: receipt.outputDisposition === 'usable' ? 'completed' : 'unknown' })
    this.outbox.applySettlement(key, ack.settlement)
  }
  async recover(accountId: string, adminOrigin: string): Promise<void> {
    if (this.recovering || !this.transport()) return
    this.recovering = true
    try {
      for (const [key, pending] of this.pendingWrites) {
        if (pending.scope.accountId !== accountId || pending.scope.adminOrigin !== adminOrigin) continue
        try { this.outbox.stageReceipt(pending.scope, pending.receipt); this.pendingWrites.delete(key) } catch { /* Keep the original bounded in-memory receipt until storage recovers. */ }
      }
      const entries = this.outbox.entries(accountId, adminOrigin)
      const start = entries.length ? this.offset % entries.length : 0
      this.offset = start + 32
      for (let i = 0; i < Math.min(32, entries.length); i++) {
        const entry = entries[(start + i) % entries.length]!
        if (this.live.has(entry.key) || this.pendingWrites.has(entry.key)) continue
        try {
          if (entry.receipt) await this.settle(entry.key, entry.scope, entry.receipt)
          else {
            const ack = await this.transport()!.inspect(entry.scope, entry.runId, entry.admission.requestId)
            if (ack.settlement && ack.settlement !== 'pending') {
              await this.transport()!.finish(entry.scope, entry.runId, { status: 'unknown' })
              this.outbox.applySettlement(entry.key, ack.settlement)
            }
          }
        } catch (error) {
          if (error instanceof AdminError && error.errorCode === 'idempotency_conflict') this.outbox.markConflict(entry.key)
        }
      }
    } finally { this.recovering = false }
  }
}

let transport: AssistantBillingTransport | null = null
let coordinator: AssistantBillingCoordinator | undefined
let retryTimer: ReturnType<typeof setInterval> | undefined
let billingSession: (() => Promise<{ accountId: string; adminOrigin: string } | null>) | undefined
function getCoordinator(): AssistantBillingCoordinator {
  return coordinator ??= new AssistantBillingCoordinator(new BillingOutbox<AssistantBillingJournalScope>(join(CONFIG_DIR, 'assistant-billing')), () => transport)
}
export function setAssistantBillingTransport(next: AssistantBillingTransport, session: () => Promise<{ accountId: string; adminOrigin: string } | null>): void {
  transport = next; billingSession = session
  const recover = async () => {
    const original = await billingSession?.().catch(() => null)
    if (original) await getCoordinator().recover(original.accountId, original.adminOrigin)
  }
  if (!retryTimer) { retryTimer = setInterval(() => { void recover().catch(() => {}) }, 30_000); retryTimer.unref?.() }
  void recover().catch(() => {})
}
export function createAssistantBillingHooks(scope: AssistantBillingJournalScope, isCurrent: () => boolean): ManagedBillingHooks {
  return getCoordinator().hooks(scope, isCurrent)
}
