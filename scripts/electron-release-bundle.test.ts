import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { load } from 'js-yaml'
import { prepareReleaseBundle, verifyPublishedRelease } from './electron-release-bundle'
import { parseReleaseContract } from './electron-release-contract'

describe('release bundle assembly and public verification', () => {
  it('builds the complete desktop bundle and verifies every latest resource over HEAD/GET', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-bundle-'))
    const input = join(root, 'input')
    const output = join(root, 'output')
    await mkdir(input)
    try {
      const contents = {
        'Polo-AI-x64.zip': 'macOS update bytes',
        'Polo-AI-arm64.zip': 'macOS Apple Silicon update bytes',
        'Polo-AI-x64.dmg': 'macOS Intel DMG bytes',
        'Polo-AI-arm64.dmg': 'macOS Apple Silicon DMG bytes',
        'Polo-AI-x64.AppImage': 'Linux bytes',
        'Polo-AI-x64.exe': 'Windows bytes',
      }
      for (const [name, value] of Object.entries(contents)) await writeFile(join(input, name), value)
      const macZipHash = createHash('sha512').update(contents['Polo-AI-x64.zip']).digest('base64')
      const macDmgHash = createHash('sha512').update(contents['Polo-AI-x64.dmg']).digest('base64')
      const linuxHash = createHash('sha512').update(contents['Polo-AI-x64.AppImage']).digest('base64')
      // Each macOS build uploads its own single-arch manifest; prepare merges
      // them into the published latest-mac.yml.
      await writeFile(
        join(input, 'latest-mac.yml'),
        `version: 0.15.2\nfiles:\n  - url: Polo-AI-x64.dmg\n    sha512: ${macDmgHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.dmg'])}\n  - url: Polo-AI-x64.zip\n    sha512: ${macZipHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.zip'])}\npath: Polo-AI-x64.zip\nsha512: ${macZipHash}\n`,
      )
      const arm64ZipHash = createHash('sha512').update(contents['Polo-AI-arm64.zip']).digest('base64')
      const arm64DmgHash = createHash('sha512').update(contents['Polo-AI-arm64.dmg']).digest('base64')
      await writeFile(
        join(input, 'latest-mac-arm64.yml'),
        `version: 0.15.2\nfiles:\n  - url: Polo-AI-arm64.zip\n    sha512: ${arm64ZipHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-arm64.zip'])}\n  - url: Polo-AI-arm64.dmg\n    sha512: ${arm64DmgHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-arm64.dmg'])}\npath: Polo-AI-arm64.zip\nsha512: ${arm64ZipHash}\n`,
      )
      await writeFile(
        join(input, 'latest-linux.yml'),
        `version: 0.15.2\nfiles:\n  - url: Polo-AI-x64.AppImage\n    sha512: ${linuxHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.AppImage'])}\npath: Polo-AI-x64.AppImage\nsha512: ${linuxHash}\n`,
      )
      const installScript = join(root, 'install-app.sh')
      await writeFile(installScript, '#!/bin/sh\n')
      const expected = {
        repository: 'polo/polo',
        tag: 'v0.15.2',
        version: '0.15.2',
        commitSha: 'a'.repeat(40),
      }
      await prepareReleaseBundle({
        ...expected,
        inputDir: input,
        outputDir: output,
        installScript,
        publishedAt: '2026-08-07T12:00:00.000Z',
      })
      expect((await readdir(output)).sort()).toHaveLength(10)

      // POL-268: the published manifest must carry both architecture ZIPs,
      // each bound to the final assembled bytes, with the x64 ZIP remaining
      // the legacy top-level path/sha512 entry.
      const publishedManifest = load(
        await readFile(join(output, 'latest-mac.yml'), 'utf8'),
      ) as { files: Array<{ url: string, size: number, sha512: string }>, path: string }
      expect(publishedManifest.files.map(entry => entry.url)).toEqual([
        'Polo-AI-x64.dmg',
        'Polo-AI-x64.zip',
        'Polo-AI-arm64.zip',
        'Polo-AI-arm64.dmg',
      ])
      expect(publishedManifest.files.find(entry => entry.url === 'Polo-AI-arm64.zip')).toEqual({
        url: 'Polo-AI-arm64.zip',
        sha512: arm64ZipHash,
        size: Buffer.byteLength(contents['Polo-AI-arm64.zip']),
      })
      expect(publishedManifest.path).toBe('Polo-AI-x64.zip')

      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response('Method not allowed', { status: 405 })
          }
          const name = basename(new URL(request.url).pathname)
          const file = Bun.file(join(output, name))
          if (!(await file.exists())) return new Response('Not found', { status: 404 })
          const headers = {
            'content-length': String(file.size),
            'cache-control': 'no-cache',
          }
          return request.method === 'HEAD'
            ? new Response(null, { headers })
            : new Response(file, { headers })
        },
      })
      try {
        const verified = await verifyPublishedRelease(
          `http://127.0.0.1:${server.port}/electron/latest`,
          expected,
        )
        expect(verified.version).toBe('0.15.2')
        expect(verified.schemaVersion).toBe(3)
        expect(verified.artifacts.macosArm64Zip.fileName).toBe('Polo-AI-arm64.zip')
      } finally {
        server.stop(true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails the bundle when the arm64 updater ZIP is missing from the inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-bundle-'))
    const input = join(root, 'input')
    const output = join(root, 'output')
    await mkdir(input)
    try {
      const contents = {
        'Polo-AI-x64.zip': 'macOS update bytes',
        'Polo-AI-x64.dmg': 'macOS Intel DMG bytes',
        'Polo-AI-arm64.dmg': 'macOS Apple Silicon DMG bytes',
        'Polo-AI-x64.AppImage': 'Linux bytes',
        'Polo-AI-x64.exe': 'Windows bytes',
      }
      for (const [name, value] of Object.entries(contents)) await writeFile(join(input, name), value)
      const macZipHash = createHash('sha512').update(contents['Polo-AI-x64.zip']).digest('base64')
      const macDmgHash = createHash('sha512').update(contents['Polo-AI-x64.dmg']).digest('base64')
      await writeFile(
        join(input, 'latest-mac.yml'),
        `version: 0.15.2\nfiles:\n  - url: Polo-AI-x64.dmg\n    sha512: ${macDmgHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.dmg'])}\n  - url: Polo-AI-x64.zip\n    sha512: ${macZipHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.zip'])}\npath: Polo-AI-x64.zip\nsha512: ${macZipHash}\n`,
      )
      const arm64DmgHash = createHash('sha512').update(contents['Polo-AI-arm64.dmg']).digest('base64')
      await writeFile(
        join(input, 'latest-mac-arm64.yml'),
        `version: 0.15.2\nfiles:\n  - url: Polo-AI-arm64.dmg\n    sha512: ${arm64DmgHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-arm64.dmg'])}\npath: Polo-AI-arm64.dmg\nsha512: ${arm64DmgHash}\n`,
      )
      const linuxHash = createHash('sha512').update(contents['Polo-AI-x64.AppImage']).digest('base64')
      await writeFile(
        join(input, 'latest-linux.yml'),
        `version: 0.15.2\nfiles:\n  - url: Polo-AI-x64.AppImage\n    sha512: ${linuxHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.AppImage'])}\npath: Polo-AI-x64.AppImage\nsha512: ${linuxHash}\n`,
      )
      const installScript = join(root, 'install-app.sh')
      await writeFile(installScript, '#!/bin/sh\n')

      // POL-268 recurrence gate: a build that contributes no arm64 updater
      // ZIP must fail the release before any Draft is created.
      await expect(prepareReleaseBundle({
        repository: 'polo/polo',
        tag: 'v0.15.2',
        version: '0.15.2',
        commitSha: 'a'.repeat(40),
        inputDir: input,
        outputDir: output,
        installScript,
        publishedAt: '2026-08-07T12:00:00.000Z',
      })).rejects.toThrow('must reference exactly')
      await expect(readdir(output)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('published manifest verification gate', () => {
  it('rejects a live feed whose latest-mac.yml omits the arm64 updater ZIP', async () => {
    const expected = {
      repository: 'polo/polo',
      tag: 'v0.15.2',
      version: '0.15.2',
      commitSha: 'a'.repeat(40),
    }
    const x64OnlyManifest = `version: 0.15.2\nfiles:\n  - url: Polo-AI-x64.zip\n    sha512: ${'g'.repeat(86)}\n    size: 3\npath: Polo-AI-x64.zip\nsha512: ${'g'.repeat(86)}\n`
    let requestCount = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount += 1
        const name = basename(new URL(request.url).pathname)
        if (name === 'release-contract.json') {
          return Response.json(parseReleaseContract({
            schemaVersion: 3,
            repository: expected.repository,
            tag: expected.tag,
            version: expected.version,
            commitSha: expected.commitSha,
            publishedAt: '2026-08-07T12:00:00.000Z',
            artifacts: {
              macosZip: { fileName: 'Polo-AI-x64.zip', sha256: '1'.repeat(64) },
              macosArm64Zip: { fileName: 'Polo-AI-arm64.zip', sha256: '2'.repeat(64) },
              macosX64Dmg: { fileName: 'Polo-AI-x64.dmg', sha256: '3'.repeat(64) },
              macosArm64Dmg: { fileName: 'Polo-AI-arm64.dmg', sha256: '4'.repeat(64) },
              linuxAppImage: { fileName: 'Polo-AI-x64.AppImage', sha256: '5'.repeat(64) },
              windowsExe: { fileName: 'Polo-AI-x64.exe', sha256: '6'.repeat(64) },
            },
            installApp: { fileName: 'install-app.sh', sha256: '7'.repeat(64) },
          }), { headers: { 'cache-control': 'no-cache' } })
        }
        if (name === 'latest-mac.yml') {
          return new Response(x64OnlyManifest, { headers: { 'cache-control': 'no-cache' } })
        }
        return new Response('Not found', { status: 404 })
      },
    })
    try {
      await expect(verifyPublishedRelease(`http://127.0.0.1:${server.port}/electron/latest`, expected))
        .rejects.toThrow('must reference Polo-AI-arm64.zip')
      expect(requestCount).toBeGreaterThan(1)
    } finally {
      server.stop(true)
    }
  })
})
