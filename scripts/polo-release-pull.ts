#!/usr/bin/env bun

import { createWriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseStrictSemverTag } from './strict-semver'
import { sha256 } from './electron-release-contract'
import {
  publish,
  projectedDiskUsage,
  validateSource,
  MAX_DISK_USAGE,
  type PublisherOptions,
  type ReleaseArguments,
} from './publish-electron-release'

export const RELEASE_ASSET_NAMES = [
  'Polo-AI-x64.dmg',
  'Polo-AI-x64.zip',
  'Polo-AI-arm64.dmg',
  'Polo-AI-x64.AppImage',
  'Polo-AI-x64.exe',
  'latest-mac.yml',
  'latest-linux.yml',
  'install-app.sh',
  'release-contract.json',
] as const

const COMMIT_PATTERN = /^[a-f0-9]{40}$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

interface GitHubAsset {
  id: number
  name: string
  size: number
  state: string
  url: string
  digest?: string
}

interface GitHubRelease {
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
  releasesDir?: string
  apiBase?: string
  token?: string
  publisherOptions?: PublisherOptions
  peakCapacityCheck?: (releasesDir: string, additionalBytes: number) => Promise<void>
  incomingCleanup?: (incoming: string) => Promise<void>
}

function normalizeApiBase(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('GitHub API base must use HTTP(S)')
  }
  return url.toString().replace(/\/$/, '')
}

function assertInput(options: ReleasePullOptions): void {
  if (!REPOSITORY_PATTERN.test(options.repository)) throw new Error('Repository is invalid')
  if (parseStrictSemverTag(options.tag) !== options.version) {
    throw new Error('Tag and strict SemVer version do not match')
  }
  if (!COMMIT_PATTERN.test(options.commitSha)) throw new Error('Commit SHA is invalid')
  if (!options.token) throw new Error('GH_TOKEN is required to read Draft Release assets')
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
  options: Required<Pick<ReleasePullOptions, 'repository' | 'tag' | 'version' | 'commitSha'>>,
  apiBase: string,
): Map<string, GitHubAsset> {
  if (!release.draft) throw new Error('Release pull accepts only a Draft GitHub Release')
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
      || (asset.digest !== undefined && typeof asset.digest !== 'string')
    ) {
      throw new Error('Draft Release contains an invalid or non-whitelisted asset')
    }
    const expectedUrl = new URL(
      `/repos/${options.repository}/releases/assets/${asset.id}`,
      `${apiBase}/`,
    ).toString()
    if (asset.url !== expectedUrl || assets.has(asset.name)) {
      throw new Error('Draft Release asset URL or names are invalid')
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
): Promise<void> {
  const url = new URL(`/repos/${repository}/releases/assets/${asset.id}`, `${apiBase}/`).toString()
  let response = await fetch(url, { headers: apiHeaders(token, true), redirect: 'manual' })
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (!location) throw new Error('GitHub asset download redirect is missing its location')
    try {
      // GitHub redirects the API request to a short-lived object-store URL. Do
      // not forward the Draft Release token beyond the GitHub API origin.
      response = await fetch(new URL(location, url), {
        headers: { accept: 'application/octet-stream' },
        redirect: 'error',
      })
      if (!response.ok || !response.body) throw new Error('signed object-store response failed')
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination, { flags: 'wx' }))
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

function trustedSha256Digests(assets: Map<string, GitHubAsset>): Map<string, string> | undefined {
  const digests = new Map<string, string>()
  for (const name of RELEASE_ASSET_NAMES) {
    const digest = assets.get(name)!.digest
    if (digest === undefined) return undefined
    const match = digest.match(/^sha256:([a-f0-9]{64})$/)
    if (!match) throw new Error(`Draft Release asset has an invalid SHA-256 digest: ${name}`)
    digests.set(name, match[1]!)
  }
  return digests
}

