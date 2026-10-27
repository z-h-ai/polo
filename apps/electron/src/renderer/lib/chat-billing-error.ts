/**
 * Journey #1 — localizes KNOWN billing errors on the chat error path.
 *
 * The credential proxy / managed broker mark a blocked balance with the
 * explicit `POLO_INSUFFICIENT_CREDIT:` sentinel (a trusted channel marker,
 * matched verbatim — no English-regex guessing of unknown error text). When
 * such an error lands as a chat error event, the technical raw text no longer
 * becomes the visible bubble: the user sees the localized billing copy, and
 * the raw line moves into the collapsible technical details (errorOriginal).
 * Anything not carrying the sentinel is returned untouched.
 */
import { i18n } from '@polo-ai/shared/i18n'
import type { Message } from '@polo-ai/core/types'

export const POLO_INSUFFICIENT_CREDIT_PREFIX = 'POLO_INSUFFICIENT_CREDIT:'

export interface LocalizedChatBillingError {
  content: string
  errorTitle?: string
  errorOriginal?: string
}

export function isKnownChatBillingErrorText(raw: string): boolean {
  // Pi includes the HTTP status before the proxy's plain-text body. Match
  // that observed wrapper only; a generic 402 is not a Polo balance fact.
  return raw.trimStart().replace(/^402[\t ]+/, '').startsWith(POLO_INSUFFICIENT_CREDIT_PREFIX)
}

export function localizeChatBillingError(raw: string): LocalizedChatBillingError {
  if (!isKnownChatBillingErrorText(raw)) return { content: raw }
  return {
    content: i18n.t('billing.insufficientCredit'),
    errorTitle: i18n.t('chat.billingError.title'),
    errorOriginal: raw,
  }
}

/**
 * Present live typed_error messages and persisted transcripts consistently.
 * Keep stored diagnostics intact and translate at render time so reopening a
 * session (or changing language) does not revive the old English copy/actions.
 * Recharge remains on the existing role- and space-aware payment surface.
 */
export function localizeChatBillingMessage(message: Message): Message {
  if (message.role !== 'error') return message
  const raw = message.errorOriginal ?? message.content
  if (!isKnownChatBillingErrorText(raw)) return message
  return {
    ...message,
    ...localizeChatBillingError(raw),
    errorActions: [],
    errorCanRetry: false,
  }
}
