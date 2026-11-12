/**
 * Focus tests: chat-input feedback copy i18n contract.
 *
 * Three UX copy fixes must stay available in ALL 7 locales:
 *  - chat.attachments.storeFailedWarning: the send-time warning card for
 *    attachments that could not be stored on disk ({{count}} + {{names}});
 *    previously a hardcoded English string inside App.tsx.
 *  - chatInput.pasteConvertedToFile: the sonner heads-up when a >100-line
 *    paste is converted into a .txt attachment ({{name}}).
 *  - The @ capability description trio (placeholder, @ menu header, slash
 *    menu footer) must describe the SAME capability set — files, folders,
 *    skills, data sources — instead of three divergent lists.
 * Project-session asset mentions have their own copy (AssetMentionPopover)
 * and are intentionally out of scope here.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'

const LOCALES_DIR = join(import.meta.dir, '../../../../../packages/shared/src/i18n/locales')
const localeFiles = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json')).sort()

const locales: Record<string, Record<string, string>> = {}
for (const file of localeFiles) {
  locales[file.replace('.json', '')] = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf-8'))
}

const WARNING_KEY = 'chat.attachments.storeFailedWarning'
const PASTE_KEY = 'chatInput.pasteConvertedToFile'
const DESCRIPTION_KEYS = [
  'chatInput.placeholder.mention',   // composer placeholder rotation
  'chat.mentionFilesSkillsSources',  // @ menu header
  'commands.useAtMentionHint',       // slash menu footer
] as const

beforeAll(() => { setupI18n() })

describe('attachment store-failed warning copy', () => {
  it('exists in every locale with {{count}} and {{names}} interpolation', () => {
    for (const [lang, translations] of Object.entries(locales)) {
      const value = translations[WARNING_KEY]
      expect(value, `[${lang}] missing ${WARNING_KEY}`).toBeDefined()
      expect(value).toContain('{{count}}')
      expect(value).toContain('{{names}}')
    }
  })

  it('resolves through i18n with count and names (plural-safe base key)', async () => {
    await i18n.changeLanguage('en')
    const one = i18n.t(WARNING_KEY, { count: 1, names: 'a.txt' }) as string
    const two = i18n.t(WARNING_KEY, { count: 2, names: 'a.txt, b.md' }) as string
    expect(one).toContain('a.txt')
    expect(one).toContain('1')
    expect(two).toContain('a.txt, b.md')
    expect(one).not.toContain('{{count}}')
    expect(one).not.toContain('{{names}}')
  })

  it('tells the user the next step (re-add and send again)', () => {
    // Plain-language next step, no bare technical failure text.
    expect(locales['en'][WARNING_KEY].toLowerCase()).toContain('re-add')
    expect(locales['zh-Hans'][WARNING_KEY]).toContain('重新添加')
  })
})

describe('paste-to-attachment heads-up copy', () => {
  it('exists in every locale with {{name}} interpolation', () => {
    for (const [lang, translations] of Object.entries(locales)) {
      const value = translations[PASTE_KEY]
      expect(value).toBeDefined()
      expect(value).toContain('{{name}}')
    }
  })

  it('explains the text becomes a file attachment, not message body', () => {
    expect(locales['zh-Hans'][PASTE_KEY]).toContain('附件')
    expect(locales['en'][PASTE_KEY]).toContain('attachment')
  })
})

describe('@ capability description trio stays unified', () => {
  it('all three keys exist in every locale', () => {
    for (const [lang, translations] of Object.entries(locales)) {
      for (const key of DESCRIPTION_KEYS) {
        expect(translations[key]).toBeDefined()
      }
    }
  })

  it('every phrasing lists the SAME capability set (files, folders, skills, data sources)', () => {
    const enValues = DESCRIPTION_KEYS.map(k => locales['en'][k])
    for (const value of enValues) {
      expect(value).toContain('files')
      expect(value).toContain('folders')
      expect(value).toContain('skills')
      expect(value).toContain('data sources')
    }
    const zhValues = DESCRIPTION_KEYS.map(k => locales['zh-Hans'][k])
    for (const value of zhValues) {
      expect(value).toContain('文件')
      expect(value).toContain('文件夹')
      expect(value).toContain('技能')
      expect(value).toContain('数据源')
    }
  })
})
