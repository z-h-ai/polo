import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import type { AdminFinishAppRunResponse } from '@polo-ai/shared/admin'
import { join } from 'node:path'
import { CONFIG_DIR } from '@polo-ai/shared/config'
import { AdminError } from '@polo-ai/shared/admin'
import { BillingOutbox, type AssistantBillingJournalScope } from '@polo-ai/shared/admin/billing-outbox'
import { billingAssistantPreparationResponseSchema, billingRuntimeRunResponseSchema, billingRuntimeAdmissionResponseSchema, billingRuntimeFinishResponseSchema, billingUsageSchema, type BillingRuntimeAdmissionInput, type BillingRuntimeUsageInput } from '@polo-ai/shared/admin/billing-runtime-contract'
import type { ManagedBillingHooks, ManagedBillingResult } from '@polo-ai/shared/credentials/managed-billing-observation'

// AdminClient validates the HTTP envelope and returns this flat DTO. Derive
// its fields from the canonical wire schema; do not require wire idempotent
// or invent another status/settlement enum at the transport consumer.
const assistantFinishResponseSchema = billingRuntimeFinishResponseSchema.shape.run.extend({
  settlement: billingRuntimeFinishResponseSchema.shape.settlement,
}) satisfies z.ZodType<AdminFinishAppRunResponse>

export interface AssistantBillingTransport {
  supportsPreparation?(scope: AssistantBillingJournalScope): Promise<boolean>
  prepare?(scope: AssistantBillingJournalScope, runId: string, input: BillingRuntimeAdmissionInput): Promise<unknown>
  inspectRun?(scope: AssistantBillingJournalScope, runId: string): Promise<unknown>
  start(scope: AssistantBillingJournalScope, input: { subjectKind: 'polo_assistant'; productSpaceId: string; runId: string }): Promise<unknown>
  admit(scope: AssistantBillingJournalScope, runId: string, input: BillingRuntimeAdmissionInput): Promise<unknown>
  report(scope: AssistantBillingJournalScope, input: BillingRuntimeUsageInput): Promise<{ settlement?: 'pending' | 'confirmed' | 'no_charge'; resolution?: 'platform_absorbed' }>
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
      // Discovery cannot create billable work; do it before persisting an intent.
      const combined = Boolean(transport.prepare) && (await transport.supportsPreparation?.(scope) ?? true)
      assertCurrent()
      const runId = randomUUID(), requestId = randomUUID()
      const admission = { ...facts, productSpaceId: scope.productSpaceId, requestId }
      const key = this.outbox.stageAdmission(scope, runId, admission)
      this.live.add(key)
      let started = false
      try {
        let admitted
        if (combined) {
          // The server may commit start before returning any response.
          started = true
          const prepared = billingAssistantPreparationResponseSchema.parse(await transport.prepare!(scope, runId, admission))
          if (prepared.runId !== runId) throw new Error('Assistant preparation changed its original run')
          admitted = prepared
        } else {
          await transport.start(scope, { subjectKind: 'polo_assistant', productSpaceId: scope.productSpaceId, runId })
          started = true
          assertCurrent()
          admitted = billingRuntimeAdmissionResponseSchema.parse(await transport.admit(scope, runId, admission))
        }
        assertCurrent()
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
        const rejection = error instanceof AdminError ? error.details?.assistantPreparation : undefined
        // This call owns fresh random IDs and is never retried. The marker only
        // retires this unsent intent; it is not a zero-cost settlement receipt.
        const freshStartRejected = combined && definitivelyDenied && rejection?.phase === 'start_rejected'
          && rejection.runId === runId && rejection.requestId === requestId
        if (freshStartRejected || !started && definitivelyDenied) this.outbox.discardRejectedAdmission(key)
        else {
          // This catch precedes the return of the send ticket: no provider
          // request can have been sent. A transient admission failure can still
          // finish authoritatively with no charge. Retire only that exact run's
          // validated terminal acknowledgement, never a 404 or missing receipt.
          const finished = await transport.finish(scope, runId, { status: 'failed' })
            .then(value => assistantFinishResponseSchema.safeParse(value))
            .catch(() => null)
          if (started && finished?.success && finished.data.runId === runId
            && finished.data.settlement === 'no_charge') this.outbox.discardRejectedAdmission(key)
        }
        throw error
      }
    } }
  }
  private async finishOriginal(transport: AssistantBillingTransport, scope: AssistantBillingJournalScope, runId: string,
    status: 'completed' | 'unknown', settlement: 'pending' | 'confirmed' | 'no_charge'): Promise<void> {
    try { await transport.finish(scope, runId, { status }) }
    catch (error) {
      if (!(error instanceof AdminError) || error.errorCode !== 'run_finalized' || !transport.inspectRun) throw error
      const original = billingRuntimeRunResponseSchema.parse(await transport.inspectRun(scope, runId))
      // A worker may have settled this same request before the client's final
      // PATCH. Only matching original facts can replace that acknowledgement.
      if (original.run.runId !== runId || original.run.productSpaceId !== scope.productSpaceId
        || original.run.status === 'running' || original.settlement !== settlement || settlement === 'pending') throw error
    }
  }
  private async settle(key: string, scope: AssistantBillingJournalScope, receipt: BillingRuntimeUsageInput): Promise<void> {
    const transport = this.transport()
    if (!transport) return
    const ack = await transport.report(scope, receipt)
    if (!ack.settlement) return
    if (ack.resolution === 'platform_absorbed' && ack.settlement === 'no_charge') {
      // The audited resolution already finalized the original execution.
      // A late usable observation must not turn unknown/cancelled into completed.
      this.outbox.applySettlement(key, 'no_charge')
      return
    }
    // Finish before retirement, so a lost terminal acknowledgement is also
    // recoverable. Retries keep the exact original receipt and run status.
    await this.finishOriginal(transport, scope, receipt.runId, receipt.outputDisposition === 'usable' ? 'completed' : 'unknown', ack.settlement)
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
              await this.finishOriginal(this.transport()!, entry.scope, entry.runId, 'unknown', ack.settlement)
              this.outbox.applySettlement(entry.key, ack.settlement)
            }
          }
        } catch (error) {
          if (!entry.receipt && error instanceof AdminError && error.status === 404) {
            // A missing admission is not a settlement. Ask the original run to
            // finish; only its validated no-charge acknowledgement can release
            // a journal left by a failed admission and lost finish response.
            const finished = await this.transport()!.finish(entry.scope, entry.runId, { status: 'failed' })
              .then(value => assistantFinishResponseSchema.safeParse(value)).catch(() => null)
            if (finished?.success && finished.data.runId === entry.runId
              && finished.data.settlement === 'no_charge') this.outbox.discardRejectedAdmission(entry.key)
            else if (this.transport()?.inspectRun) {
              // The worker may already have closed this run with a different
              // terminal status. Read it, never overwrite it to make PATCH pass.
              const original = await this.transport()!.inspectRun!(entry.scope, entry.runId)
                .then(value => billingRuntimeRunResponseSchema.safeParse(value)).catch(() => null)
              if (original?.success && original.data.run.runId === entry.runId
                && original.data.run.productSpaceId === entry.scope.productSpaceId
                && original.data.run.status !== 'running' && original.data.settlement === 'no_charge') {
                this.outbox.discardRejectedAdmission(entry.key)
              }
            }
          }
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
