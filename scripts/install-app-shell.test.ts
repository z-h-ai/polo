import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const roots: string[] = []
const installer = readFileSync(join(import.meta.dir, 'install-app.sh'), 'utf8')
const helpers = installer.slice(0, installer.indexOf('# Detect OS'))

function createHome(): string {
  const home = join(tmpdir(), `polo-installer-shell-${crypto.randomUUID()}`)
  roots.push(home)
  mkdirSync(home, { recursive: true })
  return home
}

function configurePath(home: string, shell = '/bin/bash'): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(['bash', '-c', `${helpers}\nconfigure_managed_path`], {
    env: { ...process.env, HOME: home, SHELL: shell },
    stdout: 'pipe',
    stderr: 'pipe',
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Linux shell PATH setup', () => {
  it('updates an existing .bash_profile instead of an ignored .profile', () => {
    const home = createHome()
    const bashProfile = join(home, '.bash_profile')
    writeFileSync(bashProfile, 'export EDITOR=vim\n')

    const first = configurePath(home)
    const second = configurePath(home)

    expect(first.exitCode).toBe(0)
    expect(second.exitCode).toBe(0)
    const content = readFileSync(bashProfile, 'utf8')
    expect(content).toContain('export EDITOR=vim')
    expect(content.match(/# >>> Polo CLI >>>/g)).toHaveLength(1)
    expect(existsSync(join(home, '.profile'))).toBe(false)
  })

  it('honors Bash login-file precedence when .bash_login exists', () => {
    const home = createHome()
    const bashLogin = join(home, '.bash_login')
    writeFileSync(bashLogin, 'export LANG=en_US.UTF-8\n')

    const result = configurePath(home)

    expect(result.exitCode).toBe(0)
    expect(readFileSync(bashLogin, 'utf8')).toContain('# >>> Polo CLI >>>')
    expect(existsSync(join(home, '.profile'))).toBe(false)
  })
})
