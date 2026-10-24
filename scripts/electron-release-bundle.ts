#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { dump, load } from 'js-yaml'
import {
  createReleaseContract,
  parseReleaseContract,
  PREVIOUS_RELEASE_CONTRACT_SCHEMA_VERSION,
  RELEASE_CONTRACT_SCHEMA_VERSION,
  type PreviousReleaseContract,
  type ReleaseArtifactContract,
  type ReleaseContract,
} from './electron-release-contract'
import {
  MACOS_ARM64_DMG_NAME,
  MACOS_ARM64_ZIP_NAME,
  MACOS_X64_DMG_NAME,
  MANIFEST_NAMES,
  validateSource,
} from './publish-electron-release'

const BUNDLE_FILES = [
  'Polo-AI-x64.zip',
  'Polo-AI-arm64.zip',
  'Polo-AI-x64.dmg',
  'Polo-AI-arm64.dmg',
  'Polo-AI-x64.AppImage',
  'Polo-AI-x64.exe',
  ...MANIFEST_NAMES,
] as const

// Each macOS build uploads its own per-arch manifest under a distinct name so
// the artifact merge in draft-release cannot overwrite one with the other.
// The published latest-mac.yml is synthesized here from both.
const MACOS_UPDATE_MANIFEST_NAME = 'latest-mac.yml'
const MACOS_ARM64_UPDATE_MANIFEST_NAME = 'latest-mac-arm64.yml'
const MACOS_MANIFEST_ENTRIES_BY_ARCH = {
  x64: ['Polo-AI-x64.zip', MACOS_X64_DMG_NAME],
  arm64: [MACOS_ARM64_ZIP_NAME, MACOS_ARM64_DMG_NAME],
} as const

interface BundleMetadata {
  repository: string
  tag: string
  version: string
  commitSha: string
}

async function assertRegularFile(path: string): Promise<void> {
  const value = await lstat(path)
  if (!value.isFile()) throw new Error(`Expected a regular file: ${path}`)
}

async function assertBundleInput(name: string, path: string): Promise<void> {
  try {
    await assertRegularFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Release bundle is missing a required artifact: ${name}`)
    }
    throw error
  }
}

interface MacManifestFile {
  url: unknown
  sha512?: unknown
  size?: unknown
  [key: string]: unknown
}

interface MacUpdateManifest {
  version: string
  files: MacManifestFile[]
  path?: string
  sha512?: string
  releaseDate?: string
  [key: string]: unknown
}

async function readValidatedPerArchManifest(
  manifestPath: string,
  expectedEntries: readonly string[],
): Promise<MacUpdateManifest> {
  const parsed = load(await readFile(manifestPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${manifestPath} is not a YAML object`)
  }
  const manifest = parsed as Partial<MacUpdateManifest>
  if (typeof manifest.version !== 'string' || !Array.isArray(manifest.files)) {
    throw new Error(`${manifestPath} must contain a version and a files array`)
  }
  const names = manifest.files.map(entry => entry?.url)
  if (
    manifest.files.length !== expectedEntries.length
    || names.some(name => typeof name !== 'string')
    || new Set(names).size !== names.length
    || expectedEntries.some(name => !names.includes(name))
  ) {
    throw new Error(
      `${basename(manifestPath)} must reference exactly: ${expectedEntries.join(', ')}`,
    )
  }
  return manifest as MacUpdateManifest
}

/**
 * POL-268: electron-updater's MacUpdater filters candidate entries by whether
 * the artifact name contains "arm64" before picking the ".zip" entry, so the
 * published latest-mac.yml must carry both architecture ZIPs. Merge the two
 * per-arch build manifests — x64 keeps the top-level path/sha512 so legacy
 * single-file semantics and the x64 update chain stay intact — and recompute
 * every digest against the final release bytes.
 */
