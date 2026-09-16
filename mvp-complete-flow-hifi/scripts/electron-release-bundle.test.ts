import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { prepareReleaseBundle, verifyPublishedRelease } from './electron-release-bundle'

describe('release bundle assembly and public verification', () => {
  it('builds the complete desktop bundle and verifies every latest resource over HEAD/GET', async () => {
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
      const linuxHash = createHash('sha512').update(contents['Polo-AI-x64.AppImage']).digest('base64')
      await writeFile(
        join(input, 'latest-mac.yml'),
        `version: 0.15.2\nfiles:\n  - url: Polo-AI-x64.dmg\n    sha512: ${macDmgHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.dmg'])}\n  - url: Polo-AI-x64.zip\n    sha512: ${macZipHash}\n    size: ${Buffer.byteLength(contents['Polo-AI-x64.zip'])}\npath: Polo-AI-x64.zip\nsha512: ${macZipHash}\n`,
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
      expect((await readdir(output)).sort()).toHaveLength(9)

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
      } finally {
        server.stop(true)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
