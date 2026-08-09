#!/usr/bin/env bun

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { load } from 'js-yaml'
import {
  createReleaseContract,
  parseReleaseContract,
  type ReleaseArtifactContract,
  type ReleaseContract,
} from './electron-release-contract'
import {
  MACOS_X64_DMG_NAME,
  MANIFEST_NAMES,
  validateSource,
} from './publish-electron-release'

const BUNDLE_FILES = [
  'Polo-AI-x64.zip',
  'Polo-AI-x64.dmg',
  'Polo-AI-arm64.dmg',
  'Polo-AI-x64.AppImage',
  'Polo-AI-x64.exe',
  ...MANIFEST_NAMES,
] as const

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

export async function prepareReleaseBundle(input: BundleMetadata & {
  inputDir: string
  outputDir: string
  installScript: string
  publishedAt: string
}): Promise<ReleaseContract> {
  const inputDir = resolve(input.inputDir)
  const outputDir = resolve(input.outputDir)
  const existing = await readdir(outputDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  if (existing.length > 0) throw new Error(`Release output directory is not empty: ${outputDir}`)
  await mkdir(outputDir, { recursive: true })

  for (const name of BUNDLE_FILES) {
    const source = join(inputDir, name)
    await assertRegularFile(source)
    await cp(source, join(outputDir, name), { errorOnExist: true, force: false })
  }
  await assertRegularFile(input.installScript)
  await cp(input.installScript, join(outputDir, 'install-app.sh'), {
    errorOnExist: true,
    force: false,
  })
  const contract = await createReleaseContract({
    repository: input.repository,
    tag: input.tag,
    version: input.version,
    commitSha: input.commitSha,
    publishedAt: input.publishedAt,
    macosZip: join(outputDir, 'Polo-AI-x64.zip'),
    macosX64Dmg: join(outputDir, 'Polo-AI-x64.dmg'),
    macosArm64Dmg: join(outputDir, 'Polo-AI-arm64.dmg'),
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

function cacheDirectiveFor(fileName: string): 'no-cache' | 'immutable' {
  if (
    fileName === 'install-app.sh'
    || fileName === 'release-contract.json'
    || MANIFEST_NAMES.includes(fileName as (typeof MANIFEST_NAMES)[number])
  ) {
    return 'no-cache'
  }
  return 'immutable'
}

async function verifyArtifact(
  baseUrl: string,
  contractArtifact: ReleaseArtifactContract,
  manifestEntry?: { size: number, sha512: string },
): Promise<void> {
  const url = `${baseUrl}/${encodeURIComponent(contractArtifact.fileName)}`
  const head = await fetchOk(url, { method: 'HEAD', cache: 'no-store' })
  requireCacheControl(head, cacheDirectiveFor(contractArtifact.fileName), contractArtifact.fileName)
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
): Promise<ReleaseContract> {
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

  if (contract.schemaVersion !== 2) {
    throw new Error('Published contract must use schema version 2')
  }
  const manifestContracts: Record<string, ReleaseArtifactContract> = {
    'latest-mac.yml': contract.artifacts.macosZip,
    'latest-linux.yml': contract.artifacts.linuxAppImage,
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
      ? new Set([artifact.fileName, MACOS_X64_DMG_NAME])
      : new Set([artifact.fileName])
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
    contract.artifacts.macosX64Dmg,
    contract.artifacts.macosArm64Dmg,
    contract.artifacts.windowsExe,
    contract.installApp,
  ]) {
    await verifyArtifact(normalizedBase, artifact)
  }

  const methodCheck = await fetch(`${normalizedBase}/release-contract.json`, { method: 'POST' })
  if (methodCheck.status !== 405) {
    throw new Error(`Static update service accepted POST with HTTP ${methodCheck.status}`)
  }
  return contract
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
      options: { ...common, url: { type: 'string' } },
      strict: true,
    })
    await verifyPublishedRelease(required(values, 'url'), {
      repository: required(values, 'repository'),
      tag: required(values, 'tag'),
      version: required(values, 'version'),
      commitSha: required(values, 'commit').toLowerCase(),
    })
    return
  }
  throw new Error('Usage: electron-release-bundle.ts <prepare|verify> [options]')
}

if (import.meta.main) await main()
