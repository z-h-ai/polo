import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  it('rejects an artifact that does not match the pinned digest', () => {
    const input = fixture()
    input.artifactSha256 = '0'.repeat(64)
    expect(() => validatePreviousReleaseContract(input)).toThrow(
      'Previous artifact SHA-256 mismatch',
    )
  })
})
