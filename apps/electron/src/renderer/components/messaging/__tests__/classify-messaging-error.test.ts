/**
 * Focused coverage for the pairing-error classifier (ux-error-feedback).
 *
 * Known failure shapes map to localized copy; unknown failures degrade to the
 * generic dialog copy — the raw error message must never reach the dialog.
 */
import { describe, expect, it } from 'bun:test'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { classifyMessagingError } from '../MessagingSessionMenuItem'

setupI18n()

const NOT_CONNECTED_MESSAGES = [
  'platform not connected',
  'no adapter registered for platform',
  'telegram not configured',
]

describe('classifyMessagingError — known failure shapes map to localized copy', () => {
  for (const message of NOT_CONNECTED_MESSAGES) {
    it(`not-connected: "${message}" → toast.messagingNotConfigured`, () => {
      for (const language of ['en', 'zh-Hans']) {
        const t = i18n.getFixedT(language)
        const copy = classifyMessagingError(new Error(message), t)
        expect(copy).toBe(t('toast.messagingNotConfigured'))
        expect(copy).not.toContain(message)
      }
    })
  }

  it('rate limit → toast.messagingRateLimited', () => {
    for (const language of ['en', 'zh-Hans']) {
      const t = i18n.getFixedT(language)
      const copy = classifyMessagingError(new Error('rate limit exceeded (429)'), t)
      expect(copy).toBe(t('toast.messagingRateLimited'))
    }
  })
})

describe('classifyMessagingError — unknown failures degrade to generic copy', () => {
  it('raw message is replaced by dialog.pairingCode.error.generic', () => {
    for (const language of ['en', 'zh-Hans', 'de', 'es', 'hu', 'ja', 'pl']) {
      const t = i18n.getFixedT(language)
      const copy = classifyMessagingError(new Error('E_INTERNAL_RAMBLE stack trace here'), t)
      expect(copy).toBe(t('dialog.pairingCode.error.generic'))
      expect(copy).not.toContain('E_INTERNAL_RAMBLE')
    }
  })

  it('non-Error rejections are classified too', () => {
    const t = i18n.getFixedT('en')
    expect(classifyMessagingError('boom', t)).toBe(t('dialog.pairingCode.error.generic'))
  })
})
