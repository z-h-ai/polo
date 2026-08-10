import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { prepareReleaseBundle } from './electron-release-bundle'
import { pullRelease, RELEASE_ASSET_NAMES } from './polo-release-pull'

const releaseId = 42

const repository = 'polo/polo'
const version = '1.0.0'
const tag = `v${version}`
const commitSha = 'a'.repeat(40)

async function createDraftAssets(root: string, variant = 'A'): Promise<string> {
  const input = join(root, 'input')
  const output = join(root, 'draft')
  await mkdir(input, { recursive: true })
  const contents = {
    'Polo-AI-x64.zip': `macOS zip ${variant}`,
    'Polo-AI-x64.dmg': `macOS x64 dmg ${variant}`,
    'Polo-AI-arm64.dmg': `macOS arm64 dmg ${variant}`,
    'Polo-AI-x64.AppImage': `Linux AppImage ${variant}`,
    'Polo-AI-x64.exe': `Windows NSIS ${variant}`,
  }
  for (const [name, value] of Object.entries(contents)) await writeFile(join(input, name), value)
  const macZipHash = createHash('sha512').update(contents['Polo-AI-x64.zip']).digest('base64')
  const macDmgHash = createHash('sha512').update(contents['Polo-AI-x64.dmg']).digest('base64')
  const linuxHash = createHash('sha512').update(contents['Polo-AI-x64.AppImage']).digest('base64')
  await writeFile(join(input, 'latest-mac.yml'), `version: ${version}\nfiles:\n  - url: Polo-AI-x64.dmg\n    sha512: ${macDmgHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.dmg'])}\n  - url: Polo-AI-x64.zip\n    sha512: ${macZipHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.zip'])}\npath: Polo-AI-x64.zip\nsha512: ${macZipHash}\n`)
  await writeFile(join(input, 'latest-linux.yml'), `version: ${version}\nfiles:\n  - url: Polo-AI-x64.AppImage\n    sha512: ${linuxHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.AppImage'])}\npath: Polo-AI-x64.AppImage\nsha512: ${linuxHash}\n`)
  const installScript = join(root, 'install-app.sh')
  await writeFile(installScript, '#!/bin/sh\n')
  await prepareReleaseBundle({
    inputDir: input,
    outputDir: output,
    installScript,
    repository,
    tag,
    version,
    commitSha,
    publishedAt: '2026-08-08T00:00:00.000Z',
  })
  return output
}

async function approvedDraftIdentity(assetsDir: string): Promise<string> {
  return JSON.stringify({
    releaseId,
    assets: await Promise.all(RELEASE_ASSET_NAMES.map(async (name, index) => ({
      id: index + 1,
      name,
      size: (await Bun.file(join(assetsDir, name)).arrayBuffer()).byteLength,
      sha256: createHash('sha256').update(Buffer.from(await Bun.file(join(assetsDir, name)).arrayBuffer())).digest('hex'),
    }))),
  })
}

