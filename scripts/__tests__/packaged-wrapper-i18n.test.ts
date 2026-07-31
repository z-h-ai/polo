import { describe, expect, it } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..')
const read = (relative: string) => readFileSync(join(root, relative), 'utf8')

describe('packaged wrapper locale table', () => {
  it('generates both launcher message tables from the locale catalogs', () => {
    const generated = [
      read('apps/electron/resources/bin/polo-messages.sh'),
      read('apps/electron/resources/bin/polo-messages.cmd'),
    ]
    for (const locale of ['en', 'de', 'es', 'hu', 'ja', 'pl', 'zh-Hans']) {
      const catalog = JSON.parse(
        read(`packages/shared/src/i18n/locales/${locale}.json`),
      ) as Record<string, string>
      for (const key of [
        'cli.bundledRuntimeMissing',
        'cli.terminalFilesMissing',
        'cli.deprecatedCommand',
      ]) {
        expect(generated[1]).toContain(catalog[key]!)
      }
    }
    const check = Bun.spawnSync(
      [process.execPath, 'run', join(root, 'scripts/generate-wrapper-messages.ts'), '--check'],
      { stdout: 'pipe', stderr: 'pipe' },
    )
    expect(check.exitCode).toBe(0)
    const unix = read('apps/electron/resources/bin/polo')
    const windows = read('apps/electron/resources/bin/polo.cmd')
    expect(unix).toContain('polo-messages.sh')
    expect(windows).toContain('polo-messages.cmd')
    expect(unix).not.toContain('Polo 内置运行时缺失')
    expect(windows).not.toContain('Polo 内置运行时缺失')
  })

  it('executes the canonical Unix wrapper with every supported locale', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'polo wrapper locales 空格-'))
    const wrapperPath = join(fixture, 'app', 'resources', 'bin', 'polo')
    mkdirSync(join(fixture, 'app', 'resources', 'bin'), { recursive: true })
    copyFileSync(join(root, 'apps/electron/resources/bin/polo'), wrapperPath)
    copyFileSync(
      join(root, 'apps/electron/resources/bin/polo-messages.sh'),
      join(fixture, 'app', 'resources', 'bin', 'polo-messages.sh'),
    )
    chmodSync(wrapperPath, 0o755)

    const expectedByLocale = {
      de_DE: 'Die gebündelte Polo-Laufzeit fehlt',
      en_US: "Polo's bundled runtime is missing",
      es_ES: 'Falta el entorno de ejecución incluido de Polo',
      hu_HU: 'A Polo beépített futtatókörnyezete hiányzik',
      ja_JP: 'Polo の内蔵ランタイムがありません',
      pl_PL: 'Brakuje dołączonego środowiska uruchomieniowego Polo',
      zh_CN: 'Polo 内置运行时缺失',
    }

    try {
      for (const [locale, expected] of Object.entries(expectedByLocale)) {
        const result = Bun.spawnSync([wrapperPath, '--version'], {
          env: { ...process.env, POLO_AI_LOCALE: locale },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(result.exitCode).toBe(1)
        expect(result.stderr.toString()).toContain('POLO_E_BUNDLED_RUNTIME_MISSING')
        expect(result.stderr.toString()).toContain(expected)
      }
    }
    finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })

  it('localizes both compatibility shims and the generated Windows launchers', () => {
    for (const wrapper of [
      'apps/electron/resources/bin/polo-ai',
      'apps/electron/resources/bin/polo-ai.cmd',
    ]) {
      const content = read(wrapper)
      expect(content).toContain('POLO_AI_DEPRECATED_SHIM')
      expect(content).not.toContain('已弃用')
      expect(content).not.toContain("deprecated; use 'polo'")
    }
    const generated = read(
      'apps/electron/resources/scripts/windows-terminal-integration.ps1',
    )
    expect(generated).toContain('$messageTemplate')
    expect(generated).toContain('bin\\polo-messages.cmd')
  })
})
