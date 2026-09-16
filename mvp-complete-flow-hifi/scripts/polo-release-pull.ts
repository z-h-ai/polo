#!/usr/bin/env bun

import { createWriteStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm, stat, statfs, type FileHandle } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { parseStrictSemverTag } from './strict-semver'
import { sha256 } from './electron-release-contract'
import {
  parseDraftReleaseIdentity,
  RELEASE_ASSET_NAMES,
  type DraftReleaseIdentity,
} from './electron-release-draft-identity'
import {
  publish,
  projectedDiskUsage,
  validateSource,
  MAX_DISK_USAGE,
  type PublisherOptions,
  type ReleaseArguments,
} from './publish-electron-release'

export { RELEASE_ASSET_NAMES }

const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const DEFAULT_SIGNED_DOWNLOAD_CHUNK_BYTES = 64 * 1024
const DEFAULT_SIGNED_DOWNLOAD_CONCURRENCY = 512
const SIGNED_DOWNLOAD_ATTEMPTS = 3
const SIGNED_DOWNLOAD_TIMEOUT_MS = 60_000

interface GitHubAsset {
  id: number
  name: string
  size: number
  state: string
  url: string
}

interface GitHubRelease {
  id: number
  draft: boolean
  tag_name: string
  target_commitish: string
  assets: GitHubAsset[]
}

interface GitHubCommit {
  sha: string
}

export interface ReleasePullOptions {
  repository: string
  tag: string
  version: string
  commitSha: string
  releaseId: number
  assetIdentity: DraftReleaseIdentity | string
  releasesDir?: string
  apiBase?: string
  token?: string
  publisherOptions?: PublisherOptions
  peakCapacityCheck?: (releasesDir: string, additionalBytes: number) => Promise<void>
  incomingCleanup?: (incoming: string) => Promise<void>
  signedDownloadChunkBytes?: number
  signedDownloadConcurrency?: number
}

function normalizeApiBase(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('GitHub API base must use HTTP(S)')
  }
  return url.toString().replace(/\/$/, '')
}

function approvedDraftIdentity(options: ReleasePullOptions): DraftReleaseIdentity {
  if (!REPOSITORY_PATTERN.test(options.repository)) throw new Error('Repository is invalid')
  if (parseStrictSemverTag(options.tag) !== options.version) {
    throw new Error('Tag and strict SemVer version do not match')
  }
  if (!COMMIT_PATTERN.test(options.commitSha)) throw new Error('Commit SHA is invalid')
  if (!options.token) throw new Error('GH_TOKEN is required to read Draft Release assets')
  if (!Number.isSafeInteger(options.releaseId) || options.releaseId <= 0) {
    throw new Error('Approved Draft Release ID is invalid')
  }
  let identity: DraftReleaseIdentity
  try {
    identity = parseDraftReleaseIdentity(
      typeof options.assetIdentity === 'string' ? JSON.parse(options.assetIdentity) : options.assetIdentity,
    )
  } catch {
    throw new Error('Approved Draft Release asset identity is invalid')
  }
  if (identity.releaseId !== options.releaseId) {
    throw new Error('Approved Draft Release ID does not match its asset identity')
  }
  return identity
}

function apiHeaders(token: string, binary = false): HeadersInit {
  return {
    accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
  }
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, { headers: apiHeaders(token) })
  if (!response.ok) throw new Error(`GitHub API request failed with HTTP ${response.status}`)
  return response.json() as Promise<T>
}

