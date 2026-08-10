import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VERSION_FILES,
  checkReleaseVersion,
  setReleaseVersion,
} from './release-version'

const roots: string[] = []
const targetVersion = '1.2.3'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'polo-release-version-'))
  roots.push(root)
  for (const relativePath of VERSION_FILES) {
    const path = join(root, relativePath)
    const directory = path.slice(0, path.lastIndexOf('/'))
    if (directory !== root) mkdirSync(directory, { recursive: true })
    writeFileSync(path, JSON.stringify({ name: relativePath, version: '0.1.0', private: true }, null, 2) + '\n')
  }
  mkdirSync(join(root, 'packages', 'core'), { recursive: true })
  writeFileSync(join(root, 'packages', 'core', 'package.json'), '{"name":"@polo-ai/core","version":"9.9.9"}\n')
  writeFileSync(join(root, 'bun.lock'), `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "polo-ai",
      "version": "0.1.0",
    },
    "apps/cli": {
      "name": "@polo-ai/cli",
      "version": "0.1.0",
    },
    "apps/electron": {
      "name": "@polo-ai/electron",
      "version": "0.1.0",
    },
    "packages/server": {
      "name": "@polo-ai/server",
      "version": "0.1.0",
    },
  },
}\n`)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('release version commands', () => {
  it('synchronizes the four release packages and the lockfile without touching other packages', () => {
    const root = fixture()
    const untouched = readFileSync(join(root, 'packages/core/package.json'), 'utf8')
    setReleaseVersion(root, `v${targetVersion}`, {
      refreshLockfile: () => undefined,
    })

    for (const relativePath of VERSION_FILES) {
      expect(JSON.parse(readFileSync(join(root, relativePath), 'utf8')).version).toBe(targetVersion)
    }
    expect(readFileSync(join(root, 'packages/core/package.json'), 'utf8')).toBe(untouched)
    expect(() => checkReleaseVersion(root, `v${targetVersion}`)).not.toThrow()
  })

  it('rejects malformed requested versions before changing files', () => {
    const root = fixture()
    const before = VERSION_FILES.map((path) => readFileSync(join(root, path), 'utf8'))
    expect(() => setReleaseVersion(root, 'v1.02.3', { refreshLockfile: () => undefined })).toThrow('Invalid strict SemVer')
    expect(VERSION_FILES.map((path) => readFileSync(join(root, path), 'utf8'))).toEqual(before)
  })

  it('rejects a single package drift during check', () => {
    const root = fixture()
    writeFileSync(join(root, 'apps/cli/package.json'), '{"name":"cli","version":"1.2.4"}\n')
    expect(() => checkReleaseVersion(root, `v${targetVersion}`)).toThrow('Version mismatch')
  })

  it('rolls back package and lockfile changes when lockfile refresh fails', () => {
    const root = fixture()
    const beforePackages = VERSION_FILES.map((path) => readFileSync(join(root, path), 'utf8'))
    const beforeLockfile = readFileSync(join(root, 'bun.lock'), 'utf8')
    expect(() => setReleaseVersion(root, `v${targetVersion}`, {
      refreshLockfile: (cwd) => {
        writeFileSync(join(cwd, 'bun.lock'), 'partially-written-lockfile')
        throw new Error('simulated bun failure')
      },
    })).toThrow('simulated bun failure')
    expect(VERSION_FILES.map((path) => readFileSync(join(root, path), 'utf8'))).toEqual(beforePackages)
    expect(readFileSync(join(root, 'bun.lock'), 'utf8')).toBe(beforeLockfile)
  })
})
