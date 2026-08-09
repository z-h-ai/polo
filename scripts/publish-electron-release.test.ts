import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { createReleaseContract } from './electron-release-contract'
import {
  confirmRelease,
  assertConfirmedRelease,
  assertNotLatest,
  projectedDiskUsage,
  publish,
  rollback,
  rollbackFailedRelease,
  validateSource,
  type ReleaseArguments,
} from './publish-electron-release'

const repository = 'polo/polo'
const commitSha = 'a'.repeat(40)
const manifestNames = ['latest-mac.yml', 'latest-linux.yml'] as const
const testPublisherOptions = { capacityCheck: async () => {} }

interface Fixture {
  root: string
  source: string
  volume: string
  args: ReleaseArguments
}

async function createFixture(version = '1.0.0'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'polo-release-'))
  const source = join(root, 'source')
  const volume = join(root, 'volume')
  await Promise.all([mkdir(source), mkdir(volume)])
  const files = {
    macosZip: join(source, 'Polo-AI-x64.zip'),
    macosX64Dmg: join(source, 'Polo-AI-x64.dmg'),
    macosArm64Dmg: join(source, 'Polo-AI-arm64.dmg'),
    linuxAppImage: join(source, 'Polo-AI-x64.AppImage'),
    windowsExe: join(source, 'Polo-AI-x64.exe'),
    installApp: join(source, 'install-app.sh'),
  }
  await Promise.all([
    writeFile(files.macosZip, 'macOS release'),
    writeFile(files.macosX64Dmg, 'macOS x64 DMG'),
    writeFile(files.macosArm64Dmg, 'macOS arm64 DMG'),
    writeFile(files.linuxAppImage, 'Linux release'),
    writeFile(files.windowsExe, 'Windows release'),
    writeFile(files.installApp, '#!/bin/sh\n'),
  ])
  const artifacts = [files.macosZip, files.linuxAppImage]
  for (let index = 0; index < manifestNames.length; index += 1) {
    const artifact = artifacts[index]!
    const contents = await readFile(artifact)
    const hash = createHash('sha512').update(contents).digest('base64')
    const name = artifact.split('/').pop()!
    await writeFile(
      join(source, manifestNames[index]!),
      `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${hash}\n    size: ${contents.byteLength}\npath: ${name}\nsha512: ${hash}\n`,
    )
  }
  const contract = await createReleaseContract({
    repository,
    tag: `v${version}`,
    version,
    commitSha,
    publishedAt: '2026-08-07T12:00:00.000Z',
    ...files,
  })
  await writeFile(join(source, 'release-contract.json'), `${JSON.stringify(contract, null, 2)}\n`)
  return {
    root,
    source,
    volume,
    args: { source, releasesDir: volume, version, repository, tag: `v${version}`, commitSha },
  }
}

async function destroy(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true })
}