function assertDraftRelease(
  release: GitHubRelease,
  options: Required<Pick<ReleasePullOptions, 'repository' | 'tag' | 'version' | 'commitSha' | 'releaseId'>>,
  apiBase: string,
  approvedIdentity: DraftReleaseIdentity,
): Map<string, GitHubAsset> {
  if (!release.draft || release.id !== options.releaseId) {
    throw new Error('Current Draft Release does not match the approved release ID')
  }
  if (release.tag_name !== options.tag || release.target_commitish.toLowerCase() !== options.commitSha) {
    throw new Error('Draft Release tag or target commit does not match the requested release')
  }
  if (!Array.isArray(release.assets)) throw new Error('Draft Release assets are invalid')
  const expectedNames = new Set<string>(RELEASE_ASSET_NAMES)
  const assets = new Map<string, GitHubAsset>()
  for (const asset of release.assets) {
    if (
      !asset
      || !Number.isSafeInteger(asset.id)
      || asset.id <= 0
      || typeof asset.name !== 'string'
      || !expectedNames.has(asset.name)
      || !Number.isSafeInteger(asset.size)
      || asset.size <= 0
      || asset.state !== 'uploaded'
    ) {
      throw new Error('Draft Release contains an invalid or non-whitelisted asset')
    }
    const expectedUrl = new URL(
      `/repos/${options.repository}/releases/assets/${asset.id}`,
      `${apiBase}/`,
    ).toString()
    const approvedAsset = approvedIdentity.assets.find(candidate => candidate.name === asset.name)
    if (
      asset.url !== expectedUrl || assets.has(asset.name)
      || !approvedAsset || asset.id !== approvedAsset.id || asset.size !== approvedAsset.size
    ) {
      throw new Error('Current Draft Release asset identity does not match the approved Draft')
    }
    assets.set(asset.name, asset)
  }
  if (assets.size !== expectedNames.size) {
    throw new Error('Draft Release asset names do not match the release whitelist')
  }
  return assets
}

async function downloadAsset(
  apiBase: string,
  repository: string,
  asset: GitHubAsset,
  destination: string,
  token: string,
  chunkBytes: number,
  concurrency: number,
): Promise<void> {
  const url = new URL(`/repos/${repository}/releases/assets/${asset.id}`, `${apiBase}/`).toString()
  let response = await fetch(url, { headers: apiHeaders(token, true), redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (!location) throw new Error('GitHub asset download redirect is missing its location')
    try {
      // GitHub redirects the API request to a short-lived object-store URL. Do
      // not forward the Draft Release token beyond the GitHub API origin.
      await downloadSignedAsset(
        new URL(location, url).toString(),
        asset,
        destination,
        chunkBytes,
        concurrency,
      )
    } catch {
      // Do not preserve a cause here: object-store URLs include short-lived
      // credentials in their query string and must never reach CI or service logs.
      throw new Error(`Unable to download signed GitHub release asset: ${asset.name}`)
    }
  } else {
    if (!response.ok || !response.body) {
      throw new Error(`Unable to download whitelisted release asset: HTTP ${response.status}`)
    }
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination, { flags: 'wx' }))
  }
  const downloaded = await lstat(destination)
  if (!downloaded.isFile() || downloaded.size !== asset.size) {
    throw new Error(`Downloaded release asset has an unexpected size: ${asset.name}`)
  }
}

async function downloadSignedRange(
  signedUrl: string,
  asset: GitHubAsset,
  destination: FileHandle,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<void> {
  const expectedLength = end - start + 1
  const expectedRange = `bytes ${start}-${end}/${asset.size}`
  for (let attempt = 1; attempt <= SIGNED_DOWNLOAD_ATTEMPTS; attempt += 1) {
    if (signal.aborted) throw new Error('signed range download aborted')
    try {
      const response = await fetch(signedUrl, {
        headers: {
          accept: 'application/octet-stream',
          range: `bytes=${start}-${end}`,
        },
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(SIGNED_DOWNLOAD_TIMEOUT_MS)]),
      })
      if (response.status !== 206 || response.headers.get('content-range') !== expectedRange) {
        await response.body?.cancel()
        throw new Error('signed object-store did not honor the requested byte range')
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.byteLength !== expectedLength) {
        throw new Error('signed object-store returned an incomplete byte range')
      }
      const written = await destination.write(bytes, 0, bytes.byteLength, start)
      if (written.bytesWritten !== bytes.byteLength) {
        throw new Error('release asset range was not fully written')
      }
      return
    } catch {
      if (signal.aborted || attempt === SIGNED_DOWNLOAD_ATTEMPTS) {
        throw new Error('signed range download failed')
      }
      await delay(attempt * 100)
    }
  }
}

async function downloadSignedAsset(
  signedUrl: string,
  asset: GitHubAsset,
  destination: string,
  chunkBytes: number,
  concurrency: number,
): Promise<void> {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new Error('Signed download chunk size is invalid')
  }
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error('Signed download concurrency is invalid')
  }
  const chunks = Math.ceil(asset.size / chunkBytes)
  const file = await open(destination, 'wx', 0o600)
  try {
    await file.truncate(asset.size)
    let nextChunk = 0
    const abort = new AbortController()
    const worker = async (): Promise<void> => {
      while (true) {
        const chunk = nextChunk
        nextChunk += 1
        if (chunk >= chunks) return
        const start = chunk * chunkBytes
        const end = Math.min(asset.size, start + chunkBytes) - 1
        await downloadSignedRange(signedUrl, asset, file, start, end, abort.signal)
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, chunks) }, worker)
    try {
      await Promise.all(workers)
    } catch (error) {
      abort.abort()
      await Promise.allSettled(workers)
      throw error
    }
    await file.sync()
  } catch (error) {
    await file.close()
    await rm(destination, { force: true })
    throw error
  }
  await file.close()
}