async function mergeMacUpdateManifests(
  x64ManifestPath: string,
  arm64ManifestPath: string,
  outputManifestPath: string,
  releaseDir: string,
): Promise<void> {
  const [x64, arm64] = await Promise.all([
    readValidatedPerArchManifest(x64ManifestPath, MACOS_MANIFEST_ENTRIES_BY_ARCH.x64),
    readValidatedPerArchManifest(arm64ManifestPath, MACOS_MANIFEST_ENTRIES_BY_ARCH.arm64),
  ])
  if (x64.version !== arm64.version) {
    throw new Error('Per-arch update manifests disagree on the release version')
  }
  const merged: MacUpdateManifest = {
    version: x64.version,
    files: [...x64.files, ...arm64.files],
    path: x64.path,
    sha512: x64.sha512,
    ...(typeof x64.releaseDate === 'string' ? { releaseDate: x64.releaseDate } : {}),
  }
  for (const entry of merged.files) {
    const artifactPath = join(releaseDir, entry.url as string)
    const contents = new Uint8Array(await readFile(artifactPath))
    entry.sha512 = sha512(contents)
    entry.size = contents.byteLength
  }
  await writeFile(
    outputManifestPath,
    dump(merged, { lineWidth: -1, noRefs: true }),
    { flag: 'wx' },
  )
}