describe('release publisher validation', () => {
  it('accepts the complete curated release directory', async () => {
    const fixture = await createFixture()
    try {
      expect((await validateSource(fixture.source, fixture.args)).files).toHaveLength(9)
    } finally { await destroy(fixture) }
  })

  it('accepts the Electron Builder macOS ZIP and DMG manifest', async () => {
    const fixture = await createFixture()
    try {
      const manifestPath = join(fixture.source, 'latest-mac.yml')
      const manifest = await readFile(manifestPath, 'utf8')
      const dmgContents = await readFile(join(fixture.source, 'Polo-AI-x64.dmg'))
      const dmgHash = createHash('sha512').update(dmgContents).digest('base64')
      await writeFile(
        manifestPath,
        manifest.replace(
          'files:\n',
          `files:\n  - url: Polo-AI-x64.dmg\n    sha512: ${dmgHash}\n    size: ${dmgContents.byteLength}\n`,
        ),
      )

      const validated = await validateSource(fixture.source, fixture.args)

      expect(validated.manifests['latest-mac.yml'].files).toHaveLength(2)
      expect(validated.manifests['latest-mac.yml'].files[1]?.url).toBe('Polo-AI-x64.zip')
    } finally { await destroy(fixture) }
  })

  it('rejects unsupported updater artifacts', async () => {
    const fixture = await createFixture()
    try {
      const manifestPath = join(fixture.source, 'latest-mac.yml')
      const manifest = await readFile(manifestPath, 'utf8')
      await writeFile(
        manifestPath,
        manifest.replace(
          'files:\n',
          `files:\n  - url: unexpected.pkg\n    sha512: ${'a'.repeat(88)}\n    size: 123\n`,
        ),
      )

      await expect(validateSource(fixture.source, fixture.args))
        .rejects.toThrow('references an unsupported artifact')
    } finally { await destroy(fixture) }
  })

  it('rejects incorrect manifest version, size, and hashes', async () => {
    const fixture = await createFixture()
    try {
      const manifest = join(fixture.source, 'latest-mac.yml')
      const original = await readFile(manifest, 'utf8')
      await writeFile(manifest, original.replace('version: 1.0.0', 'version: 2.0.0'))
      await expect(validateSource(fixture.source, fixture.args)).rejects.toThrow('has version')
      await writeFile(manifest, original.replace(/size: \d+/, 'size: 999'))
      await expect(validateSource(fixture.source, fixture.args)).rejects.toThrow('incorrect size')
      await writeFile(manifest, original.replace(/sha512: .+/g, 'sha512: invalid'))
      await expect(validateSource(fixture.source, fixture.args)).rejects.toThrow('incorrect SHA-512')
    } finally { await destroy(fixture) }
  })

  it('rejects missing, extra, and unsafe entries', async () => {
    const fixture = await createFixture()
    try {
      await rm(join(fixture.source, 'latest-linux.yml'))
      await expect(validateSource(fixture.source, fixture.args)).rejects.toThrow()
      await writeFile(join(fixture.source, 'latest-linux.yml'), 'invalid')
      await writeFile(join(fixture.source, 'extra.exe'), 'unexpected')
      await expect(validateSource(fixture.source, fixture.args)).rejects.toThrow('unexpected=[extra.exe]')
      await rm(join(fixture.source, 'extra.exe'))
      await symlink('../outside', join(fixture.source, 'Polo-AI-x64.AppImage.link'))
      await expect(validateSource(fixture.source, fixture.args)).rejects.toThrow('unexpected=')
    } finally { await destroy(fixture) }
  })

  it('rejects a contract SHA-256 mismatch', async () => {
    const fixture = await createFixture()
    try {
      await writeFile(join(fixture.source, 'Polo-AI-x64.zip'), 'changed')
      await expect(validateSource(fixture.source, fixture.args)).rejects.toThrow('incorrect SHA-256')
    } finally { await destroy(fixture) }
  })
})

