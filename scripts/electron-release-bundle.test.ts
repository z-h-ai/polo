import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { prepareReleaseBundle, verifyPublishedRelease } from './electron-release-bundle'

describe('release bundle assembly and public verification', () => {
  it('builds the macOS/Linux bundle and verifies it over HEAD/GET', async () => {
    const root = await mkdtemp(join(tmpdir(), 'polo-release-bundle-'))
    const input = join(root, 'input')
    const output = join(root, 'output')
    await mkdir(input)
    const artifacts = [
      ['Polo-AI-x64.zip', 'macOS bytes', 'latest-mac.yml'],
      ['Polo-AI-x64.AppImage', 'Linux bytes', 'latest-linux.yml'],
    ] as const
    try {
      for (const [name, contents, manifest] of artifacts) {
        await writeFile(join(input, name), contents)
        const hash = createHash('sha512').update(contents).digest('base64')
        await writeFile(
          join(input, manifest),
          `version: 0.15.2\nfiles:\n  - url: ${name}\n    sha512: ${hash}\n    size: ${Buffer.byteLength(contents)}\npath: ${name}\nsha512: ${hash}\n`,
        )
      }
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
      expect((await readdir(output)).sort()).toHaveLength(6)

      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            return new Response('Method not allowed', { status: 405 })
          }
          const name = basename(new URL(request.url).pathname)
          const file = Bun.file(join(output, name))
          if (!(await file.exists())) return new Response('Not found', { status: 404 })
          const noCache = name.endsWith('.yml') || name === 'release-contract.json'
          const headers = {
            'content-length': String(file.size),
            'cache-control': noCache ? 'no-cache' : 'public, max-age=31536000, immutable',
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
