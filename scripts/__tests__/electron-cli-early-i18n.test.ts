import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('Electron --polo-cli early error localization', () => {
  it('does not call i18next during module evaluation', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', '..', 'apps', 'electron', 'src', 'main', 'index.ts'),
      'utf8',
    )
    const start = source.indexOf("const poloCliArgIndex = process.argv.indexOf('--polo-cli')")
    const end = source.indexOf('// Register Pi model resolver', start)
    const earlyBranch = source.slice(start, end)

    expect(start).toBeGreaterThan(0)
    expect(earlyBranch).toContain('translateRegistryMessage')
    expect(earlyBranch).toContain('Intl.DateTimeFormat().resolvedOptions().locale')
    expect(earlyBranch).not.toContain('i18n.t(')
    expect(source).not.toContain('electronLocaleToSupportedLanguage')
  })
})
