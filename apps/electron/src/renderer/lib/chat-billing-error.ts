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

export const POLO_INSUFFICIENT_CREDIT_PREFIX = 'POLO_INSUFFICIENT_CREDIT:'

export interface LocalizedChatBillingError {
  content: string
  errorTitle?: string
  errorOriginal?: string
}

export function isKnownChatBillingErrorText(raw: string): boolean {
  return raw.trimStart().startsWith(POLO_INSUFFICIENT_CREDIT_PREFIX)
}

export function localizeChatBillingError(raw: string): LocalizedChatBillingError {
  if (!isKnownChatBillingErrorText(raw)) return { content: raw }
  return {
    content: i18n.t('billing.insufficientCredit'),
    errorTitle: i18n.t('chat.billingError.title'),
    errorOriginal: raw,
  }
}
