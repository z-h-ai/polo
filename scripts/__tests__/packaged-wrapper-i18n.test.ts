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
  it('keeps stable localized runtime and terminal-file failures in both launchers', () => {
    for (const wrapper of [
      'apps/electron/resources/bin/polo',
      'apps/electron/resources/bin/polo.cmd',
    ]) {
      const content = read(wrapper)
      expect(content).toContain('POLO_E_BUNDLED_RUNTIME_MISSING')
      expect(content).toContain('POLO_E_TERMINAL_FILES_MISSING')
      expect(content).toContain('Polo 内置运行时缺失')
      expect(content).toContain('Polo 终端文件缺失')
      expect(content).toContain("Polo's bundled runtime is missing")
      expect(content).toContain('Polo terminal files are missing')
    }
  })

  it('executes the canonical Unix wrapper with every supported locale', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'polo wrapper locales 空格-'))
    const wrapperPath = join(fixture, 'app', 'resources', 'bin', 'polo')
    mkdirSync(join(fixture, 'app', 'resources', 'bin'), { recursive: true })
    copyFileSync(join(root, 'apps/electron/resources/bin/polo'), wrapperPath)
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
      expect(content).toContain('POLO_W_DEPRECATED_COMMAND')
      expect(content).toContain('已弃用')
      expect(content).toContain("deprecated; use 'polo'")
    }
    const generated = read(
      'apps/electron/resources/scripts/windows-terminal-integration.ps1',
    )
    expect(generated).toContain('POLO_E_BUNDLED_RUNTIME_MISSING')
    expect(generated).toContain('POLO_E_TERMINAL_FILES_MISSING')
    expect(generated).toContain('POLO_W_DEPRECATED_COMMAND')
    expect(generated).toContain('Polo 内置运行时缺失')
  })
})
