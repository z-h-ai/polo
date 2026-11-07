import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  downloadProjectContextFile,
  setProjectContextDownloadRootForTests,
} from '../admin-client'

/**
 * POO-196 download destination discipline (consensus S-04+X9).
 *
 * The renderer's targetPath may only name a file — never choose a directory,
 * escape the downloads root, or overwrite an existing entry. The download
 * root itself is pinned through the test seam so containment/symlink
 * behavior is observable without touching the user's real Downloads folder.
 */

let downloadRoot = ''

const REAL_FETCH = globalThis.fetch

function respondWith(body: string | ReadableStream<Uint8Array>, status = 200): void {
  globalThis.fetch = (async () => new Response(body, { status })) as unknown as typeof fetch
}

async function entryNames(): Promise<string[]> {
  return (await readdir(downloadRoot)).sort()
}

beforeEach(async () => {
  // Pin the REAL root: the download path resolves the root through realpath
  // (macOS /var → /private/var), so the assertions must judge against the
  // same resolved prefix.
  downloadRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'pc-download-')))
  setProjectContextDownloadRootForTests(downloadRoot)
})

afterEach(async () => {
  setProjectContextDownloadRootForTests(null)
  globalThis.fetch = REAL_FETCH
  await rm(downloadRoot, { recursive: true, force: true })
})

describe('downloadProjectContextFile', () => {
  it('lands the payload under its basename inside the pinned root, whatever directory the caller asked for', async () => {
    const payload = '周会纪要：POO-196 评审通过\n'
    respondWith(payload)

    for (const requested of [
      'notes.md',
      '../escape.md',
      '/etc/passwd',
      'nested/dir/deep.md',
      '../../secret.md',
    ]) {
      const savedPath = await downloadProjectContextFile({ url: 'https://cos.example/file', targetPath: requested })
      expect(savedPath.startsWith(downloadRoot + path.sep)).toBe(true)
      expect(await readFile(savedPath, 'utf8')).toBe(payload)
    }

    // Five downloads, five distinct entries, all inside the root.
    expect(await entryNames()).toEqual([
      'deep.md',
      'escape.md',
      'notes.md',
      'passwd',
      'secret.md',
    ])
  })

  it('renames to the next (2).ext ordinal instead of overwriting an existing file', async () => {
    respondWith('new bytes')
    const keep = path.join(downloadRoot, 'report.md')
    await writeFile(keep, 'original bytes')

    const savedPath = await downloadProjectContextFile({ url: 'https://cos.example/file', targetPath: keep })
    expect(savedPath).toBe(path.join(downloadRoot, 'report (2).md'))
    expect(await readFile(keep, 'utf8')).toBe('original bytes')
    expect(await readFile(savedPath, 'utf8')).toBe('new bytes')
    expect(await entryNames()).toEqual(['report (2).md', 'report.md'])
  })

  it('never writes through a planted symlink entry', async () => {
    respondWith('downloaded')
    const victim = path.join(downloadRoot, 'outside.txt')
    await writeFile(victim, 'do not touch')
    await symlink(victim, path.join(downloadRoot, 'report.md'))

    const savedPath = await downloadProjectContextFile({ url: 'https://cos.example/file', targetPath: 'report.md' })
    expect(savedPath).toBe(path.join(downloadRoot, 'report (2).md'))
    expect(await readFile(victim, 'utf8')).toBe('do not touch')
    expect(await readFile(savedPath, 'utf8')).toBe('downloaded')
    // The planted link survived untouched, pointing at the victim.
    expect(await entryNames()).toEqual(['outside.txt', 'report (2).md', 'report.md'])
  })

  it('leaves no half-written file behind when the grant URL fails', async () => {
    respondWith('forbidden', 403)

    await expect(
      downloadProjectContextFile({ url: 'https://cos.example/file', targetPath: 'report.md' }),
    ).rejects.toThrow(/Download failed \(403\)/)

    expect(await entryNames()).toEqual([])
  })

  it('leaves no half-written file behind when the stream breaks mid-transfer', async () => {
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
        controller.error(new Error('connection reset'))
      },
    })
    respondWith(broken)

    await expect(
      downloadProjectContextFile({ url: 'https://cos.example/file', targetPath: 'report.md' }),
    ).rejects.toThrow()

    expect(await entryNames()).toEqual([])
  })
})
