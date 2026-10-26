/**
 * Journey #1 — pure decision for the chat input status banner.
 *
 * The banner must NOT lump billing classes together: an insufficient-credit
 * block speaks in recharge semantics (owner/personal get the trusted payment
 * handoff action; members get contact-an-admin copy), while a period-quota
 * block may only promise a reset when the SERVER supplied the reset fact —
 * a plain 429 stays promise-free. Everything else keeps its existing
 * informational/destructive semantics.
 */
import type { ChatAccessStatus } from '../context/AppShellContext'

export type ChatAccessBannerAction = 'recharge' | 'retry-ai-config-sync'

export interface ChatAccessBannerDecision {
  variant: 'info' | 'destructive'
  messageKey: string
  /** Server-provided reset fact (epoch ms); only set for quota-exhausted WITH one. */
  quotaResetAt?: number
  action?: ChatAccessBannerAction
}

/** Role gate input mirror of the product-space context projection. */
export interface ChatAccessBannerScope {
  canOpenPayment: boolean
}

export function decideChatAccessBanner(
  status: ChatAccessStatus | null | undefined,
  scope: ChatAccessBannerScope,
): ChatAccessBannerDecision | null {
  switch (status?.issue) {
    case 'no-ai-service':
      return { variant: 'info', messageKey: 'chat.statusBanner.noAiService' }
    case 'insufficient-credit':
      // Role split: the handoff exists ONLY where the payer is this user.
      // A member must never see a recharge button that mints someone else's
      // ticket, and nobody sees a fake "已完成" completion affordance (the
      // recharge→recheck loop is out of scope for this batch).
      return scope.canOpenPayment
        ? {
            variant: 'destructive',
            messageKey: 'chat.statusBanner.insufficientCredit',
            action: 'recharge',
          }
        : { variant: 'destructive', messageKey: 'chat.statusBanner.insufficientCreditMember' }
    case 'quota-exhausted':
      // Conditional reset copy: the promise exists only with the server's own
      // reset fact; a plain 429 says the period quota is exhausted and stops.
      return status.quotaResetAt !== undefined
        ? {
            variant: 'destructive',
            messageKey: 'chat.statusBanner.quotaExhaustedWithReset',
            quotaResetAt: status.quotaResetAt,
          }
        : { variant: 'destructive', messageKey: 'chat.statusBanner.quotaExhaustedNoReset' }
    case 'account-disabled':
      return { variant: 'destructive', messageKey: 'chat.statusBanner.accountDisabled' }
    case 'ai-config-syncing':
      return { variant: 'info', messageKey: 'chat.statusBanner.aiConfigSyncing' }
    case 'ai-config-sync-failed':
      return {
        variant: 'destructive',
        messageKey: 'chat.statusBanner.aiConfigSyncFailed',
        action: 'retry-ai-config-sync',
      }
    default:
      return null
  }
}
