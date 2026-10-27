import { expect, it } from 'bun:test'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { POLO_APP_ID, KNOWLEDGE_BASE_APP_ID } from '../../../shared/tab-browser-types'
import { localizedAppName, localizedTabTitle } from '../tab-display-name'

setupI18n()

const LANGUAGES = ['en', 'zh-Hans', 'de', 'es', 'hu', 'ja', 'pl']

// product-closure U7 (LV-E02): a tab restored from an OLD snapshot carries the
// zh-Hans literal as `title` — the id override must replace it in EVERY
// language, and the built-in names must follow language switches.
for (const language of LANGUAGES) {
  it(`U7 zh-Hans literal title is overridden by id in ${language}`, () => {
    const t = i18n.getFixedT(language)
    const legacyPolo = { appId: POLO_APP_ID, title: 'Polo 助手', type: 'polo' as const }
    const legacyKb = { appId: KNOWLEDGE_BASE_APP_ID, title: '企业知识库', type: 'knowledge-base' as const }

    expect(localizedTabTitle(legacyPolo, t)).toBe(t('tabName.poloAssistant'))
    expect(localizedTabTitle(legacyKb, t)).toBe(t('tabName.knowledgeBase'))
    expect(t('tabName.poloAssistant')).not.toContain('tabName.')
  })
}

for (const language of LANGUAGES) {
  it(`U7 type-based fallbacks override stale titles in ${language}`, () => {
    const t = i18n.getFixedT(language)
    const poloByType = { appId: 'third-party', title: 'Polo 助手', type: 'polo' as const }
    const kbByType = { appId: 'third-party', title: '企业知识库', type: 'knowledge-base' as const }

    expect(localizedTabTitle(poloByType, t)).toBe(t('tabName.poloAssistant'))
    expect(localizedTabTitle(kbByType, t)).toBe(t('tabName.knowledgeBase'))
  })
}

it('U7 third-party / custom names are never rewritten', () => {
  const t = i18n.getFixedT('zh-Hans')
  const thirdParty = { appId: 'acme-dashboard', title: 'Acme 看板', type: 'webapp' as const }
  const customNamed = { appId: 'acme-dashboard', title: '我的工具', type: 'webapp' as const }

  expect(localizedTabTitle(thirdParty, t)).toBe('Acme 看板')
  expect(localizedTabTitle(customNamed, t)).toBe('我的工具')
})

it('U7 built-in app definitions resolve at render time per language', () => {
  const zh = i18n.getFixedT('zh-Hans')
  const en = i18n.getFixedT('en')

  expect(localizedAppName({ id: POLO_APP_ID, name: 'Polo 助手' }, zh)).toBe(zh('tabName.poloAssistant'))
  expect(localizedAppName({ id: POLO_APP_ID, name: 'Polo 助手' }, en)).toBe('Polo Assistant')
  expect(localizedAppName({ id: KNOWLEDGE_BASE_APP_ID, name: '企业知识库' }, en)).toBe(en('tabName.knowledgeBase'))
  expect(localizedAppName({ id: 'acme', name: 'Acme App' }, en)).toBe('Acme App')
})
