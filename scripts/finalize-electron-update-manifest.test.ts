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

async function fixture(): Promise<{ root: string, release: string }> {
  const root = await mkdtemp(join(tmpdir(), 'polo-finalize-manifest-'))
  const release = join(root, 'release')
  await mkdir(release)
  await writeFile(join(release, 'Polo-AI-x64.zip'), 'final ZIP bytes')
  await writeFile(join(release, 'Polo-AI-x64.dmg'), 'final DMG bytes plus stapled ticket')
  await writeFile(
    join(release, 'latest-mac.yml'),
    `version: 0.15.9
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
`,
  )
  return { root, release }
}

describe('final Electron updater manifest', () => {
  it('binds latest-mac.yml to final ZIP and stapled DMG bytes', async () => {
    const { root, release } = await fixture()
    try {
      await finalizeMacUpdateManifest(release)

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
        sha512: digest('final ZIP bytes'),
        size: Buffer.byteLength('final ZIP bytes'),
      })
      expect(dmg).toEqual({
        url: 'Polo-AI-x64.dmg',
        sha512: digest('final DMG bytes plus stapled ticket'),
        size: Buffer.byteLength('final DMG bytes plus stapled ticket'),
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

  it('fails closed without rewriting an unexpected updater inventory', async () => {
    const { root, release } = await fixture()
    try {
      const manifestPath = join(release, 'latest-mac.yml')
      const unsafe = (await readFile(manifestPath, 'utf8')).replace(
        '  - url: Polo-AI-x64.dmg',
        '  - url: Polo-AI-arm64.dmg',
      )
      await writeFile(manifestPath, unsafe)

      await expect(finalizeMacUpdateManifest(release))
        .rejects.toThrow('must reference exactly')
      expect(await readFile(manifestPath, 'utf8')).toBe(unsafe)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
