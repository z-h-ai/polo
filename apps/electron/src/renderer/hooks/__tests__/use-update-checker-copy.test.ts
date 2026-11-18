/**
 * Focused coverage for the update-failure copy mapping (ux-error-feedback).
 *
 * Known network-shaped errors must map to the "check your connection"
 * guidance; anything unknown must degrade to the generic retry-later copy —
 * never leak the raw error message into toast text.
 */
import { describe, expect, it } from 'bun:test'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { classifyUpdateFailure } from '../useUpdateChecker'

setupI18n()

describe('classifyUpdateFailure — network errors map to the connection hint', () => {
  const networkMessages = [
    'Fetch failed: getaddrinfo ENOTFOUND updates.example.com',
    'Error: socket hang up',
    'request timed out after 30000ms',
    'ECONNREFUSED 127.0.0.1:443',
    'network connection lost',
  ]

  for (const action of ['check', 'install'] as const) {
    for (const message of networkMessages) {
      it(`${action}: "${message}" → updateNetworkFailedDesc`, () => {
        const copy = classifyUpdateFailure(new Error(message), action)
        expect(copy.isNetwork).toBe(true)
        expect(copy.descKey).toBe('toast.updateNetworkFailedDesc')
        expect(copy.titleKey).toBe(action === 'check' ? 'toast.failedToCheckUpdates' : 'toast.failedToInstallUpdate')
        expect(i18n.t(copy.descKey)).not.toContain('toast.updateNetworkFailedDesc')
      })
    }
  }
})

describe('classifyUpdateFailure — unknown errors degrade to generic retry copy', () => {
  it('check failure → updateCheckFailedDesc', () => {
    const copy = classifyUpdateFailure(new Error('EACCES: permission denied'), 'check')
    expect(copy.isNetwork).toBe(false)
    expect(copy.descKey).toBe('toast.updateCheckFailedDesc')
    expect(copy.titleKey).toBe('toast.failedToCheckUpdates')
  })

  it('install failure → updateInstallFailedDesc', () => {
    const copy = classifyUpdateFailure(new Error(' Signature verification failed'), 'install')
    expect(copy.isNetwork).toBe(false)
    expect(copy.descKey).toBe('toast.updateInstallFailedDesc')
    expect(copy.titleKey).toBe('toast.failedToInstallUpdate')
  })

  it('non-Error rejections are handled too', () => {
    const copy = classifyUpdateFailure('some plain rejection', 'check')
    expect(copy.titleKey).toBe('toast.failedToCheckUpdates')
    expect(copy.descKey).toBe('toast.updateCheckFailedDesc')
  })
})

describe('classifyUpdateFailure — copy keys resolve in every locale', () => {
  for (const language of ['en', 'zh-Hans', 'de', 'es', 'hu', 'ja', 'pl']) {
    it(`${language}: toast copy exists and never leaks a key`, () => {
      const t = i18n.getFixedT(language)
      for (const key of [
        'toast.failedToCheckUpdates',
        'toast.failedToInstallUpdate',
        'toast.updateNetworkFailedDesc',
        'toast.updateCheckFailedDesc',
        'toast.updateInstallFailedDesc',
      ]) {
        const value = t(key)
        expect(value).not.toBe(key)
        expect(value.length).toBeGreaterThan(5)
      }
    })
  }
})
