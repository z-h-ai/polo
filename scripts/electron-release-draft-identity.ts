#!/usr/bin/env bun

import { lstat, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { sha256 } from './electron-release-contract'

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

export interface DraftAssetIdentity {
  id: number
  name: (typeof RELEASE_ASSET_NAMES)[number]
  size: number
  sha256: string
}

export interface DraftReleaseIdentity {
  releaseId: number
  assets: DraftAssetIdentity[]
}

interface GitHubDraftAsset {
  id: unknown
  name: unknown
  size: unknown
  state?: unknown
}

interface GitHubDraftRelease {
  id: unknown
  draft: unknown
  tag_name?: unknown
  target_commitish?: unknown
  assets: unknown
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const expectedAssetNames = new Set<string>(RELEASE_ASSET_NAMES)

function assertReleaseId(value: unknown, message: string): asserts value is number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(message)
}

function assertAssetIdentity(value: unknown): DraftAssetIdentity[] {
  if (!Array.isArray(value) || value.length !== RELEASE_ASSET_NAMES.length) {
    throw new Error('Approved Draft asset identity must contain the complete release whitelist')
  }
  const assets = value.map((asset): DraftAssetIdentity => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
      throw new Error('Approved Draft asset identity is invalid')
    }
    const item = asset as Partial<DraftAssetIdentity>
    if (
      !Number.isSafeInteger(item.id) || item.id! <= 0
      || typeof item.name !== 'string' || !expectedAssetNames.has(item.name)
      || !Number.isSafeInteger(item.size) || item.size! <= 0
      || typeof item.sha256 !== 'string' || !SHA256_PATTERN.test(item.sha256)
    ) {
      throw new Error('Approved Draft asset identity is invalid')
    }
    return {
      id: item.id,
      name: item.name as DraftAssetIdentity['name'],
      size: item.size,
      sha256: item.sha256,
    }
  })
  const names = new Set(assets.map(asset => asset.name))
  const ids = new Set(assets.map(asset => asset.id))
  if (names.size !== RELEASE_ASSET_NAMES.length || ids.size !== RELEASE_ASSET_NAMES.length) {
    throw new Error('Approved Draft asset identity has duplicate asset names or IDs')
  }
  return assets.sort((left, right) => left.name.localeCompare(right.name))
}

export function parseDraftReleaseIdentity(value: unknown): DraftReleaseIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Approved Draft release identity is invalid')
  }
  const identity = value as Partial<DraftReleaseIdentity>
  assertReleaseId(identity.releaseId, 'Approved Draft release ID is invalid')
  return { releaseId: identity.releaseId, assets: assertAssetIdentity(identity.assets) }
}

export async function createDraftReleaseIdentity(
  releaseDir: string,
  githubRelease: unknown,
): Promise<DraftReleaseIdentity> {
  const release = githubRelease as Partial<GitHubDraftRelease>
  if (!release || typeof release !== 'object' || Array.isArray(release) || release.draft !== true) {
    throw new Error('GitHub Release must remain a Draft while creating its approved identity')
  }
  assertReleaseId(release.id, 'GitHub Draft Release ID is invalid')
  if (!Array.isArray(release.assets) || release.assets.length !== RELEASE_ASSET_NAMES.length) {
    throw new Error('GitHub Draft Release assets do not match the release whitelist')
  }
  const byName = new Map<string, GitHubDraftAsset>()
  for (const asset of release.assets as GitHubDraftAsset[]) {
    if (
      !asset || typeof asset !== 'object'
      || !Number.isSafeInteger(asset.id) || asset.id <= 0
      || typeof asset.name !== 'string' || !expectedAssetNames.has(asset.name)
      || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || asset.state !== 'uploaded' || byName.has(asset.name)
    ) {
      throw new Error('GitHub Draft Release assets do not match the release whitelist')
    }
    byName.set(asset.name, asset)
  }
  const root = resolve(releaseDir)
  const assets = await Promise.all(RELEASE_ASSET_NAMES.map(async name => {
    const path = join(root, name)
    const file = await lstat(path)
    if (!file.isFile() || (await stat(path)).size !== byName.get(name)!.size) {
      throw new Error(`GitHub Draft Release asset does not match assembled bytes: ${name}`)
    }
    return {
      id: byName.get(name)!.id as number,
      name,
      size: byName.get(name)!.size as number,
      sha256: await sha256(path),
    }
  }))
  return parseDraftReleaseIdentity({ releaseId: release.id, assets })
}