export async function prepareReleaseBundle(input: BundleMetadata & {
  inputDir: string
  outputDir: string
  installScript: string
  publishedAt: string
}): Promise<ReleaseContract> {
  const inputDir = resolve(input.inputDir)
  const outputDir = resolve(input.outputDir)
  // POL-268 recurrence gate, checked before any output is created so a build
  // that failed to produce the arm64 updater ZIP is reported against its
  // manifest contract instead of surfacing as a bare ENOENT deep in the copy
  // loop, and so a rejected release leaves no partial Draft directory behind.
  await Promise.all([
    readValidatedPerArchManifest(
      join(inputDir, MACOS_UPDATE_MANIFEST_NAME),
      MACOS_MANIFEST_ENTRIES_BY_ARCH.x64,
    ),
    readValidatedPerArchManifest(
      join(inputDir, MACOS_ARM64_UPDATE_MANIFEST_NAME),
      MACOS_MANIFEST_ENTRIES_BY_ARCH.arm64,
    ),
  ])
  const existing = await readdir(outputDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  if (existing.length > 0) throw new Error(`Release output directory is not empty: ${outputDir}`)
  await mkdir(outputDir, { recursive: true })

  for (const name of BUNDLE_FILES) {
    // The published macOS manifest is synthesized from both per-arch build
    // manifests below; the x64 job's single-arch upload is an input only.
    if (name === MACOS_UPDATE_MANIFEST_NAME) continue
    const source = join(inputDir, name)
    await assertBundleInput(name, source)
    await cp(source, join(outputDir, name), { errorOnExist: true, force: false })
  }
  await assertRegularFile(input.installScript)
  await cp(input.installScript, join(outputDir, 'install-app.sh'), {
    errorOnExist: true,
    force: false,
  })
  await mergeMacUpdateManifests(
    join(inputDir, MACOS_UPDATE_MANIFEST_NAME),
    join(inputDir, MACOS_ARM64_UPDATE_MANIFEST_NAME),
    join(outputDir, MACOS_UPDATE_MANIFEST_NAME),
    outputDir,
  )
  const contract = await createReleaseContract({
    repository: input.repository,
    tag: input.tag,
    version: input.version,
    commitSha: input.commitSha,
    publishedAt: input.publishedAt,
    macosZip: join(outputDir, 'Polo-AI-x64.zip'),
    macosArm64Zip: join(outputDir, MACOS_ARM64_ZIP_NAME),
    macosX64Dmg: join(outputDir, 'Polo-AI-x64.dmg'),
    macosArm64Dmg: join(outputDir, MACOS_ARM64_DMG_NAME),
    linuxAppImage: join(outputDir, 'Polo-AI-x64.AppImage'),
    windowsExe: join(outputDir, 'Polo-AI-x64.exe'),
    installApp: join(outputDir, 'install-app.sh'),
  })
  await writeFile(
    join(outputDir, 'release-contract.json'),
    `${JSON.stringify(contract, null, 2)}\n`,
  )
  await validateSource(outputDir, input)
  return contract
}

function sha512(contents: Uint8Array): string {
  return createHash('sha512').update(contents).digest('base64')
}

function sha256(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex')
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${url} returned HTTP ${response.status}`)
  return response
}

function requireCacheControl(response: Response, directive: string, label: string): void {
  const value = response.headers.get('cache-control') ?? ''
  if (!value.toLowerCase().includes(directive)) {
    throw new Error(`${label} Cache-Control must include ${directive}`)
  }
}

async function verifyArtifact(
  baseUrl: string,
  contractArtifact: ReleaseArtifactContract,
  manifestEntry?: { size: number, sha512: string },
): Promise<void> {
  const url = `${baseUrl}/${encodeURIComponent(contractArtifact.fileName)}`
  const head = await fetchOk(url, { method: 'HEAD', cache: 'no-store' })
  requireCacheControl(head, 'no-cache', contractArtifact.fileName)
  const contents = new Uint8Array(await (await fetchOk(url, { cache: 'no-store' })).arrayBuffer())
  const headerSize = head.headers.get('content-length')
  if (headerSize !== null && Number(headerSize) !== contents.byteLength) {
    throw new Error(`${contractArtifact.fileName} HEAD content-length is incorrect`)
  }
  if (manifestEntry && manifestEntry.size !== contents.byteLength) {
    throw new Error(`${contractArtifact.fileName} manifest size is incorrect`)
  }
  if (manifestEntry && manifestEntry.sha512 !== sha512(contents)) {
    throw new Error(`${contractArtifact.fileName} manifest SHA-512 is incorrect`)
  }
  if (contractArtifact.sha256 !== sha256(contents)) {
    throw new Error(`${contractArtifact.fileName} contract SHA-256 is incorrect`)
  }
}

export async function verifyPublishedRelease(
  baseUrl: string,
  expected: BundleMetadata,
  options: { allowPreviousSchema?: boolean } = {},
): Promise<ReleaseContract | PreviousReleaseContract> {
  const normalizedBase = baseUrl.replace(/\/$/, '')
  const contractResponse = await fetchOk(`${normalizedBase}/release-contract.json`, {
    cache: 'no-store',
  })
  requireCacheControl(contractResponse, 'no-cache', 'release-contract.json')
  const contract = parseReleaseContract(await contractResponse.json())
  if (
    contract.repository !== expected.repository
    || contract.tag !== expected.tag
    || contract.version !== expected.version
    || contract.commitSha !== expected.commitSha
  ) {
    throw new Error('Published contract does not match the release being verified')
  }

  // New releases must be dual-architecture (schema 3). Historical rollback
  // targets stay valid under the schema they were published with, so the
  // rollback verifier opts into the schema-2 contract explicitly; the update
  // source never published anything older through this pipeline.
  const isCurrentSchema = contract.schemaVersion === RELEASE_CONTRACT_SCHEMA_VERSION
  const isPreviousSchema = contract.schemaVersion === PREVIOUS_RELEASE_CONTRACT_SCHEMA_VERSION
  if (!isCurrentSchema && !isPreviousSchema) {
    throw new Error(`Published contract must use schema version ${RELEASE_CONTRACT_SCHEMA_VERSION}`)
  }
  if (isPreviousSchema && options.allowPreviousSchema !== true) {
    throw new Error(
      `Published contract uses the previous schema version ${PREVIOUS_RELEASE_CONTRACT_SCHEMA_VERSION};`
      + ' pass --allow-previous-schema only when verifying a historical rollback target',
    )
  }
  const typedContract = contract as ReleaseContract | PreviousReleaseContract
  const manifestContracts: Record<string, ReleaseArtifactContract> = {
    'latest-mac.yml': typedContract.artifacts.macosZip,
    'latest-linux.yml': typedContract.artifacts.linuxAppImage,
  }
  const contractByFileName = new Map(
    Object.values(contract.artifacts).map((artifact) => [artifact.fileName, artifact]),
  )
  for (const manifestName of MANIFEST_NAMES) {
    const manifestResponse = await fetchOk(`${normalizedBase}/${manifestName}`, { cache: 'no-store' })
    requireCacheControl(manifestResponse, 'no-cache', manifestName)
    const manifest = load(await manifestResponse.text()) as {
      version?: string
      files?: Array<{ url?: string, size?: number, sha512?: string }>
      path?: string
      sha512?: string
    }
    const artifact = manifestContracts[manifestName]!
    const entry = manifest.files?.find(item => item.url === artifact.fileName)
    const allowed = manifestName === 'latest-mac.yml'
      ? new Set([
          artifact.fileName,
          MACOS_X64_DMG_NAME,
          ...(isCurrentSchema ? [MACOS_ARM64_ZIP_NAME, MACOS_ARM64_DMG_NAME] : []),
        ])
      : new Set([artifact.fileName])
    if (
      isCurrentSchema
      && manifestName === 'latest-mac.yml'
      && !manifest.files?.some(item => item.url === MACOS_ARM64_ZIP_NAME)
    ) {
      // POL-268 recurrence gate: the live feed must keep carrying the arm64
      // updater ZIP or Apple Silicon clients silently receive x64 builds.
      throw new Error(`${manifestName} must reference ${MACOS_ARM64_ZIP_NAME}`)
    }
    if (
      manifest.version !== expected.version
      || !Array.isArray(manifest.files)
      || manifest.files.length < 1
      || manifest.files.some(item => typeof item.url !== 'string' || !allowed.has(item.url))
      || new Set(manifest.files.map(item => item.url)).size !== manifest.files.length
      || !entry
      || !Number.isSafeInteger(entry.size)
      || typeof entry.sha512 !== 'string'
      || (manifest.path !== undefined && manifest.path !== artifact.fileName)
      || (manifest.sha512 !== undefined && manifest.sha512 !== entry.sha512)
    ) {
      throw new Error(`${manifestName} does not match the published contract`)
    }
    for (const manifestEntry of manifest.files) {
      const manifestArtifact = contractByFileName.get(manifestEntry.url!)
      if (!manifestArtifact || !Number.isSafeInteger(manifestEntry.size) || typeof manifestEntry.sha512 !== 'string') {
        throw new Error(`${manifestName} references an artifact outside the published contract`)
      }
      await verifyArtifact(normalizedBase, manifestArtifact, {
        size: manifestEntry.size,
        sha512: manifestEntry.sha512,
      })
    }
  }
  for (const artifact of [
    typedContract.artifacts.macosX64Dmg,
    typedContract.artifacts.macosArm64Dmg,
    typedContract.artifacts.windowsExe,
    typedContract.installApp,
  ]) {
    await verifyArtifact(normalizedBase, artifact)
  }

  const methodCheck = await fetch(`${normalizedBase}/release-contract.json`, { method: 'POST' })
  if (methodCheck.status !== 405) {
    throw new Error(`Static update service accepted POST with HTTP ${methodCheck.status}`)
  }
  return typedContract
}

function required(values: Record<string, string | undefined>, key: string): string {
  const value = values[key]
  if (!value) throw new Error(`Missing --${key}`)
  return value
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  const common = {
    repository: { type: 'string' as const },
    tag: { type: 'string' as const },
    version: { type: 'string' as const },
    commit: { type: 'string' as const },
  }
  if (command === 'prepare') {
    const { values } = parseArgs({
      args,
      options: {
        ...common,
        input: { type: 'string' },
        output: { type: 'string' },
        'install-script': { type: 'string' },
        'published-at': { type: 'string' },
      },
      strict: true,
    })
    await prepareReleaseBundle({
      inputDir: required(values, 'input'),
      outputDir: required(values, 'output'),
      installScript: required(values, 'install-script'),
      repository: required(values, 'repository'),
      tag: required(values, 'tag'),
      version: required(values, 'version'),
      commitSha: required(values, 'commit').toLowerCase(),
      publishedAt: values['published-at'] ?? new Date().toISOString(),
    })
    return
  }
  if (command === 'verify') {
    const { values } = parseArgs({
      args,
      options: {
        ...common,
        url: { type: 'string' },
        // Rollback targets published before the dual-architecture contract
        // stay valid under schema 2; new-release verification omits this flag.
        'allow-previous-schema': { type: 'boolean' },
      },
      strict: true,
    })
    await verifyPublishedRelease(required(values, 'url'), {
      repository: required(values, 'repository'),
      tag: required(values, 'tag'),
      version: required(values, 'version'),
      commitSha: required(values, 'commit').toLowerCase(),
    }, { allowPreviousSchema: values['allow-previous-schema'] === true })
    return
  }
  if (command === 'validate') {
    const { values } = parseArgs({
      args,
      options: { ...common, input: { type: 'string' } },
      strict: true,
    })
    await validateSource(required(values, 'input'), {
      repository: required(values, 'repository'),
      tag: required(values, 'tag'),
      version: required(values, 'version'),
      commitSha: required(values, 'commit').toLowerCase(),
    })
    return
  }
  throw new Error('Usage: electron-release-bundle.ts <prepare|validate|verify> [options]')
}

if (import.meta.main) await main()
