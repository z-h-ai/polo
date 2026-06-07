import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

function findRepoRoot(startDir: string): string {
  let currentDir = startDir
  while (true) {
    if (existsSync(join(currentDir, 'apps/webui/src/App.tsx'))) {
      return currentDir
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      throw new Error('Could not locate repository root')
    }
    currentDir = parentDir
  }
}

const REPO_ROOT = findRepoRoot(import.meta.dir)

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

  it('submits credentials to /auth/login instead of exposing the Admin token to the browser', () => {
    // The login page is now a React app — the auth logic lives in login-logic.ts
    const source = readRepoFile('apps/webui/src/login-logic.ts')

    expect(source).toContain("fetch('/auth/login'")
    expect(source).toContain('JSON.stringify({ username, password })')
    expect(source).not.toContain("fetch('/auth/session'")
    expect(source).not.toContain('JSON.stringify({ token })')
    expect(source).not.toContain("fetch('/api/auth'")
  })
})
