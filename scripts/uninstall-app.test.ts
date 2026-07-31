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
  const fakeBin = join(home, '.test-bin')
  mkdirSync(fakeBin, { recursive: true })
  writeFileSync(join(fakeBin, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n', { mode: 0o755 })
  return home
}

function linuxEnv(home: string): Record<string, string> {
  return {
    ...process.env,
    HOME: home,
    PATH: `${join(home, '.test-bin')}:${process.env.PATH ?? ''}`,
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('macOS/Linux terminal cleanup', () => {
  it('does not infer launcher ownership from a copied marker', () => {
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
      env: linuxEnv(home),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(existsSync(polo)).toBe(true)
    expect(existsSync(legacy)).toBe(true)
    expect(result.stderr.toString()).toContain('ownership state and its verifier are unavailable')
    expect(readFileSync(profile, 'utf8')).toContain('export EDITOR=vim')
    expect(readFileSync(profile, 'utf8')).not.toContain('# >>> Polo CLI >>>')
    expect(readdirSync(home).some((name) => name.startsWith('.zprofile.polo-backup-'))).toBe(true)
  })

  it('preserves an unrelated polo command', () => {
    const home = createHome()
    const polo = join(home, '.local', 'bin', 'polo')
    writeFileSync(polo, '#!/bin/sh\necho unrelated\n')

    const result = Bun.spawnSync(['bash', script], {
      env: linuxEnv(home),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(readFileSync(polo, 'utf8')).toContain('unrelated')
    expect(result.stderr.toString()).toContain('ownership state and its verifier are unavailable')
  })

  it('removes the managed block from Bash login fallback files', () => {
    const home = createHome()
    const bashLogin = join(home, '.bash_login')
    writeFileSync(
      bashLogin,
      'export LANG=en_US.UTF-8\n# >>> Polo CLI >>>\n'
        + 'export PATH="$HOME/.local/bin:$PATH"\n# <<< Polo CLI <<<\n',
    )

    const result = Bun.spawnSync(['bash', script], {
      env: linuxEnv(home),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(result.exitCode).toBe(0)
    expect(readFileSync(bashLogin, 'utf8')).toContain('export LANG=en_US.UTF-8')
    expect(readFileSync(bashLogin, 'utf8')).not.toContain('# >>> Polo CLI >>>')
  })
})
