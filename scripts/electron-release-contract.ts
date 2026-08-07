#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gt } from 'semver'
import { isStrictSemver, parseStrictSemverTag } from './strict-semver'

export const RELEASE_CONTRACT_SCHEMA_VERSION = 1 as const
export const BOOTSTRAP_VERSION = '0.15.2'
export const DEFAULT_RELEASE_CONTRACT_URL =
  'https://updates.polo.z-h-ai.com/electron/latest/release-contract.json'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export const RELEASE_ARTIFACT_KEYS = [
  'macosZip',
  'windowsExe',
  'linuxAppImage',
] as const

export type ReleaseArtifactKey = (typeof RELEASE_ARTIFACT_KEYS)[number]

export interface ReleaseArtifactContract {
  fileName: string
  sha256: string
}

export interface ReleaseContract {
  schemaVersion: typeof RELEASE_CONTRACT_SCHEMA_VERSION
  repository: string
  tag: string
  version: string
  commitSha: string
  publishedAt: string
  artifacts: Record<ReleaseArtifactKey, ReleaseArtifactContract>
  installApp: ReleaseArtifactContract
}

export interface ReleasePreflightInput {
  repository: string
  tag: string
  commitSha: string
  tagCommitSha: string
  rootVersion: string
  electronVersion: string
  onlineContract?: ReleaseContract
}