async function existingIncomingIsReusable(
  incoming: string,
  args: ReleaseArguments,
  assets: Map<string, GitHubAsset>,
): Promise<boolean> {
  try {
    const existing = await lstat(incoming)
    if (!existing.isDirectory()) throw new Error(`Incoming release path is not a directory: ${incoming}`)
    await validateSource(incoming, args)
    for (const name of RELEASE_ASSET_NAMES) {
      const file = await stat(join(incoming, name))
      if (!file.isFile() || file.size !== assets.get(name)!.size) {
        throw new Error(`Incoming release ${args.version} does not match the Draft Release asset sizes`)
      }
    }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function existingPublishedReleaseIsApproved(
  destination: string,
  args: ReleaseArguments,
  assets: Map<string, GitHubAsset>,
  trustedDigests: Map<string, string>,
): Promise<boolean> {
  const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!existing) return false
  try {
    if (!existing.isDirectory()) throw new Error('release path is not a directory')
    // Validate the complete contract/manifests before accepting an existing
    // directory as a retry. Size alone is insufficient for same-size bytes.
    await validateSource(destination, args)
    for (const name of RELEASE_ASSET_NAMES) {
      const file = await stat(join(destination, name))
      if (!file.isFile() || file.size !== assets.get(name)!.size) {
        throw new Error('release asset size differs')
      }
    }
    if (!(await matchesTrustedDigests(destination, trustedDigests))) {
      throw new Error('release asset digest differs')
    }
    return true
  } catch (error) {
    // Do not make a partially published or different same-version directory
    // eligible for a new-byte download, capacity bypass, or pointer switch.
    throw new Error(`Existing release ${args.version} conflicts with the approved Draft Release`)
  }
}

function trustedSha256Digests(identity: DraftReleaseIdentity): Map<string, string> {
  return new Map(identity.assets.map(asset => [asset.name, asset.sha256]))
}

async function matchesTrustedDigests(directory: string, digests: Map<string, string>): Promise<boolean> {
  for (const name of RELEASE_ASSET_NAMES) {
    if (await sha256(join(directory, name)) !== digests.get(name)) return false
  }
  return true
}

async function downloadAssets(
  apiBase: string,
  repository: string,
  assets: Map<string, GitHubAsset>,
  destination: string,
  token: string,
  chunkBytes: number,
  concurrency: number,
): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const name of RELEASE_ASSET_NAMES) {
    await downloadAsset(
      apiBase,
      repository,
      assets.get(name)!,
      join(destination, name),
      token,
      chunkBytes,
      concurrency,
    )
  }
}

async function assertPeakCapacity(releasesDir: string, additionalBytes: number): Promise<void> {
  const filesystem = await statfs(releasesDir)
  const usage = projectedDiskUsage(
    Number(filesystem.blocks),
    Number(filesystem.bfree),
    Number(filesystem.bsize),
    additionalBytes,
  )
  if (usage > MAX_DISK_USAGE) {
    throw new Error(
      `Refusing release pull: projected peak releases volume use is ${Math.ceil(usage * 100)}% `
      + `(limit ${MAX_DISK_USAGE * 100}%)`,
    )
  }
}