function startDraftServer(
  assetsDir: string,
  options: {
    signedFailure?: boolean
    signedSuccess?: boolean
    includeDigests?: boolean
    assetRequests?: { count: number }
    rangeRequests?: { count: number }
  } = {},
): ReturnType<typeof Bun.serve> {
  let server: ReturnType<typeof Bun.serve>
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === `/repos/${repository}/commits/${tag}`) {
        expect(request.headers.get('authorization')).toBe('Bearer test-token')
        return Response.json({ sha: commitSha })
      }
      if (pathname === `/repos/${repository}/releases/${releaseId}`) {
        expect(request.headers.get('authorization')).toBe('Bearer test-token')
        return Response.json({
          id: releaseId,
          draft: true,
          tag_name: tag,
          target_commitish: commitSha,
          assets: await Promise.all(RELEASE_ASSET_NAMES.map(async (name, index) => ({
            id: index + 1,
            name,
            size: (await Bun.file(join(assetsDir, name)).arrayBuffer()).byteLength,
            state: 'uploaded',
            url: `http://127.0.0.1:${server.port}/repos/${repository}/releases/assets/${index + 1}`,
            ...(options.includeDigests
              ? { digest: `sha256:${createHash('sha256').update(Buffer.from(await Bun.file(join(assetsDir, name)).arrayBuffer())).digest('hex')}` }
              : {}),
          }))),
        })
      }
      const match = pathname.match(new RegExp(`^/repos/${repository}/releases/assets/(\\d+)$`))
      if (match) {
        if (options.assetRequests) options.assetRequests.count += 1
        expect(request.headers.get('authorization')).toBe('Bearer test-token')
        if (options.signedFailure || options.signedSuccess) {
          return new Response(null, {
            status: 302,
            headers: { location: `/signed-object/${match[1]}?X-Amz-Signature=super-secret-${match[1]}` },
          })
        }
        return new Response(Bun.file(join(assetsDir, RELEASE_ASSET_NAMES[Number(match[1]) - 1]!)))
      }
      const signedMatch = pathname.match(/^\/signed-object\/(\d+)$/)
      if (signedMatch) {
        expect(request.headers.get('authorization')).toBeNull()
        if (options.signedFailure) return new Response('object-store failed', { status: 503 })
        if (options.rangeRequests) options.rangeRequests.count += 1
        const name = RELEASE_ASSET_NAMES[Number(signedMatch[1]) - 1]!
        const bytes = Buffer.from(await Bun.file(join(assetsDir, name)).arrayBuffer())
        const range = request.headers.get('range')?.match(/^bytes=(\d+)-(\d+)$/)
        if (!range) return new Response('range required', { status: 400 })
        const start = Number(range[1])
        const end = Number(range[2])
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= bytes.length) {
          return new Response('invalid range', { status: 416 })
        }
        const body = bytes.subarray(start, end + 1)
        return new Response(body, {
          status: 206,
          headers: {
            'accept-ranges': 'bytes',
            'content-length': String(body.byteLength),
            'content-range': `bytes ${start}-${end}/${bytes.length}`,
          },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  return server
}

describe('Zeabur Draft Release puller', () => {
  it('downloads only the strict asset whitelist, validates it, and atomically publishes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-'))
    const volume = join(root, 'volume')
    const assetsDir = await createDraftAssets(root)
    await mkdir(volume)
    const server = startDraftServer(assetsDir)
    try {
      const result = await pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
        publisherOptions: { capacityCheck: async () => {} },
      })
      expect(result).toBe('published')
      expect(await readlink(join(volume, 'electron', 'latest'))).toBe(`releases/${version}`)
      expect(await readdir(join(volume, 'electron', 'releases', version))).toHaveLength(9)
      expect(await readdir(join(volume, 'electron', '.incoming'))).toEqual([])
      expect(JSON.parse(await readFile(join(volume, 'electron', 'latest', 'release-contract.json'), 'utf8')).version).toBe(version)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('redacts signed object-store failures and keeps the incoming directory absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-signed-failure-'))
    const volume = join(root, 'volume')
    const assetsDir = await createDraftAssets(root)
    await mkdir(volume)
    const server = startDraftServer(assetsDir, { signedFailure: true })
    try {
      const error = await pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
        signedDownloadChunkBytes: 4,
        signedDownloadConcurrency: 4,
      }).then(() => undefined, reason => reason as Error)
      expect(error).toBeInstanceOf(Error)
      expect(error!.message).toBe('Unable to download signed GitHub release asset: Polo-AI-x64.dmg')
      expect(error!.message).not.toContain('X-Amz-Signature')
      expect(error!.message).not.toContain('super-secret')
      await expect(readdir(join(volume, 'electron', '.incoming'))).resolves.toEqual([])
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reassembles signed object-store assets from bounded byte ranges without forwarding the token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-signed-ranges-'))
    const volume = join(root, 'volume')
    const assetsDir = await createDraftAssets(root)
    await mkdir(volume)
    const rangeRequests = { count: 0 }
    const server = startDraftServer(assetsDir, { signedSuccess: true, rangeRequests })
    try {
      const result = await pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
        publisherOptions: { capacityCheck: async () => {} },
        signedDownloadChunkBytes: 64,
        signedDownloadConcurrency: 4,
      })
      expect(result).toBe('published')
      expect(rangeRequests.count).toBeGreaterThan(RELEASE_ASSET_NAMES.length)
      for (const name of RELEASE_ASSET_NAMES) {
        expect(await readFile(join(volume, 'electron', 'releases', version, name))).toEqual(await readFile(join(assetsDir, name)))
      }
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('checks peak capacity before downloads and removes only its own incoming directory after publish failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-capacity-'))
    const volume = join(root, 'volume')
    const assetsDir = await createDraftAssets(root)
    await mkdir(volume)
    const server = startDraftServer(assetsDir)
    let requestedBytes = 0
    try {
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async (_releasesDir, bytes) => {
          requestedBytes = bytes
          throw new Error('peak capacity exceeded')
        },
      })).rejects.toThrow('peak capacity exceeded')
      expect(requestedBytes).toBeGreaterThan(0)
      await expect(readdir(join(volume, 'electron', '.incoming'))).rejects.toThrow()

      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
        publisherOptions: { capacityCheck: async () => { throw new Error('publisher failed') } },
      })).rejects.toThrow('publisher failed')
      await expect(readdir(join(volume, 'electron', '.incoming'))).resolves.toEqual([])
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reuses only a fully validated matching incoming directory without downloading again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-retry-'))
    const volume = join(root, 'volume')
    const assetsDir = await createDraftAssets(root)
    const incoming = join(volume, 'electron', '.incoming', version)
    await mkdir(join(volume, 'electron', '.incoming'), { recursive: true })
    await cp(assetsDir, incoming, { recursive: true })
    const server = startDraftServer(assetsDir, { signedFailure: true, includeDigests: true })
    try {
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
        publisherOptions: { capacityCheck: async () => {} },
      })).resolves.toBe('published')
      expect(await readlink(join(volume, 'electron', 'latest'))).toBe(`releases/${version}`)
      await expect(readdir(incoming)).rejects.toThrow()
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resumes an exact existing published release before capacity preflight or any download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-existing-release-'))
    const volume = join(root, 'volume')
    const assetsDir = await createDraftAssets(root)
    const destination = join(volume, 'electron', 'releases', version)
    const assetRequests = { count: 0 }
    let capacityChecks = 0
    await mkdir(join(volume, 'electron', 'releases'), { recursive: true })
    await cp(assetsDir, destination, { recursive: true })
    const server = startDraftServer(assetsDir, { signedFailure: true, assetRequests })
    try {
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => { capacityChecks += 1 },
        publisherOptions: { capacityCheck: async () => { throw new Error('publisher capacity should not run') } },
      })).resolves.toBe('idempotent')
      expect(capacityChecks).toBe(0)
      expect(assetRequests.count).toBe(0)
      expect(await readlink(join(volume, 'electron', 'latest'))).toBe(`releases/${version}`)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a conflicting existing release before capacity preflight or new-byte download', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-existing-conflict-'))
    const volume = join(root, 'volume')
    const oldAssets = await createDraftAssets(join(root, 'old'), 'A')
    const approvedAssets = await createDraftAssets(join(root, 'approved'), 'B')
    const destination = join(volume, 'electron', 'releases', version)
    const assetRequests = { count: 0 }
    let capacityChecks = 0
    await mkdir(join(volume, 'electron', 'releases'), { recursive: true })
    await cp(oldAssets, destination, { recursive: true })
    const server = startDraftServer(approvedAssets, { assetRequests })
    try {
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(approvedAssets),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => { capacityChecks += 1 },
      })).rejects.toThrow('Existing release 1.0.0 conflicts with the approved Draft Release')
      expect(capacityChecks).toBe(0)
      expect(assetRequests.count).toBe(0)
      await expect(readlink(join(volume, 'electron', 'latest'))).rejects.toThrow()

      // A partially written directory is also a conflict, not a missing
      // retry source that can proceed to a new-byte capacity/download path.
      await rm(join(destination, 'Polo-AI-arm64.dmg'))
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(approvedAssets),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => { capacityChecks += 1 },
      })).rejects.toThrow('Existing release 1.0.0 conflicts with the approved Draft Release')
      expect(capacityChecks).toBe(0)
      expect(assetRequests.count).toBe(0)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a current Draft whose approved identity has the same sizes but different bytes before PVC writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-byte-compare-'))
    const volume = join(root, 'volume')
    const oldAssets = await createDraftAssets(join(root, 'old'), 'A')
    const currentAssets = await createDraftAssets(join(root, 'current'), 'B')
    const incoming = join(volume, 'electron', '.incoming', version)
    await mkdir(join(volume, 'electron', '.incoming'), { recursive: true })
    await cp(oldAssets, incoming, { recursive: true })
    const server = startDraftServer(currentAssets)
    try {
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(currentAssets),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
        publisherOptions: { capacityCheck: async () => {} },
      })).rejects.toThrow('differs from the approved Draft SHA-256 digests')
      expect(await readdir(incoming)).toHaveLength(9)
      await expect(readlink(join(volume, 'electron', 'latest'))).rejects.toThrow()
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fetches the approved Draft by release ID and rejects changed asset IDs before downloading or writing the PVC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-identity-mismatch-'))
    const volume = join(root, 'volume')
    const assetsDir = await createDraftAssets(root)
    const assetRequests = { count: 0 }
    await mkdir(volume)
    const server = startDraftServer(assetsDir, { assetRequests })
    try {
      const identity = JSON.parse(await approvedDraftIdentity(assetsDir))
      identity.assets[0].id = 999
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: JSON.stringify(identity),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
      })).rejects.toThrow('Current Draft Release asset identity does not match the approved Draft')
      expect(assetRequests.count).toBe(0)
      await expect(readdir(join(volume, 'electron', '.incoming'))).rejects.toThrow()
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects changed bytes against the approved digest before moving the downloaded stage onto the PVC', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-digest-mismatch-'))
    const volume = join(root, 'volume')
    const approvedAssets = await createDraftAssets(join(root, 'approved'), 'A')
    const changedAssets = await createDraftAssets(join(root, 'changed'), 'B')
    await mkdir(volume)
    const server = startDraftServer(changedAssets)
    try {
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(approvedAssets),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
      })).rejects.toThrow('Downloaded release assets differ from the approved Draft SHA-256 digests')
      await expect(readdir(join(volume, 'electron', '.incoming'))).resolves.toEqual([])
      await expect(readlink(join(volume, 'electron', 'latest'))).rejects.toThrow()
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats post-publish incoming cleanup as best effort after the latest pointer has switched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-cleanup-'))
    const volume = join(root, 'volume')
    const assetsDir = await createDraftAssets(root)
    await mkdir(volume)
    const server = startDraftServer(assetsDir)
    try {
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
        publisherOptions: { capacityCheck: async () => {} },
        incomingCleanup: async () => { throw new Error('simulated cleanup failure') },
      })).resolves.toBe('published')
      expect(await readlink(join(volume, 'electron', 'latest'))).toBe(`releases/${version}`)
      expect(await readdir(join(volume, 'electron', '.incoming', version))).toHaveLength(9)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries cleanup after an idempotent reuse when the first post-publish cleanup failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-pull-cleanup-retry-'))
    const volume = join(root, 'volume')
    const assetsDir = await createDraftAssets(root)
    await mkdir(volume)
    const server = startDraftServer(assetsDir, { includeDigests: true })
    let cleanupCalls = 0
    try {
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
        publisherOptions: { capacityCheck: async () => {} },
        incomingCleanup: async () => {
          cleanupCalls += 1
          throw new Error('first cleanup is unavailable')
        },
      })).resolves.toBe('published')
      const incoming = join(volume, 'electron', '.incoming', version)
      expect(await readdir(incoming)).toHaveLength(9)

      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releaseId,
        assetIdentity: await approvedDraftIdentity(assetsDir),
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
        publisherOptions: { capacityCheck: async () => {} },
      })).resolves.toBe('idempotent')
      expect(cleanupCalls).toBe(1)
      await expect(readdir(incoming)).rejects.toThrow()
      expect(await readlink(join(volume, 'electron', 'latest'))).toBe(`releases/${version}`)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
})
