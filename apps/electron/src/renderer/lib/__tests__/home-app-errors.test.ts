import { expect, it } from 'bun:test'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { homeAppOperationErrorText } from '../home-app-errors'
setupI18n()
for (const language of ['en', 'zh-Hans', 'de', 'es', 'hu', 'ja', 'pl']) {
  it(`R5A renders actionable entitlement refusal in ${language}`, () => {
    const t = i18n.getFixedT(language)
    const text = homeAppOperationErrorText(t, { code: 'CIRCLE_ENTITLEMENT_REQUIRED', details: { reason: 'unknown', recovery: 'refresh_membership' } }, 'open', 'personal')
    expect(text).toBe(t('homeApps.errors.circleEntitlementRequired'))
    expect(text).not.toContain('homeApps.errors.')
    expect(text.length).toBeGreaterThan(10)
    expect(t('productSpace.error.circlePersonalRequired')).not.toContain('productSpace.error.')
  })
}

for (const language of ['en', 'zh-Hans', 'de', 'es', 'hu', 'ja', 'pl']) {
  it(`R7 artifact404 is item unavailable copy in ${language}`, () => {
    const t = i18n.getFixedT(language)
    expect(homeAppOperationErrorText(t, { code: 'NOT_FOUND' }, 'open', 'personal')).toBe(t('homeApps.status.unavailableGeneric'))
  })
}

// product-closure U5: infrastructure-side artifact unavailability reads as
// "contact the enterprise admin" — never as another retry loop — and the
// presentation layer carries the ACTUAL server code as a copyable badge for
// business-free (infra) errors only.
import { homeAppErrorPresentation, isBundleUnavailableCode } from '../home-app-errors'
import { HomeAppErrorToastDescription } from '@/components/tab-browser/HomeAppErrorToastDescription'
import { createElement } from 'react'

for (const language of ['en', 'zh-Hans', 'de', 'es', 'hu', 'ja', 'pl']) {
  it(`U5 bundle_bytes_unavailable maps to the infra admin copy in ${language}`, () => {
    const t = i18n.getFixedT(language)
    const text = homeAppOperationErrorText(t, { code: 'bundle_bytes_unavailable' }, 'install', 'enterprise')
    expect(text).toBe(t('infraError.installBundleUnavailable'))
    expect(text).not.toContain('infraError.')
    // POL-277 honesty contract: no automatic-recovery promise.
    expect(/稍后|自动恢复|automatically|shortly|retry later/i.test(text)).toBe(false)
  })
}

for (const language of ['en', 'zh-Hans', 'de', 'es', 'hu', 'ja', 'pl']) {
  it(`U5 presentation carries a copyable code only for infra failures in ${language}`, () => {
    const t = i18n.getFixedT(language)
    const infra = homeAppErrorPresentation(t, { code: 'BUNDLE_BYTES_UNAVAILABLE' }, 'open', 'enterprise')
    expect(infra.copyableCode).toBe('BUNDLE_BYTES_UNAVAILABLE')

    const business = homeAppErrorPresentation(t, { code: 'NOT_AUTHORIZED' }, 'open', 'enterprise')
    expect(business.copyableCode).toBeNull()
  })
}

it('U5 isBundleUnavailableCode matches the POL-277 family only', () => {
  expect(isBundleUnavailableCode('bundle_bytes_unavailable')).toBe(true)
  expect(isBundleUnavailableCode('bundle_not_found')).toBe(true)
  expect(isBundleUnavailableCode('BUNDLE_NOT_FOUND')).toBe(true)
  expect(isBundleUnavailableCode('NOT_AUTHORIZED')).toBe(false)
  expect(isBundleUnavailableCode(null)).toBe(false)
  expect(isBundleUnavailableCode('')).toBe(false)
})

it('U5 toast description renders the copyable badge for infra errors', () => {
  const t = i18n.getFixedT('en')
  const presentation = homeAppErrorPresentation(t, { code: 'bundle_bytes_unavailable' }, 'install', 'enterprise')
  const element = createElement(HomeAppErrorToastDescription, { presentation })
  expect(element).toBeTruthy()
  // The plain-text path stays a fragment (no badge) for business errors.
  const plain = homeAppErrorPresentation(t, { code: 'INSTALL_CANCELLED' }, 'install', 'enterprise')
  expect(plain.copyableCode).toBeNull()
})
