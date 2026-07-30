import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
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