describe('release publisher filesystem behavior', () => {
  it('publishes atomically and treats an identical retry as idempotent', async () => {
    const fixture = await createFixture()
    try {
      let capacityChecks = 0
      const options = { capacityCheck: async () => { capacityChecks += 1 } }
      expect(await publish(fixture.args, options)).toBe('published')
      expect(await readlink(join(fixture.volume, 'electron', 'latest'))).toBe('releases/1.0.0')
      expect(await publish(fixture.args, options)).toBe('idempotent')
      expect(capacityChecks).toBe(1)
      await confirmRelease(fixture.volume, '1.0.0')
    } finally { await destroy(fixture) }
  })

  it('rejects a same-version overwrite with different contents', async () => {
    const fixture = await createFixture()
    try {
      await publish(fixture.args, testPublisherOptions)
      await writeFile(join(fixture.volume, 'electron', 'releases', '1.0.0', 'install-app.sh'), 'changed')
      await expect(publish(fixture.args, testPublisherOptions)).rejects.toThrow('different contents')
    } finally { await destroy(fixture) }
  })

  it('rejects downgrade and an existing PVC lock', async () => {
    const newer = await createFixture('2.0.0')
    try {
      await publish(newer.args, testPublisherOptions)
      const older = await createFixture('1.0.0')
      try {
        older.args.releasesDir = newer.volume
        await expect(publish(older.args, testPublisherOptions)).rejects.toThrow('version downgrade')
      } finally { await destroy(older) }
      await mkdir(join(newer.volume, 'electron', '.publisher.lock'))
      await expect(publish(newer.args, testPublisherOptions)).rejects.toThrow('PVC lock')
    } finally { await destroy(newer) }
  })

  it('keeps three newest releases and can roll back without deletion', async () => {
    const first = await createFixture('1.0.0')
    try {
      for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) {
        const fixture = version === '1.0.0' ? first : await createFixture(version)
        fixture.args.releasesDir = first.volume
        await publish(fixture.args, testPublisherOptions)
        await confirmRelease(first.volume, version)
        if (fixture !== first) await destroy(fixture)
      }
      expect((await readdir(join(first.volume, 'electron', 'releases'))).sort()).toEqual([
        '1.1.0', '1.2.0', '1.3.0',
      ])
      await rollback(first.volume, '1.1.0')
      expect(await readlink(join(first.volume, 'electron', 'latest'))).toBe('releases/1.1.0')
      expect((await readdir(join(first.volume, 'electron', 'releases'))).sort()).toEqual([
        '1.1.0', '1.2.0', '1.3.0',
      ])
    } finally { await destroy(first) }
  })

  it('restores the exact pre-publish target after failed verification', async () => {
    const first = await createFixture('1.0.0')
    const second = await createFixture('1.1.0')
    try {
      second.args.releasesDir = first.volume
      await publish(first.args, testPublisherOptions)
      await confirmRelease(first.volume, '1.0.0')
      await publish(second.args, testPublisherOptions)
      await rollbackFailedRelease(first.volume, '1.1.0')
      expect(await readlink(join(first.volume, 'electron', 'latest'))).toBe('releases/1.0.0')
      await assertNotLatest(first.volume, '1.1.0')
    } finally {
      await destroy(second)
      await destroy(first)
    }
  })

  it('keeps a manually selected oldest release until an unconfirmed next release can roll back to it', async () => {
    const first = await createFixture('1.0.0')
    try {
      for (const version of ['1.0.0', '1.1.0', '1.2.0']) {
        const fixture = version === '1.0.0' ? first : await createFixture(version)
        fixture.args.releasesDir = first.volume
        await publish(fixture.args, testPublisherOptions)
        await confirmRelease(first.volume, version)
        if (fixture !== first) await destroy(fixture)
      }
      await rollback(first.volume, '1.0.0')
      const next = await createFixture('1.3.0')
      try {
        next.args.releasesDir = first.volume
        await publish(next.args, testPublisherOptions)
        await rollbackFailedRelease(first.volume, '1.3.0')
        expect(await readlink(join(first.volume, 'electron', 'latest'))).toBe('releases/1.0.0')
        expect(await readdir(join(first.volume, 'electron', 'releases'))).toContain('1.0.0')
      } finally { await destroy(next) }
    } finally { await destroy(first) }
  })

  it('keeps a durable confirmation marker for retriable finalization compensation', async () => {
    const first = await createFixture('1.0.0')
    try {
      await publish(first.args, testPublisherOptions)
      await confirmRelease(first.volume, '1.0.0')
      await confirmRelease(first.volume, '1.0.0')
      await assertConfirmedRelease(first.volume, '1.0.0')
      await rollbackFailedRelease(first.volume, '1.0.0')
      await expect(readlink(join(first.volume, 'electron', 'latest'))).rejects.toThrow()
    } finally { await destroy(first) }
  })

  it('removes latest on a failed bootstrap but retains its release directory', async () => {
    const fixture = await createFixture()
    try {
      await publish(fixture.args, testPublisherOptions)
      await rollbackFailedRelease(fixture.volume, '1.0.0')
      await expect(readlink(join(fixture.volume, 'electron', 'latest'))).rejects.toThrow()
      expect(await readdir(join(fixture.volume, 'electron', 'releases'))).toContain('1.0.0')
    } finally { await destroy(fixture) }
  })

  it('calculates capacity from current usage plus incoming payload', () => {
    expect(projectedDiskUsage(100, 40, 10, 99)).toBeCloseTo(0.699)
    expect(projectedDiskUsage(100, 40, 10, 101)).toBeCloseTo(0.701)
  })

  it('rejects unsafe rollback version paths in the publisher itself', async () => {
    const fixture = await createFixture()
    try {
      await expect(rollback(fixture.volume, '../latest')).rejects.toThrow('strict SemVer')
      await expect(rollbackFailedRelease(fixture.volume, '../latest')).rejects.toThrow('strict SemVer')
    } finally { await destroy(fixture) }
  })
})
