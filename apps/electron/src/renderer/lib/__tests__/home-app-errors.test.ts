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
