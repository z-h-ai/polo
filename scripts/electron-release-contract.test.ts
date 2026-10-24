import { describe, expect, it } from 'bun:test'
import {
  BOOTSTRAP_VERSIONS,
  RELEASE_CONTRACT_SCHEMA_VERSION,
  evaluateReleasePreflight,
  parseReleaseContract,
  type ReleaseContract,
} from './electron-release-contract'

const sha = 'a'.repeat(40)

function contract(version = '0.15.2'): ReleaseContract {
  return {
    schemaVersion: RELEASE_CONTRACT_SCHEMA_VERSION,
    repository: 'polo/polo',
    tag: `v${version}`,
    version,
    commitSha: 'b'.repeat(40),
    publishedAt: '2026-08-07T12:00:00.000Z',
    artifacts: {
      macosZip: { fileName: 'Polo-AI-x64.zip', sha256: '1'.repeat(64) },
      macosArm64Zip: { fileName: 'Polo-AI-arm64.zip', sha256: '6'.repeat(64) },
      macosX64Dmg: { fileName: 'Polo-AI-x64.dmg', sha256: '2'.repeat(64) },
      macosArm64Dmg: { fileName: 'Polo-AI-arm64.dmg', sha256: '3'.repeat(64) },
      linuxAppImage: { fileName: 'Polo-AI-x64.AppImage', sha256: '3'.repeat(64) },
      windowsExe: { fileName: 'Polo-AI-x64.exe', sha256: '4'.repeat(64) },
    },
    installApp: { fileName: 'install-app.sh', sha256: '5'.repeat(64) },
  }
}

// The currently online predecessor still publishes schema 2 (POL-268 ships
// schema 3), so parsing it must keep working until the first schema-3
// release is live.
function previousSchemaContract(version = '0.15.2'): Record<string, unknown> {
  const value = contract(version) as Record<string, unknown>
  value.schemaVersion = 2
  const artifacts = value.artifacts as Record<string, unknown>
  delete artifacts.macosArm64Zip
  return value
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    repository: 'polo/polo',
    tag: `v${BOOTSTRAP_VERSIONS[0]}`,
    commitSha: sha,
    tagCommitSha: sha,
    rootVersion: BOOTSTRAP_VERSIONS[0],
    electronVersion: BOOTSTRAP_VERSIONS[0],
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
    delete artifacts.macosArm64Zip
    delete artifacts.macosArm64Dmg
    delete artifacts.windowsExe
    expect(parseReleaseContract(legacy).schemaVersion).toBe(1)
  })

  it('continues to parse the schema-2 online predecessor without the arm64 ZIP', () => {
    const previous = previousSchemaContract()
    expect(parseReleaseContract(previous).schemaVersion).toBe(2)
  })

  it('rejects a schema-3 contract whose arm64 updater ZIP name is wrong', () => {
    const drifted = contract()
    drifted.artifacts.macosArm64Zip.fileName = 'Polo-AI-arm64-mac.zip'
    expect(() => parseReleaseContract(drifted)).toThrow('manual installer names are invalid')
  })

  it('rejects a schema-3 contract missing the arm64 updater ZIP', () => {
    const incomplete = previousSchemaContract()
    incomplete.schemaVersion = RELEASE_CONTRACT_SCHEMA_VERSION
    expect(() => parseReleaseContract(incomplete)).toThrow('unexpected fields')
  })

  it('rejects schema drift and unsafe artifact names', () => {
    expect(() => parseReleaseContract({ ...contract(), extra: true })).toThrow('unexpected fields')
    const unsafe = contract()
    unsafe.artifacts.macosZip.fileName = '../Polo-AI-x64.zip'
    expect(() => parseReleaseContract(unsafe)).toThrow('unsafe')
  })
})

// BOOTSTRAP_VERSIONS move with every release; derive off-by-one fixtures from
// them so this suite survives version bumps instead of hardcoding a past one.
function nextPatch(version: string): string {
  return version.replace(/(\d+)$/, (digits) => String(Number(digits) + 1))
}

describe('release preflight', () => {
  it('allows only the bootstrap versions to bootstrap without an online contract', () => {
    for (const bootstrapVersion of BOOTSTRAP_VERSIONS) {
      expect(evaluateReleasePreflight(input({
        tag: `v${bootstrapVersion}`,
        rootVersion: bootstrapVersion,
        electronVersion: bootstrapVersion,
      }))).toEqual({
        bootstrap: true,
        version: bootstrapVersion,
      })
    }
    // v0.19.3 bootstraps the legacy(schema 2) -> schema-3 transition: the
    // online source still serves only v0.19.2 legacy metadata when it ships.
    expect(BOOTSTRAP_VERSIONS).toEqual(['0.19.2', '0.19.3'])
    const afterBootstrap = nextPatch(BOOTSTRAP_VERSIONS[BOOTSTRAP_VERSIONS.length - 1]!)
    expect(() => evaluateReleasePreflight(input({
      tag: `v${afterBootstrap}`, rootVersion: afterBootstrap, electronVersion: afterBootstrap,
    }))).toThrow(
      `Only v${BOOTSTRAP_VERSIONS.join(' or v')} may bootstrap without an online contract`,
    )
  })

  it('requires tag, package versions, and commit to match', () => {
    expect(() => evaluateReleasePreflight(input({ electronVersion: '0.15.1' }))).toThrow('Version mismatch')
    expect(() => evaluateReleasePreflight(input({ tagCommitSha: 'c'.repeat(40) }))).toThrow('does not point')
    expect(() => evaluateReleasePreflight(input({ tag: '0.15.2' }))).toThrow('strict SemVer')
  })

  it('requires a version newer than the online contract', () => {
    const newer = nextPatch(BOOTSTRAP_VERSIONS[0]!)
    expect(evaluateReleasePreflight(input({
      tag: `v${newer}`, rootVersion: newer, electronVersion: newer,
      onlineContract: contract(BOOTSTRAP_VERSIONS[0]!),
    })).bootstrap).toBe(false)
    expect(() => evaluateReleasePreflight(input({
      onlineContract: contract(BOOTSTRAP_VERSIONS[0]!),
    }))).toThrow('must be greater')
  })
})
