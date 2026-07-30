import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const script = join(import.meta.dir, 'uninstall-app.sh')

function createHome(): string {
  const home = join(tmpdir(), `polo-uninstall-test-${crypto.randomUUID()}`)
  roots.push(home)
  mkdirSync(join(home, '.local', 'bin'), { recursive: true })
  return home
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('macOS/Linux terminal cleanup', () => {
  it('removes only Polo-managed launchers and profile blocks', () => {
    const home = createHome()
    const polo = join(home, '.local', 'bin', 'polo')
    const legacy = join(home, '.local', 'bin', 'polo-ai')
    const profile = join(home, '.zprofile')
    writeFileSync(polo, '#!/bin/sh\n# Polo CLI launcher (managed by Polo AI)\n')
    writeFileSync(legacy, "#!/bin/sh\necho \"deprecated; use 'polo'\"\n")
    writeFileSync(
      profile,
      'export EDITOR=vim\n# >>> Polo CLI >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< Polo CLI <<<\n',
    )

    const result = Bun.spawnSync(['bash', script], {
      env: { ...process.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(existsSync(polo)).toBe(false)
    expect(existsSync(legacy)).toBe(false)
    expect(readFileSync(profile, 'utf8')).toContain('export EDITOR=vim')
    expect(readFileSync(profile, 'utf8')).not.toContain('# >>> Polo CLI >>>')
    expect(readdirSync(home).some((name) => name.startsWith('.zprofile.polo-backup-'))).toBe(true)
  })

  it('preserves an unrelated polo command', () => {
    const home = createHome()
    const polo = join(home, '.local', 'bin', 'polo')
    writeFileSync(polo, '#!/bin/sh\necho unrelated\n')

    const result = Bun.spawnSync(['bash', script], {
      env: { ...process.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(readFileSync(polo, 'utf8')).toContain('unrelated')
    expect(result.stderr.toString()).toContain('Left non-Polo file unchanged')
  })
})
