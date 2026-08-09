import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { prepareReleaseBundle } from './electron-release-bundle'
import { pullRelease, RELEASE_ASSET_NAMES } from './polo-release-pull'

const repository = 'polo/polo'
const version = '1.0.0'
const tag = `v${version}`
const commitSha = 'a'.repeat(40)

async function createDraftAssets(root: string): Promise<string> {
  const input = join(root, 'input')
  const output = join(root, 'draft')
  await mkdir(input)
  const contents = {
    'Polo-AI-x64.zip': 'macOS zip',
    'Polo-AI-x64.dmg': 'macOS x64 dmg',
    'Polo-AI-arm64.dmg': 'macOS arm64 dmg',
    'Polo-AI-x64.AppImage': 'Linux AppImage',
    'Polo-AI-x64.exe': 'Windows NSIS',
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

function startDraftServer(assetsDir: string, signedFailure = false): ReturnType<typeof Bun.serve> {
  let server: ReturnType<typeof Bun.serve>
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)
      if (pathname === `/repos/${repository}/commits/${tag}`) {
        expect(request.headers.get('authorization')).toBe('Bearer test-token')
        return Response.json({ sha: commitSha })
      }
      if (pathname === `/repos/${repository}/releases/tags/${tag}`) {
        expect(request.headers.get('authorization')).toBe('Bearer test-token')
        return Response.json({
          draft: true,
          tag_name: tag,
          target_commitish: commitSha,
          assets: await Promise.all(RELEASE_ASSET_NAMES.map(async (name, index) => ({
            id: index + 1,
            name,
            size: (await Bun.file(join(assetsDir, name)).arrayBuffer()).byteLength,
            state: 'uploaded',
            url: `http://127.0.0.1:${server.port}/repos/${repository}/releases/assets/${index + 1}`,
          }))),
        })
      }
      const match = pathname.match(new RegExp(`^/repos/${repository}/releases/assets/(\\d+)$`))
      if (match) {
        expect(request.headers.get('authorization')).toBe('Bearer test-token')
        if (signedFailure) {
          return new Response(null, {
            status: 302,
            headers: { location: `/signed-object?X-Amz-Signature=super-secret-${match[1]}` },
          })
        }
        return new Response(Bun.file(join(assetsDir, RELEASE_ASSET_NAMES[Number(match[1]) - 1]!)))
      }
      if (pathname === '/signed-object') {
        expect(request.headers.get('authorization')).toBeNull()
        return new Response('object-store failed', { status: 503 })
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
    const server = startDraftServer(assetsDir, true)
    try {
      const error = await pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => {},
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
    const server = startDraftServer(assetsDir, true)
    try {
      await expect(pullRelease({
        repository,
        tag,
        version,
        commitSha,
        releasesDir: volume,
        apiBase: `http://127.0.0.1:${server.port}`,
        token: 'test-token',
        peakCapacityCheck: async () => { throw new Error('must not recalculate fresh-download capacity') },
        publisherOptions: { capacityCheck: async () => {} },
      })).resolves.toBe('published')
      expect(await readlink(join(volume, 'electron', 'latest'))).toBe(`releases/${version}`)
      expect(await readdir(incoming)).toHaveLength(9)
    } finally {
      server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
})