export interface ReleasePreflightResult {
  bootstrap: boolean
  version: string
  previous?: ReleaseContract
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields: ${actual.join(', ')}`)
  }
}

function parseArtifact(value: unknown, label: string): ReleaseArtifactContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const record = value as Record<string, unknown>
  assertExactKeys(record, ['fileName', 'sha256'], label)
  if (
    typeof record.fileName !== 'string'
    || basename(record.fileName) !== record.fileName
    || record.fileName.includes('..')
    || record.fileName.includes('/')
    || record.fileName.includes('\\')
  ) {
    throw new Error(`${label}.fileName is unsafe`)
  }
  if (typeof record.sha256 !== 'string' || !SHA256_PATTERN.test(record.sha256)) {
    throw new Error(`${label}.sha256 must be a lowercase SHA-256 digest`)
  }
  return { fileName: record.fileName, sha256: record.sha256 }
}

export function parseReleaseContract(value: unknown): ReleaseContract {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Release contract must be an object')
  }
  const record = value as Record<string, unknown>
  assertExactKeys(record, [
    'schemaVersion',
    'repository',
    'tag',
    'version',
    'commitSha',
    'publishedAt',
    'artifacts',
    'installApp',
  ], 'Release contract')
  if (record.schemaVersion !== RELEASE_CONTRACT_SCHEMA_VERSION) {
    throw new Error(`Unsupported release contract schema: ${String(record.schemaVersion)}`)
  }
  if (typeof record.repository !== 'string' || !REPOSITORY_PATTERN.test(record.repository)) {
    throw new Error('Release contract repository is invalid')
  }
  if (typeof record.tag !== 'string' || !parseStrictSemverTag(record.tag)) {
    throw new Error('Release contract tag is not strict SemVer')
  }
  if (typeof record.version !== 'string' || !isStrictSemver(record.version)) {
    throw new Error('Release contract version is not strict SemVer')
  }
  if (record.tag !== `v${record.version}`) {
    throw new Error('Release contract tag and version do not match')
  }
  if (typeof record.commitSha !== 'string' || !COMMIT_PATTERN.test(record.commitSha)) {
    throw new Error('Release contract commitSha must be a lowercase 40-character SHA')
  }
  if (
    typeof record.publishedAt !== 'string'
    || !Number.isFinite(Date.parse(record.publishedAt))
  ) {
    throw new Error('Release contract publishedAt is invalid')
  }
  if (!record.artifacts || typeof record.artifacts !== 'object' || Array.isArray(record.artifacts)) {
    throw new Error('Release contract artifacts must be an object')
  }
  const artifactRecord = record.artifacts as Record<string, unknown>
  assertExactKeys(artifactRecord, RELEASE_ARTIFACT_KEYS, 'Release contract artifacts')
  const contract: ReleaseContract = {
    schemaVersion: RELEASE_CONTRACT_SCHEMA_VERSION,
    repository: record.repository,
    tag: record.tag,
    version: record.version,
    commitSha: record.commitSha,
    publishedAt: record.publishedAt,
    artifacts: {
      macosZip: parseArtifact(artifactRecord.macosZip, 'artifacts.macosZip'),
      windowsExe: parseArtifact(artifactRecord.windowsExe, 'artifacts.windowsExe'),
      linuxAppImage: parseArtifact(artifactRecord.linuxAppImage, 'artifacts.linuxAppImage'),
    },
    installApp: parseArtifact(record.installApp, 'installApp'),
  }
  const names = [
    ...Object.values(contract.artifacts).map((artifact) => artifact.fileName),
    contract.installApp.fileName,
  ]
  if (new Set(names).size !== names.length) {
    throw new Error('Release contract contains duplicate file names')
  }
  if (
    !contract.artifacts.macosZip.fileName.endsWith('.zip')
    || !contract.artifacts.windowsExe.fileName.endsWith('.exe')
    || !contract.artifacts.linuxAppImage.fileName.endsWith('.AppImage')
    || contract.installApp.fileName !== 'install-app.sh'
  ) {
    throw new Error('Release contract artifact types are invalid')
  }
  return contract
}

export function evaluateReleasePreflight(input: ReleasePreflightInput): ReleasePreflightResult {
  if (!REPOSITORY_PATTERN.test(input.repository)) throw new Error('Repository is invalid')
  const version = parseStrictSemverTag(input.tag)
  if (!version) throw new Error(`Release tag must be strict SemVer: ${input.tag}`)
  for (const [label, commit] of [
    ['commit', input.commitSha],
    ['tag commit', input.tagCommitSha],
  ] as const) {
    if (!COMMIT_PATTERN.test(commit)) throw new Error(`${label} SHA is invalid`)
  }
  if (input.commitSha !== input.tagCommitSha) {
    throw new Error('Release tag does not point at the workflow commit')
  }
  if (input.rootVersion !== version || input.electronVersion !== version) {
    throw new Error(
      `Version mismatch: tag=${version}, root=${input.rootVersion}, electron=${input.electronVersion}`,
    )
  }
  if (!input.onlineContract) {
    if (version !== BOOTSTRAP_VERSION) {
      throw new Error(`Only v${BOOTSTRAP_VERSION} may bootstrap without an online contract`)
    }
    return { bootstrap: true, version }
  }
  const previous = parseReleaseContract(input.onlineContract)
  if (previous.repository !== input.repository) {
    throw new Error(
      `Online contract repository ${previous.repository} does not match ${input.repository}`,
    )
  }
  if (!gt(version, previous.version)) {
    throw new Error(`Release version ${version} must be greater than online ${previous.version}`)
  }
  return { bootstrap: false, version, previous }
}

export async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

export async function createReleaseContract(input: {
  repository: string
  tag: string
  version: string
  commitSha: string
  publishedAt: string
  macosZip: string
  windowsExe: string
  linuxAppImage: string
  installApp: string
}): Promise<ReleaseContract> {
  return parseReleaseContract({
    schemaVersion: RELEASE_CONTRACT_SCHEMA_VERSION,
    repository: input.repository,
    tag: input.tag,
    version: input.version,
    commitSha: input.commitSha,
    publishedAt: input.publishedAt,
    artifacts: {
      macosZip: { fileName: basename(input.macosZip), sha256: await sha256(input.macosZip) },
      windowsExe: { fileName: basename(input.windowsExe), sha256: await sha256(input.windowsExe) },
      linuxAppImage: { fileName: basename(input.linuxAppImage), sha256: await sha256(input.linuxAppImage) },
    },
    installApp: { fileName: basename(input.installApp), sha256: await sha256(input.installApp) },
  })
}

function appendOutput(lines: string[], key: string, value: string | boolean): void {
  lines.push(`${key}=${String(value)}`)
}

async function runPreflight(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repository: { type: 'string' },
      tag: { type: 'string' },
      commit: { type: 'string' },
      'tag-commit': { type: 'string' },
      'root-package': { type: 'string' },
      'electron-package': { type: 'string' },
      'contract-url': { type: 'string', default: DEFAULT_RELEASE_CONTRACT_URL },
      'github-output': { type: 'string' },
      'contract-output': { type: 'string' },
    },
    strict: true,
  })
  for (const required of [
    'repository', 'tag', 'commit', 'tag-commit', 'root-package', 'electron-package',
  ] as const) {
    if (!values[required]) throw new Error(`Missing --${required}`)
  }
  const [rootPackage, electronPackage] = await Promise.all([
    readFile(resolve(values['root-package']!), 'utf8').then(JSON.parse),
    readFile(resolve(values['electron-package']!), 'utf8').then(JSON.parse),
  ])
  let onlineContract: ReleaseContract | undefined
  const response = await fetch(values['contract-url']!, {
    headers: { 'cache-control': 'no-cache' },
  })
  if (response.ok) {
    onlineContract = parseReleaseContract(await response.json())
  } else if (response.status !== 404) {
    throw new Error(`Unable to fetch online release contract: HTTP ${response.status}`)
  }
  const result = evaluateReleasePreflight({
    repository: values.repository!,
    tag: values.tag!,
    commitSha: values.commit!.toLowerCase(),
    tagCommitSha: values['tag-commit']!.toLowerCase(),
    rootVersion: rootPackage.version,
    electronVersion: electronPackage.version,
    onlineContract,
  })
  const output: string[] = []
  appendOutput(output, 'bootstrap', result.bootstrap)
  appendOutput(output, 'version', result.version)
  if (result.previous) {
    appendOutput(output, 'previous_tag', result.previous.tag)
    appendOutput(output, 'previous_version', result.previous.version)
    appendOutput(output, 'previous_commit_sha', result.previous.commitSha)
    appendOutput(output, 'previous_macos_name', result.previous.artifacts.macosZip.fileName)
    appendOutput(output, 'previous_macos_sha256', result.previous.artifacts.macosZip.sha256)
    appendOutput(output, 'previous_windows_name', result.previous.artifacts.windowsExe.fileName)
    appendOutput(output, 'previous_windows_sha256', result.previous.artifacts.windowsExe.sha256)
    appendOutput(output, 'previous_linux_name', result.previous.artifacts.linuxAppImage.fileName)
    appendOutput(output, 'previous_linux_sha256', result.previous.artifacts.linuxAppImage.sha256)
    appendOutput(output, 'previous_installer_sha256', result.previous.installApp.sha256)
  }
  if (values['github-output']) {
    await writeFile(resolve(values['github-output']), `${output.join('\n')}\n`, { flag: 'a' })
  } else {
    process.stdout.write(`${output.join('\n')}\n`)
  }
  if (values['contract-output'] && result.previous) {
    await writeFile(
      resolve(values['contract-output']),
      `${JSON.stringify(result.previous, null, 2)}\n`,
    )
  }
}

if (import.meta.main) {
  const [command, ...argv] = process.argv.slice(2)
  if (command !== 'preflight') {
    throw new Error('Usage: bun scripts/electron-release-contract.ts preflight [options]')
  }
  await runPreflight(argv)
}
