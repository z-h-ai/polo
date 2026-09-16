import { describe, expect, it } from 'bun:test'
import {
  BOOTSTRAP_VERSION,
  evaluateReleasePreflight,
  parseReleaseContract,
  type ReleaseContract,
} from './electron-release-contract'

const sha = 'a'.repeat(40)

function contract(version = '0.15.2'): ReleaseContract {
  return {
    schemaVersion: 2,
    repository: 'polo/polo',
    tag: `v${version}`,
    version,
    commitSha: 'b'.repeat(40),
    publishedAt: '2026-08-07T12:00:00.000Z',
    artifacts: {
      macosZip: { fileName: 'Polo-AI-x64.zip', sha256: '1'.repeat(64) },
      macosX64Dmg: { fileName: 'Polo-AI-x64.dmg', sha256: '2'.repeat(64) },
      macosArm64Dmg: { fileName: 'Polo-AI-arm64.dmg', sha256: '3'.repeat(64) },
      linuxAppImage: { fileName: 'Polo-AI-x64.AppImage', sha256: '3'.repeat(64) },
      windowsExe: { fileName: 'Polo-AI-x64.exe', sha256: '4'.repeat(64) },
    },
    installApp: { fileName: 'install-app.sh', sha256: '5'.repeat(64) },
  }
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    repository: 'polo/polo',
    tag: `v${BOOTSTRAP_VERSION}`,
    commitSha: sha,
    tagCommitSha: sha,
    rootVersion: BOOTSTRAP_VERSION,
    electronVersion: BOOTSTRAP_VERSION,
    ...overrides,
  }
}

describe('release contract', () => {
  it('accepts the complete desktop release schema', () => {
    expect(parseReleaseContract(contract())).toEqual(contract())
  })

  it('continues to parse the v1 public predecessor contract', () => {
    const legacy = contract() as Record<string, unknown>
    legacy.schemaVersion = 1
    const artifacts = legacy.artifacts as Record<string, unknown>
    delete artifacts.macosX64Dmg
    delete artifacts.macosArm64Dmg
    delete artifacts.windowsExe
    expect(parseReleaseContract(legacy).schemaVersion).toBe(1)
  })

  it('rejects schema drift and unsafe artifact names', () => {
    expect(() => parseReleaseContract({ ...contract(), extra: true })).toThrow('unexpected fields')
    const unsafe = contract()
    unsafe.artifacts.macosZip.fileName = '../Polo-AI-x64.zip'
    expect(() => parseReleaseContract(unsafe)).toThrow('unsafe')
  })
})

describe('release preflight', () => {
  it('allows only v0.15.2 to bootstrap without an online contract', () => {
    expect(evaluateReleasePreflight(input())).toEqual({
      bootstrap: true,
      version: BOOTSTRAP_VERSION,
    })
    expect(() => evaluateReleasePreflight(input({
      tag: 'v0.15.3', rootVersion: '0.15.3', electronVersion: '0.15.3',
    }))).toThrow('Only v0.15.2')
  })

  it('requires tag, package versions, and commit to match', () => {
    expect(() => evaluateReleasePreflight(input({ electronVersion: '0.15.1' }))).toThrow('Version mismatch')
    expect(() => evaluateReleasePreflight(input({ tagCommitSha: 'c'.repeat(40) }))).toThrow('does not point')
    expect(() => evaluateReleasePreflight(input({ tag: '0.15.2' }))).toThrow('strict SemVer')
  })

  it('requires a version newer than the online contract', () => {
    expect(evaluateReleasePreflight(input({
      tag: 'v0.15.3', rootVersion: '0.15.3', electronVersion: '0.15.3',
      onlineContract: contract(),
    })).bootstrap).toBe(false)
    expect(() => evaluateReleasePreflight(input({ onlineContract: contract() }))).toThrow('must be greater')
  })
})