export function assertApprovedReleaseIdentity(
  githubRelease: unknown,
  approvedIdentity: unknown,
  expected: { tag: string; commit: string; draft: boolean | 'either' },
): void {
  const identity = parseDraftReleaseIdentity(approvedIdentity)
  const release = githubRelease as Partial<GitHubDraftRelease>
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error('GitHub Release identity is invalid')
  }
  if (release.id !== identity.releaseId) {
    throw new Error('GitHub Release ID does not match the approved Draft identity')
  }
  if (expected.draft !== 'either' && release.draft !== expected.draft) {
    throw new Error(`GitHub Release draft state does not match the required ${expected.draft ? 'Draft' : 'published'} state`)
  }
  if (release.tag_name !== expected.tag || typeof release.target_commitish !== 'string'
    || release.target_commitish.toLowerCase() !== expected.commit.toLowerCase()) {
    throw new Error('GitHub Release tag or target commit does not match the approved Draft identity')
  }
  if (!Array.isArray(release.assets) || release.assets.length !== RELEASE_ASSET_NAMES.length) {
    throw new Error('GitHub Release assets do not match the approved Draft identity')
  }
  const actual = new Map<string, GitHubDraftAsset>()
  for (const asset of release.assets as GitHubDraftAsset[]) {
    if (!asset || typeof asset !== 'object' || typeof asset.name !== 'string' || actual.has(asset.name)) {
      throw new Error('GitHub Release assets do not match the approved Draft identity')
    }
    actual.set(asset.name, asset)
  }
  for (const asset of identity.assets) {
    const current = actual.get(asset.name)
    if (!current || current.id !== asset.id || current.name !== asset.name || current.size !== asset.size || current.state !== 'uploaded') {
      throw new Error(`GitHub Release asset does not match the approved Draft identity: ${asset.name}`)
    }
  }
}

async function main(): Promise<void> {
  const [command = 'create', ...argv] = process.argv.slice(2)
  const { values } = parseArgs({
    args: argv,
    options: {
      'release-dir': { type: 'string' },
      'github-release': { type: 'string' },
      output: { type: 'string' },
      identity: { type: 'string' },
      tag: { type: 'string' },
      commit: { type: 'string' },
      draft: { type: 'string' },
    },
    strict: true,
  })
  if (command === 'assert') {
    if (!values['github-release'] || !values.identity || !values.tag || !values.commit || !values.draft) {
      throw new Error('Usage: electron-release-draft-identity assert --github-release <json> --identity <json> --tag <tag> --commit <sha> --draft <true|false>')
    }
    if (values.draft !== 'true' && values.draft !== 'false' && values.draft !== 'either') throw new Error('--draft must be true, false, or either')
    assertApprovedReleaseIdentity(
      JSON.parse(await readFile(values['github-release'], 'utf8')),
      JSON.parse(values.identity),
      { tag: values.tag, commit: values.commit, draft: values.draft === 'either' ? 'either' : values.draft === 'true' },
    )
    return
  }
  if (command !== 'create' || !values['release-dir'] || !values['github-release'] || !values.output) {
    throw new Error('Usage: electron-release-draft-identity --release-dir <dir> --github-release <json> --output <json>')
  }
  const identity = await createDraftReleaseIdentity(
    values['release-dir'],
    JSON.parse(await readFile(values['github-release'], 'utf8')),
  )
  await writeFile(values.output, `${JSON.stringify(identity)}\n`)
}

if (import.meta.main) await main()
