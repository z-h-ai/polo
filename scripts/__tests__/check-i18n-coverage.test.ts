import { describe, expect, it } from 'bun:test'
import {
  collectLiteralTranslationReferences,
  translationKeyExists,
} from '../check-i18n-coverage'

describe('check-i18n-coverage', () => {
  it('collects supported literal callsites and skips dynamic keys', () => {
    const references = collectLiteralTranslationReferences(`
      t('common.save')
      i18n.t("errors.network")
      t(\`status.\${status}\`)
      <Trans i18nKey="dialog.body" />
      <Trans i18nKey={'dialog.title'} />
    `, 'example.tsx')

    expect(references.map(reference => reference.key).sort()).toEqual([
      'common.save',
      'dialog.body',
      'dialog.title',
      'errors.network',
    ])
  })

  it('recognizes direct keys and complete i18next plural pairs', () => {
    const messages = {
      'common.save': 'Save',
      'items_one': '{{count}} item',
      'items_other': '{{count}} items',
      'partial_one': 'one',
    }

    expect(translationKeyExists('common.save', messages)).toBe(true)
    expect(translationKeyExists('items', messages)).toBe(true)
    expect(translationKeyExists('partial', messages)).toBe(false)
    expect(translationKeyExists('missing', messages)).toBe(false)
  })
})