export async function pullRelease(options: ReleasePullOptions): Promise<'published' | 'idempotent'> {
  const token = options.token ?? process.env.GH_TOKEN
  const normalized = {
    ...options,
    commitSha: options.commitSha.toLowerCase(),
    token,
  }
  const approvedIdentity = approvedDraftIdentity(normalized)
  const apiBase = normalizeApiBase(options.apiBase ?? 'https://api.github.com')
  const [tagCommit, release] = await Promise.all([
    getJson<GitHubCommit>(`${apiBase}/repos/${normalized.repository}/commits/${normalized.tag}`, token!),
    getJson<GitHubRelease>(`${apiBase}/repos/${normalized.repository}/releases/${normalized.releaseId}`, token!),
  ])
  if (typeof tagCommit.sha !== 'string' || tagCommit.sha.toLowerCase() !== normalized.commitSha) {
    throw new Error('Git tag does not point at the requested commit')
  }
  const assets = assertDraftRelease(release, normalized, apiBase, approvedIdentity)
  const releasesDir = resolve(options.releasesDir ?? '/data/releases')
  const incomingRoot = join(releasesDir, 'electron', '.incoming')
  const incoming = join(incomingRoot, normalized.version)
  const stage = join(incomingRoot, `.${normalized.version}.download-${process.pid}-${Date.now()}`)
  const destination = join(releasesDir, 'electron', 'releases', normalized.version)
  const publishArgs: ReleaseArguments = {
    source: incoming,
    releasesDir,
    version: normalized.version,
    repository: normalized.repository,
    tag: normalized.tag,
    commitSha: normalized.commitSha,
  }
  const trustedDigests = trustedSha256Digests(approvedIdentity)
  if (await existingPublishedReleaseIsApproved(destination, publishArgs, assets, trustedDigests)) {
    // An interrupted caller may have published the exact immutable directory
    // but lost its Service Exec result. Resume from it before any capacity
    // preflight or download; publish keeps the usual locked pointer semantics.
    const result = await publish({ ...publishArgs, source: destination }, options.publisherOptions)
    try {
      await (options.incomingCleanup ?? ((path: string) => rm(path, { recursive: true, force: true })))(incoming)
    } catch {
      console.warn(`Release ${normalized.version} resumed; incoming cleanup will be retried later`)
    }
    return result
  }
  const reusableIncoming = await existingIncomingIsReusable(incoming, publishArgs, assets)
  let createdIncoming = false
  try {
    const assetBytes = RELEASE_ASSET_NAMES.reduce((total, name) => total + assets.get(name)!.size, 0)
    if (reusableIncoming) {
      await (options.peakCapacityCheck ?? assertPeakCapacity)(releasesDir, assetBytes)
      if (!(await matchesTrustedDigests(incoming, trustedDigests))) {
        throw new Error(`Incoming release ${normalized.version} differs from the approved Draft SHA-256 digests`)
      }
    } else {
      await (options.peakCapacityCheck ?? assertPeakCapacity)(releasesDir, assetBytes * 2)
      await downloadAssets(
        apiBase,
        normalized.repository,
        assets,
        stage,
        token!,
        options.signedDownloadChunkBytes ?? DEFAULT_SIGNED_DOWNLOAD_CHUNK_BYTES,
        options.signedDownloadConcurrency ?? DEFAULT_SIGNED_DOWNLOAD_CONCURRENCY,
      )
      if (!(await matchesTrustedDigests(stage, trustedDigests))) {
        throw new Error(`Downloaded release assets differ from the approved Draft SHA-256 digests`)
      }
      await validateSource(stage, publishArgs)
      await rename(stage, incoming)
      createdIncoming = true
    }
    const result = await publish(publishArgs, options.publisherOptions)
    try {
      // A validated pre-existing incoming directory is safe to reuse for this
      // publish, but it is not durable state. Retrying this cleanup on a later
      // idempotent pull prevents a transient post-switch error from filling
      // the PVC while never turning a completed atomic switch into a failure.
      await (options.incomingCleanup ?? ((path: string) => rm(path, { recursive: true, force: true })))(incoming)
    } catch {
      console.warn(`Release ${normalized.version} published; incoming cleanup will be retried later`)
    }
    return result
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    if (createdIncoming) await rm(incoming, { recursive: true, force: true })
    throw error
  }
}

function required(values: Record<string, string | undefined>, key: string): string {
  const value = values[key]
  if (!value) throw new Error(`Missing --${key}`)
  return value
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repo: { type: 'string' },
      tag: { type: 'string' },
      version: { type: 'string' },
      commit: { type: 'string' },
      'release-id': { type: 'string' },
      'asset-identity': { type: 'string' },
    },
    strict: true,
  })
  const result = await pullRelease({
    repository: required(values, 'repo'),
    tag: required(values, 'tag'),
    version: required(values, 'version'),
    commitSha: required(values, 'commit'),
    releaseId: Number(required(values, 'release-id')),
    assetIdentity: required(values, 'asset-identity'),
  })
  console.log(`Release ${required(values, 'version')}: ${result}`)
}

if (import.meta.main) await main()
