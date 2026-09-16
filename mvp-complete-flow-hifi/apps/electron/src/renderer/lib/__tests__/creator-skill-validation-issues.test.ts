import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { translateCreatorSkillValidationIssue } from '../creator-skill-validation-issues'

beforeAll(async () => {
  setupI18n()
  await i18n.changeLanguage('es')
})

afterAll(async () => {
  await i18n.changeLanguage('en')
})

describe('Creator Skill validation issue translation', () => {
  it('renders a localized stable issue code', () => {
    const translated = translateCreatorSkillValidationIssue(i18n.t, 'path_traversal')

    expect(translated).toContain('recorrido')
  })

  it('uses a localized fallback for unknown backend codes', () => {
    expect(translateCreatorSkillValidationIssue(i18n.t, 'future_backend_issue'))
      .toBe(i18n.t('creatorSkills.validation.issue.unknown'))
  })
})
