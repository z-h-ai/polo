import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '../../../../..')

function readRepoFile(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8')
}

describe('WebUI Admin session endpoints', () => {
  it('checks /auth/me on app load before fetching protected config', () => {
    const source = readRepoFile('apps/webui/src/App.tsx')

    expect(source).toContain("fetch('/auth/me'")
    expect(source.indexOf("fetch('/auth/me'")).toBeLessThan(source.indexOf("fetch('/api/config'"))
  })

  it('logs out through /auth/logout instead of the legacy endpoint', () => {
    const source = readRepoFile('apps/webui/src/App.tsx')

    expect(source).toContain("fetch('/auth/logout'")
    expect(source).not.toContain("fetch('/api/auth/logout'")
  })

  it('submits the login token to /auth/session instead of the legacy endpoint', () => {
    const source = readRepoFile('apps/webui/src/login.html')

    expect(source).toContain("fetch('/auth/session'")
    expect(source).toContain('JSON.stringify({ token })')
    expect(source).not.toContain("fetch('/api/auth'")
  })
})
