import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isStrictSemver,
  parseStrictSemverTag,
  STRICT_SEMVER_PATTERN_SOURCE,
} from '../strict-semver'
import { validatePreviousReleaseContract } from '../validate-previous-release-contract'

const roots: string[] = []
const commit = '0123456789abcdef0123456789abcdef01234567'

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'polo previous release '))
  roots.push(root)
  const artifactPath = join(root, 'Polo-AI-x64.zip')
  const installerPath = join(root, 'install-app.sh')
  writeFileSync(artifactPath, 'legacy-container')
  writeFileSync(installerPath, '#!/bin/sh\n')
  const digest = (path: string) =>
    createHash('sha256').update(readFileSync(path)).digest('hex')
  return {
    repository: 'z-h-ai/polo',
    tag: 'v0.9.0',
    expectedVersion: '0.9.0',
    expectedCommit: commit,
    resolvedVersion: '0.9.0',
    resolvedCommit: commit,
    currentVersion: '0.10.0',
    artifactPath,
    artifactName: 'Polo-AI-x64.zip',
    artifactSha256: digest(artifactPath),
    installerPath,
    installerSha256: digest(installerPath),
  }
}

describe('previous Electron release input contract', () => {
  it('shares one anchored strict SemVer 2.0.0 parser', () => {
    expect(STRICT_SEMVER_PATTERN_SOURCE.startsWith('^')).toBe(true)
    expect(STRICT_SEMVER_PATTERN_SOURCE.endsWith('$')).toBe(true)

    for (const version of [
      '0.0.0',
      '1.2.3',
      '0.9.0-rc.1+build.7',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-0.3.7',
      '1.0.0-x.7.z.92',
      '1.0.0+001',
      '1.0.0-beta+exp.sha.5114f85',
    ]) {
      expect(isStrictSemver(version)).toBe(true)
      expect(parseStrictSemverTag(`v${version}`)).toBe(version)
    }

    for (const version of [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-01',
      '1.2.3-',
      '1.2.3+',
      '1.2.3-alpha..1',
      '1.2.3+build..1',
      '1x2x3',
      '1.2.3evil',
      '1.2.3 trailing',
    ]) {
      expect(isStrictSemver(version)).toBe(false)
      expect(parseStrictSemverTag(`v${version}`)).toBeUndefined()
    }
  })

  it('records immutable provenance and verified hashes', () => {
    const input = fixture()
    expect(validatePreviousReleaseContract(input)).toEqual({
      schemaVersion: 1,
      repository: 'z-h-ai/polo',
      tag: 'v0.9.0',
      version: '0.9.0',
      commitSha: commit,
      artifact: {
        name: 'Polo-AI-x64.zip',
        sha256: input.artifactSha256,
      },
      installer: {
        name: 'install-app.sh',
        sha256: input.installerSha256,
      },
    })
  })

  it('fails before lifecycle writes when previous and current versions match', () => {
    const input = fixture()
    input.currentVersion = input.expectedVersion
    expect(() => validatePreviousReleaseContract(input)).toThrow(
      'Previous release version must differ',
    )
  })

  it('accepts a legal prerelease and build version in every version field', () => {
    const input = fixture()
    input.tag = 'v0.9.0-rc.1+build.7'
    input.expectedVersion = '0.9.0-rc.1+build.7'
    input.resolvedVersion = '0.9.0-rc.1+build.7'
    input.currentVersion = '0.10.0-rc.2+build.8'

    expect(validatePreviousReleaseContract(input)).toMatchObject({
      tag: 'v0.9.0-rc.1+build.7',
      version: '0.9.0-rc.1+build.7',
    })
  })

  it('rejects malformed tags before artifact validation', () => {
    for (const tag of [
      'v01.2.3',
      'v1.02.3',
      'v1.2.03',
      'v1.2.3-01',
      'v1.2.3-',
      'v1.2.3+',
      'v1.2.3-alpha..1',
      'v1.2.3+build..1',
      'v1x2x3',
      'v1.2.3evil',
      'v1.2.3+build.7tail!',
    ]) {
      const input = fixture()
      input.tag = tag
      expect(() => validatePreviousReleaseContract(input)).toThrow(
        'Previous release tag must be an immutable semantic tag',
      )
    }
  })

  it('validates expected, resolved, and current versions independently', () => {
    const invalidVersions = [
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-01',
      '1.2.3-',
      '1.2.3+',
      '1.2.3-alpha..1',
      '1.2.3+build..1',
      '1x2x3',
      '1.2.3evil',
    ]

    for (const field of [
      'expectedVersion',
      'resolvedVersion',
      'currentVersion',
    ] as const) {
      for (const version of invalidVersions) {
        const input = fixture()
        input[field] = version
        expect(() => validatePreviousReleaseContract(input)).toThrow(
          `Invalid strict SemVer ${field}: ${version}`,
        )
      }
    }
  })

  it('rejects an artifact that does not match the pinned digest', () => {
    const input = fixture()
    input.artifactSha256 = '0'.repeat(64)
    expect(() => validatePreviousReleaseContract(input)).toThrow(
      'Previous artifact SHA-256 mismatch',
    )
  })
})
