import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { load } from 'js-yaml'
import { finalizeMacUpdateManifest } from './finalize-electron-update-manifest'

function digest(contents: string): string {
  return createHash('sha512').update(contents).digest('base64')
}

const X64_MANIFEST = `version: 0.15.9
files:
  - url: Polo-AI-x64.zip
    sha512: stale-zip
    size: 1
  - url: Polo-AI-x64.dmg
    sha512: stale-pre-staple-dmg
    size: 2
path: Polo-AI-x64.zip
sha512: stale-zip
releaseDate: '2026-08-09T19:16:40.964Z'
`

const ARM64_MANIFEST = `version: 0.15.9
files:
  - url: Polo-AI-arm64.zip
    sha512: stale-arm64-zip
    size: 1
  - url: Polo-AI-arm64.dmg
    sha512: stale-pre-staple-arm64-dmg
    size: 2
path: Polo-AI-arm64.zip
sha512: stale-arm64-zip
releaseDate: '2026-08-09T19:16:41.964Z'
`

async function fixture(arch: 'x64' | 'arm64'): Promise<{ root: string, release: string }> {
  const root = await mkdtemp(join(tmpdir(), 'polo-finalize-manifest-'))
  const release = join(root, 'release')
  await mkdir(release)
  const prefix = `Polo-AI-${arch}`
  await writeFile(join(release, `${prefix}.zip`), `final ${arch} ZIP bytes`)
  await writeFile(join(release, `${prefix}.dmg`), `final ${arch} DMG bytes plus stapled ticket`)
  await writeFile(join(release, 'latest-mac.yml'), arch === 'x64' ? X64_MANIFEST : ARM64_MANIFEST)
  return { root, release }
}

describe('final Electron updater manifest', () => {
  it('binds the x64 latest-mac.yml to final ZIP and stapled DMG bytes', async () => {
    const { root, release } = await fixture('x64')
    try {
      await finalizeMacUpdateManifest(release, 'x64')

      const manifest = load(await readFile(join(release, 'latest-mac.yml'), 'utf8')) as {
        files: Array<{ url: string, sha512: string, size: number }>
        path: string
        sha512: string
        releaseDate: string
      }
      const zip = manifest.files.find(entry => entry.url === 'Polo-AI-x64.zip')!
      const dmg = manifest.files.find(entry => entry.url === 'Polo-AI-x64.dmg')!
      expect(zip).toEqual({
        url: 'Polo-AI-x64.zip',
        sha512: digest('final x64 ZIP bytes'),
        size: Buffer.byteLength('final x64 ZIP bytes'),
      })
      expect(dmg).toEqual({
        url: 'Polo-AI-x64.dmg',
        sha512: digest('final x64 DMG bytes plus stapled ticket'),
        size: Buffer.byteLength('final x64 DMG bytes plus stapled ticket'),
      })
      expect(manifest.path).toBe('Polo-AI-x64.zip')
      expect(manifest.sha512).toBe(zip.sha512)
      expect(manifest.releaseDate).toBe('2026-08-09T19:16:40.964Z')
      expect((await readdir(release)).sort()).toEqual([
        'Polo-AI-x64.dmg',
        'Polo-AI-x64.zip',
        'latest-mac.yml',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('binds the arm64 latest-mac.yml to its own final ZIP and stapled DMG bytes', async () => {
    const { root, release } = await fixture('arm64')
    try {
      await finalizeMacUpdateManifest(release, 'arm64')

      const manifest = load(await readFile(join(release, 'latest-mac.yml'), 'utf8')) as {
        files: Array<{ url: string, sha512: string, size: number }>
        path: string
        sha512: string
        releaseDate: string
      }
      const zip = manifest.files.find(entry => entry.url === 'Polo-AI-arm64.zip')!
      const dmg = manifest.files.find(entry => entry.url === 'Polo-AI-arm64.dmg')!
      expect(zip).toEqual({
        url: 'Polo-AI-arm64.zip',
        sha512: digest('final arm64 ZIP bytes'),
        size: Buffer.byteLength('final arm64 ZIP bytes'),
      })
      expect(dmg).toEqual({
        url: 'Polo-AI-arm64.dmg',
        sha512: digest('final arm64 DMG bytes plus stapled ticket'),
        size: Buffer.byteLength('final arm64 DMG bytes plus stapled ticket'),
      })
      expect(manifest.path).toBe('Polo-AI-arm64.zip')
      expect(manifest.sha512).toBe(zip.sha512)
      expect(manifest.releaseDate).toBe('2026-08-09T19:16:41.964Z')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed without rewriting an unexpected updater inventory', async () => {
    const { root, release } = await fixture('x64')
    try {
      const manifestPath = join(release, 'latest-mac.yml')
      const unsafe = (await readFile(manifestPath, 'utf8')).replace(
        '  - url: Polo-AI-x64.dmg',
        '  - url: Polo-AI-arm64.dmg',
      )
      await writeFile(manifestPath, unsafe)

      await expect(finalizeMacUpdateManifest(release, 'x64'))
        .rejects.toThrow('must reference exactly')
      expect(await readFile(manifestPath, 'utf8')).toBe(unsafe)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an x64 manifest finalized under the arm64 contract', async () => {
    const { root, release } = await fixture('x64')
    try {
      await expect(finalizeMacUpdateManifest(release, 'arm64'))
        .rejects.toThrow('does not use the macOS arm64 ZIP update contract')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
