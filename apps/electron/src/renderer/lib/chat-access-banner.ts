/**
 * Journey #1 — pure decision for the chat input status banner.
 *
 * The banner must NOT lump billing classes together: an insufficient-credit
 * block speaks in recharge semantics (owner/personal get the trusted payment
 * handoff action; members get contact-an-admin copy), while a period-quota
 * block may only promise a reset when the SERVER supplied the reset fact —
 * a plain 429 stays promise-free. Everything else keeps its existing
 * informational/destructive semantics.
 *
 * U2 (product-closure 2026-10-27): both insufficient-credit role variants
 * gain the SECOND action "我已完成充值，重新检查" — it clears the billing
 * latch for the CURRENT account/space and lets the NEXT explicit send be
 * re-adjudicated by the server. It never auto-sends, never clears hard
 * blocks (permissions / no service), and quota blocks never carry it (a
 * recharge cannot lift a period quota). The persisted billing error bubble
 * (chat-billing-error.ts) is deliberately NOT touched — role-aware actions
 * live on the ACTIVE banner only.
 *
 * U10 (product-closure 2026-10-27): `no-ai-service` is split by space kind.
 * There is no reachable AI-service settings route in the current client
 * (verified against settings-registry.ts — the only config surface is the
 * onboarding credentials step), so the personal-space variant is honest
 * copy WITHOUT a settings jump: the misleading "管理员" (the user IS the
 * admin in a personal space) is simply gone.
 */
import type { ChatAccessStatus } from '../context/AppShellContext'

export type ChatAccessBannerAction = 'recharge' | 'retry-ai-config-sync' | 'recheck-billing'

export interface ChatAccessBannerDecision {
  variant: 'info' | 'destructive'
  messageKey: string
  /** Server-provided reset fact (epoch ms); only set for quota-exhausted WITH one. */
  quotaResetAt?: number
  action?: ChatAccessBannerAction
  /** U2: a second, lower-emphasis action (rendered next to `action`). */
  secondaryAction?: ChatAccessBannerAction
}

/** Role gate input mirror of the product-space context projection. */
export interface ChatAccessBannerScope {
  canOpenPayment: boolean
  /** U10: active space kind — personal spaces own their AI service config. */
  isPersonalSpace?: boolean
}

export function decideChatAccessBanner(
  status: ChatAccessStatus | null | undefined,
  scope: ChatAccessBannerScope,
): ChatAccessBannerDecision | null {
  switch (status?.issue) {
    case 'no-ai-service':
      // U10: a personal space has no "admin" to point at — the user configures
      // the service themselves (or the space simply has none yet).
      return scope.isPersonalSpace
        ? { variant: 'info', messageKey: 'noAiService.personalBanner' }
        : { variant: 'info', messageKey: 'chat.statusBanner.noAiService' }
    case 'insufficient-credit':
      // Role split: the handoff exists ONLY where the payer is this user.
      // A member must never see a recharge button that mints someone else's
      // ticket. BOTH variants get the U2 recheck action: the member copy
      // stays honest (an admin recharges) while the latch still yields to
      // the next server answer.
      return scope.canOpenPayment
        ? {
            variant: 'destructive',
            messageKey: 'chat.statusBanner.insufficientCredit',
            action: 'recharge',
            secondaryAction: 'recheck-billing',
          }
        : {
            variant: 'destructive',
            messageKey: 'chat.statusBanner.insufficientCreditMember',
            secondaryAction: 'recheck-billing',
          }
    case 'quota-exhausted':
      // Conditional reset copy: the promise exists only with the server's own
      // reset fact; a plain 429 says the period quota is exhausted and stops.
      // No recheck action: a recharge cannot lift a period quota.
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
