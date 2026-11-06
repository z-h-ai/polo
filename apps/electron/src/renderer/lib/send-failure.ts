/**
 * Journey #8 — classification of a FAILED local send, kept pure so the
 * App.tsx catch block stays a thin applier and the semantics stay testable.
 *
 * The failure classes map onto distinct renderer surfaces:
 * - billing → the #1 chat-access latch (recharge/member or quota banner);
 *   the draft prompt would be noise under a hard block, so none is raised.
 * - an armed Goal start rejection → the Goal-scoped toast (verbatim server
 *   text); a Goal command failure never becomes an ordinary re-send.
 * - everything else → a session-scoped transient prompt that keeps the draft
 *   and offers the explicit "restore draft" action. The optimistic user
 *   bubble is removed in all classes: the server receipt is unknown, so the
 *   renderer must not keep a half-confirmed message, and the draft lives on
 *   in the prompt instead of a fake bubble.
 */
import { isInsufficientCreditError, isPeriodQuotaError, readQuotaResetAt } from './quota-error'
import type { SessionBillingErrorClassification } from '@polo-ai/shared/protocol'

export type SendFailureOutcome =
  | {
      kind: 'billing-block'
      issue: 'insufficient-credit' | 'quota-exhausted'
      quotaResetAt?: number
    }
  | { kind: 'goal-start-failed' }
  | { kind: 'send-failed'; detail: string }

export function classifySendFailure(
  error: unknown,
  opts: { hadGoalStartIntent: boolean },
): SendFailureOutcome {
  // Billing classes win over everything: the block banner replaces any draft
  // prompt, and the #1 latch owns the messaging.
  if (isInsufficientCreditError(error)) {
    return { kind: 'billing-block', issue: 'insufficient-credit' }
  }
  if (isPeriodQuotaError(error)) {
    return { kind: 'billing-block', issue: 'quota-exhausted', quotaResetAt: readQuotaResetAt(error) }
  }
  // POO-134: a rejected Goal start surfaces through the Goal toast — never
  // downgraded into the ordinary send-failure prompt.
  if (opts.hadGoalStartIntent) {
    return { kind: 'goal-start-failed' }
  }
  return {
    kind: 'send-failed',
    detail: error instanceof Error ? error.message : String(error),
  }
}

/**
 * POO-177 QUOTA-01 — the event-stream twin of the send-rejection classes. A
 * turn the SERVER terminated never reaches a renderer catch block: a blocked
 * admission arrives as a post-persist error event and a provider 402 as an
 * in-stream typed_error. Both may carry the server's structured billing
 * classification (`billingClassification`), which holds exactly the trusted
 * fields the recognition table above reads (errorCode / status) — so it is
 * classified by feeding classifySendFailure ITSELF. One billing vocabulary,
 * no message-text guessing; an event without the field, or one whose class
 * is not a billing block, stays null.
 */
export function classifyEventBillingBlock(
  classification: SessionBillingErrorClassification | undefined,
): Extract<SendFailureOutcome, { kind: 'billing-block' }> | null {
  if (!classification) return null
  const outcome = classifySendFailure(classification, { hadGoalStartIntent: false })
  return outcome.kind === 'billing-block' ? outcome : null
}

/**
 * Drop the optimistic user bubble for a failed send. The message was never
 * confirmed by the server (its receipt is unknown), so it must not linger as
 * a pending bubble — and NO error message is appended here: the failure is a
 * session-scoped prompt, not persisted conversation content.
 */
export function stripFailedOptimisticMessage<T extends { id: string }>(
  messages: T[],
  optimisticMessageId: string,
): T[] {
  return messages.filter(message => message.id !== optimisticMessageId)
}
