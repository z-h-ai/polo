#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isStrictSemver, parseStrictSemverTag } from './strict-semver'

export interface PreviousReleaseContractInput {
  repository: string
  tag: string
  expectedVersion: string
  expectedCommit: string
  resolvedVersion: string
  resolvedCommit: string
  currentVersion: string
  artifactPath: string
  artifactName: string
  artifactSha256: string
  installerPath?: string
  installerSha256?: string
}

export interface VerifiedPreviousReleaseContract {
  schemaVersion: 1
  repository: string
  tag: string
  version: string
  commitSha: string
  artifact: {
    name: string
    sha256: string
  }
  installer?: {
    name: string
    sha256: string
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}$/

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function validatePreviousReleaseContract(
  input: PreviousReleaseContractInput,
): VerifiedPreviousReleaseContract {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    throw new Error(`Invalid previous release repository: ${input.repository}`)
  }
  if (!parseStrictSemverTag(input.tag)) {
    throw new Error(`Previous release tag must be an immutable semantic tag: ${input.tag}`)
  }
  for (const [name, version] of [
    ['expectedVersion', input.expectedVersion],
    ['resolvedVersion', input.resolvedVersion],
    ['currentVersion', input.currentVersion],
  ] as const) {
    if (!isStrictSemver(version)) {
      throw new Error(`Invalid strict SemVer ${name}: ${version}`)
    }
  }
  if (input.resolvedVersion !== input.expectedVersion) {
    throw new Error(
      `Previous release version mismatch: expected ${input.expectedVersion}, `
      + `resolved ${input.resolvedVersion}`,
    )
  }
  if (input.currentVersion === input.expectedVersion) {
    throw new Error(
      `Previous release version must differ from current ${input.currentVersion}`,
    )
  }
  if (
    !COMMIT_PATTERN.test(input.expectedCommit)
    || input.resolvedCommit !== input.expectedCommit
  ) {
    throw new Error(
      `Previous release commit mismatch: expected ${input.expectedCommit}, `
      + `resolved ${input.resolvedCommit}`,
    )
  }
  if (!SHA256_PATTERN.test(input.artifactSha256)) {
    throw new Error('Previous artifact SHA-256 must be a lowercase 64-character digest')
  }
  if (
    basename(input.artifactPath) !== input.artifactName
    || !existsSync(input.artifactPath)
  ) {
    throw new Error(`Previous artifact contract path mismatch: ${input.artifactPath}`)
  }
  const artifactHash = sha256(input.artifactPath)
  if (artifactHash !== input.artifactSha256) {
    throw new Error(
      `Previous artifact SHA-256 mismatch: expected ${input.artifactSha256}, got ${artifactHash}`,
    )
  }

  let installer: VerifiedPreviousReleaseContract['installer']
  if (input.installerPath || input.installerSha256) {
    if (
      !input.installerPath
      || !input.installerSha256
      || !SHA256_PATTERN.test(input.installerSha256)
      || !existsSync(input.installerPath)
    ) {
      throw new Error('Previous installer contract requires an existing path and SHA-256')
    }
    const installerHash = sha256(input.installerPath)
    if (installerHash !== input.installerSha256) {
      throw new Error(
        `Previous installer SHA-256 mismatch: expected ${input.installerSha256}, got ${installerHash}`,
      )
    }
    installer = {
      name: basename(input.installerPath),
      sha256: installerHash,
    }
  }

  return {
    schemaVersion: 1,
    repository: input.repository,
    tag: input.tag,
    version: input.expectedVersion,
    commitSha: input.expectedCommit,
    artifact: {
      name: input.artifactName,
      sha256: artifactHash,
    },
    ...(installer ? { installer } : {}),
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      tag: { type: 'string' },
      'expected-version': { type: 'string' },
      'expected-commit': { type: 'string' },
      'resolved-version': { type: 'string' },
      'resolved-commit': { type: 'string' },
      'current-version': { type: 'string' },
      artifact: { type: 'string' },
      'artifact-name': { type: 'string' },
      'artifact-sha256': { type: 'string' },
      installer: { type: 'string' },
      'installer-sha256': { type: 'string' },
      output: { type: 'string' },
    },
    strict: true,
  })
  for (const required of [
    'repository',
    'tag',
    'expected-version',
    'expected-commit',
    'resolved-version',
    'resolved-commit',
    'current-version',
    'artifact',
    'artifact-name',
    'artifact-sha256',
  ] as const) {
    if (!values[required]) throw new Error(`Missing --${required}`)
  }
  const verified = validatePreviousReleaseContract({
    repository: values.repository!,
    tag: values.tag!,
    expectedVersion: values['expected-version']!,
    expectedCommit: values['expected-commit']!.toLowerCase(),
    resolvedVersion: values['resolved-version']!,
    resolvedCommit: values['resolved-commit']!.toLowerCase(),
    currentVersion: values['current-version']!,
    artifactPath: resolve(values.artifact!),
    artifactName: values['artifact-name']!,
    artifactSha256: values['artifact-sha256']!.toLowerCase(),
    ...(values.installer ? { installerPath: resolve(values.installer) } : {}),
    ...(values['installer-sha256']
      ? { installerSha256: values['installer-sha256'].toLowerCase() }
      : {}),
  })
  const serialized = `${JSON.stringify(verified, null, 2)}\n`
  if (values.output) {
    writeFileSync(resolve(values.output), serialized, 'utf8')
  }
  process.stdout.write(serialized)
}