async function matchesTrustedDigests(directory: string, digests: Map<string, string>): Promise<boolean> {
  for (const name of RELEASE_ASSET_NAMES) {
    if (await sha256(join(directory, name)) !== digests.get(name)) return false
  }
  return true
}

async function sameAssetBytes(left: string, right: string): Promise<boolean> {
  for (const name of RELEASE_ASSET_NAMES) {
    if (await sha256(join(left, name)) !== await sha256(join(right, name))) return false
  }
  return true
}

async function downloadAssets(
  apiBase: string,
  repository: string,
  assets: Map<string, GitHubAsset>,
  destination: string,
  token: string,
): Promise<void> {
  await mkdir(destination, { recursive: true })
  for (const name of RELEASE_ASSET_NAMES) {
    await downloadAsset(apiBase, repository, assets.get(name)!, join(destination, name), token)
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
  assertInput(normalized)
  const apiBase = normalizeApiBase(options.apiBase ?? 'https://api.github.com')
  const [tagCommit, release] = await Promise.all([
    getJson<GitHubCommit>(`${apiBase}/repos/${normalized.repository}/commits/${normalized.tag}`, token!),
    getJson<GitHubRelease>(`${apiBase}/repos/${normalized.repository}/releases/tags/${normalized.tag}`, token!),
  ])
  if (typeof tagCommit.sha !== 'string' || tagCommit.sha.toLowerCase() !== normalized.commitSha) {
    throw new Error('Git tag does not point at the requested commit')
  }
  const assets = assertDraftRelease(release, normalized, apiBase)
  const releasesDir = resolve(options.releasesDir ?? '/data/releases')
  const incomingRoot = join(releasesDir, 'electron', '.incoming')
  const incoming = join(incomingRoot, normalized.version)
  const stage = join(incomingRoot, `.${normalized.version}.download-${process.pid}-${Date.now()}`)
  const publishArgs: ReleaseArguments = {
    source: incoming,
    releasesDir,
    version: normalized.version,
    repository: normalized.repository,
    tag: normalized.tag,
    commitSha: normalized.commitSha,
  }
  const reusableIncoming = await existingIncomingIsReusable(incoming, publishArgs, assets)
  let createdIncoming = false
  try {
    const assetBytes = RELEASE_ASSET_NAMES.reduce((total, name) => total + assets.get(name)!.size, 0)
    if (reusableIncoming) {
      const trustedDigests = trustedSha256Digests(assets)
      await (options.peakCapacityCheck ?? assertPeakCapacity)(releasesDir, assetBytes)
      if (trustedDigests) {
        if (!(await matchesTrustedDigests(incoming, trustedDigests))) {
          throw new Error(`Incoming release ${normalized.version} differs from the Draft Release SHA-256 digests`)
        }
      } else {
        await downloadAssets(apiBase, normalized.repository, assets, stage, token!)
        await validateSource(stage, publishArgs)
        if (!(await sameAssetBytes(stage, incoming))) {
          throw new Error(`Incoming release ${normalized.version} differs byte-for-byte from the Draft Release`)
        }
        await rm(stage, { recursive: true, force: true })
      }
    } else {
      await (options.peakCapacityCheck ?? assertPeakCapacity)(releasesDir, assetBytes * 2)
      await downloadAssets(apiBase, normalized.repository, assets, stage, token!)
      await validateSource(stage, publishArgs)
      await rename(stage, incoming)
      createdIncoming = true
    }
    const result = await publish(publishArgs, options.publisherOptions)
    if (createdIncoming) {
      try {
        await (options.incomingCleanup ?? ((path: string) => rm(path, { recursive: true, force: true })))(incoming)
      } catch {
        console.warn(`Release ${normalized.version} published; incoming cleanup will be retried later`)
      }
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
    },
    strict: true,
  })
  const result = await pullRelease({
    repository: required(values, 'repo'),
    tag: required(values, 'tag'),
    version: required(values, 'version'),
    commitSha: required(values, 'commit'),
  })
  console.log(`Release ${required(values, 'version')}: ${result}`)
}

if (import.meta.main) await main()
