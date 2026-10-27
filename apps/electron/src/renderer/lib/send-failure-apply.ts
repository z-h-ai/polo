/**
 * U4 (product-closure 2026-10-27) — the SHARED failure pipeline every send
 * entry point funnels into: classify once (send-failure.ts), then apply the
 * exact same renderer surfaces.
 *
 * The three entry points with distinct transports but ONE failure contract:
 * - the composer send (App.handleSendMessage — optimistic bubble stripped);
 * - the deep-link `send=true` auto-send (NavigationContext new-session);
 * - the `send-message` action API (NavigationContext).
 *
 * A deep-link/action send never produces an optimistic bubble, so the applier
 * only owns the surfaces that exist on those paths: the billing latch, the
 * session-scoped draft-keeping prompt, and the Goal-start toast. The caller
 * keeps its own callback/report semantics (exactly-once) and its own
 * optimistic-bubble cleanup.
 */
import type { getDefaultStore } from 'jotai'
import { i18n } from '@polo-ai/shared/i18n'
import { toast } from 'sonner'
import { sendFailureAtomFamily } from '@/atoms/sessions'
import { classifySendFailure, type SendFailureOutcome } from './send-failure'

export interface ApplySendFailureDeps {
  /** The ambient provider store (useStore() / getDefaultStore()). */
  store: ReturnType<typeof getDefaultStore>
  /** U2/U4: the Journey #1 billing latch setter (App-owned state). */
  setBillingLatch: (issue: 'insufficient-credit' | 'quota-exhausted', quotaResetAt?: number) => void
}

/**
 * Apply the unified failure pipeline for a failed (or blocked) send and
 * return the classification so the caller can map its own action-callback
 * error code. Never throws — a failure pipeline that throws would defeat
 * every catch block it sits inside.
 */
export function applySendFailure(
  error: unknown,
  opts: { sessionId: string; draft: string; hadGoalStartIntent: boolean },
  deps: ApplySendFailureDeps,
): SendFailureOutcome {
  let outcome: SendFailureOutcome
  try {
    outcome = classifySendFailure(error, { hadGoalStartIntent: opts.hadGoalStartIntent })
  } catch {
    // classifySendFailure is pure, but a broken classification must never
    // take down the caller's catch block — degrade to a plain send failure.
    outcome = { kind: 'send-failed', detail: error instanceof Error ? error.message : String(error) }
  }

  if (outcome.kind === 'billing-block') {
    // Journey #1: the latch records WHICH billing class blocked the send —
    // insufficient credit (recharge/member + U2 recheck copy) vs period quota
    // (reset copy only with the server's own reset fact). A reset fact the
    // server did not send is never invented here.
    deps.setBillingLatch(outcome.issue, outcome.issue === 'quota-exhausted' ? outcome.quotaResetAt : undefined)
    // Journey #8 (review F1): the block banner outranks the draft prompt,
    // but the draft itself must survive the block — it rides in the same
    // session-scoped prompt atom and becomes restorable once the latch
    // clears. Losing the text entirely was the bug.
    deps.store.set(sendFailureAtomFamily(opts.sessionId), {
      title: i18n.t('chat.sendFailed.title'),
      detail: error instanceof Error ? error.message : String(error),
      draft: opts.draft,
      billingBlocked: true,
    })
  } else if (outcome.kind === 'goal-start-failed') {
    // POO-134: a rejected Goal start surfaces through the Goal toast — never
    // downgraded into the ordinary send-failure prompt.
    toast.error(i18n.t('goal.startFailed', {
      error: error instanceof Error ? error.message : String(error),
    }), { duration: 5000 })
  } else {
    // Journey #8: session-scoped transient prompt (localized title +
    // collapsed technical detail + explicit restore-draft action). The
    // draft is preserved here — re-sending stays a deliberate user act,
    // never an automatic resend of a message whose server receipt is
    // unknown.
    deps.store.set(sendFailureAtomFamily(opts.sessionId), {
      title: i18n.t('chat.sendFailed.title'),
      detail: outcome.detail,
      draft: opts.draft,
    })
  }
  return outcome
}

/**
 * U4: the deep-link/action path can ALSO be stopped before any request is
 * made — the Journey #1 billing latch is already up. That is not a server
 * failure, but the drafted text must not silently vanish either: park it in
 * the same session-scoped prompt (billing-blocked shape) so it becomes
 * restorable once the latch lifts. Mirrors handleSendMessage's hard block,
 * minus the optimistic bubble those paths never had.
 */
export function applySendBlockedByLatch(
  sessionId: string,
  draft: string,
  deps: Pick<ApplySendFailureDeps, 'store'>,
): void {
  deps.store.set(sendFailureAtomFamily(sessionId), {
    title: i18n.t('chat.sendFailed.title'),
    detail: i18n.t('billingRecheck.blockedDraftDetail'),
    draft,
    billingBlocked: true,
  })
}
