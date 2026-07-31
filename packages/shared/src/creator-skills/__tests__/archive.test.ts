import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { strToU8, zipSync } from 'fflate'
import {
  CreatorSkillArchiveError,
  preflightCreatorSkillArchive,
  scanCreatorSkillDirectory,
  validateCreatorSkillArchive,
} from '../archive'
import { DEFAULT_SKILL_ARCHIVE_POLICY } from '../types'

const VALID_SKILL = `---
name: Review Helper
description: Reviews changes against a checklist.
icon: "🧭"
requiredSources:
  - github
alwaysAllow:
  - read
---

Review the selected change carefully.
`

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1
      ? 0xedb88320 ^ (crc >>> 1)
      : crc >>> 1
  }
  return crc >>> 0
})

function crc32(parts: Buffer[]): number {
  let crc = 0xffffffff
  for (const part of parts) {
    for (const byte of part) {
      crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(typeName: string, data: Buffer): Buffer {
  const type = Buffer.from(typeName, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  type.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32([type, data]), 8 + data.length)
  return chunk
}

function validPng(width = 1, height = 1, includeEnd = true): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  const scanlines = Buffer.alloc(height * (1 + width * 4))
  for (let row = 0; row < height; row += 1) {
    scanlines[row * (1 + width * 4)] = 0
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    ...(includeEnd ? [pngChunk('IEND', Buffer.alloc(0))] : []),
  ])
}

async function writeZip(
  root: string,
  entries: Record<string, Uint8Array | string>,
  name = 'skill.zip',
): Promise<string> {
  const path = join(root, name)
  const bytes = zipSync(Object.fromEntries(
    Object.entries(entries).map(([entryPath, value]) => [
      entryPath,
      typeof value === 'string' ? strToU8(value) : value,
    ]),
  ))
  await writeFile(path, bytes)
  return path
}

async function withTemp(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'creator-skill-archive-test-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('Creator Skill archive validation', () => {
  it('validates, normalizes, hashes, and safely extracts a package', async () => {
    await withTemp(async root => {
      const archivePath = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
        'review-helper/references/checklist.txt': 'Check authorization.\n',
        '__MACOSX/._SKILL.md': 'packaging noise',
        'review-helper/.DS_Store': 'packaging noise',
      })
      const destinationRoot = join(root, 'stage')
      const validated = await validateCreatorSkillArchive({
        archivePath,
        slug: 'review-helper',
        destinationRoot,
      })

      expect(validated.metadata).toEqual({
        name: 'Review Helper',
        description: 'Reviews changes against a checklist.',
        icon: '🧭',
        requiredSources: ['github'],
        alwaysAllow: ['read'],
      })
      expect(validated.manifest.map(entry => entry.path)).toEqual([
        'SKILL.md',
        'references/checklist.txt',
      ])
      expect(validated.warnings).toHaveLength(2)
      expect(validated.warnings.every(issue => issue.severity === 'warning')).toBe(true)

      const installed = join(destinationRoot, 'review-helper')
      const rescanned = await scanCreatorSkillDirectory(installed)
      expect(rescanned.contentDigest).toBe(validated.contentDigest)
      expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toBe(VALID_SKILL)
      expect((await stat(join(installed, 'SKILL.md'))).mode & 0o111).toBe(0)
    })
  })

  it('rejects invalid roots and Creator-only remote icons with stable issues', async () => {
    await withTemp(async root => {
      const multipleRoots = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
        'other/file.txt': 'outside',
      }, 'roots.zip')
      await expect(validateCreatorSkillArchive({
        archivePath: multipleRoots,
        slug: 'review-helper',
      })).rejects.toMatchObject({
        code: 'invalid_skill_archive',
        issues: [{ code: 'root_directory_mismatch', severity: 'error' }],
      })

      const remoteIcon = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL.replace(
          'icon: "🧭"',
          'icon: "https://example.test/icon.png"',
        ),
      }, 'remote-icon.zip')
      await expect(validateCreatorSkillArchive({
        archivePath: remoteIcon,
        slug: 'review-helper',
      })).rejects.toMatchObject({
        code: 'skill_validation_failed',
        issues: [{ code: 'invalid_creator_icon', field: 'icon' }],
      })

      const decoratedText = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL.replace(
          'icon: "🧭"',
          'icon: "Review 🧭"',
        ),
      }, 'text-icon.zip')
      await expect(validateCreatorSkillArchive({
        archivePath: decoratedText,
        slug: 'review-helper',
      })).rejects.toMatchObject({
        code: 'skill_validation_failed',
        issues: [{ code: 'invalid_creator_icon', field: 'icon' }],
      })
    })
  })

  it('keeps client preflight structural and leaves content validation to the server', async () => {
    await withTemp(async root => {
      const archivePath = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL.replace(
          'icon: "🧭"',
          'icon: "https://example.test/icon.png"',
        ),
        'review-helper/.DS_Store': 'noise',
      })
      const result = await preflightCreatorSkillArchive({
        archivePath,
        slug: 'review-helper',
      })
      expect(result.archiveChecksum).toMatch(/^[a-f0-9]{64}$/)
      expect(result.warnings).toMatchObject([
        { code: 'packaging_noise_removed', severity: 'warning' },
      ])
    })
  })

  it('rejects executable payloads and identity mismatches', async () => {
    await withTemp(async root => {
      const executable = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
        'review-helper/references/tool': new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0]),
      })
      await expect(validateCreatorSkillArchive({
        archivePath: executable,
        slug: 'review-helper',
      })).rejects.toMatchObject({
        code: 'invalid_skill_archive',
        issues: [{ code: 'executable_binary' }],
      })

      const validArchive = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
      }, 'checksum.zip')
      await expect(validateCreatorSkillArchive({
        archivePath: validArchive,
        slug: 'review-helper',
        expectedArchiveChecksum: '0'.repeat(64),
      })).rejects.toBeInstanceOf(CreatorSkillArchiveError)
      await expect(validateCreatorSkillArchive({
        archivePath: validArchive,
        slug: 'review-helper',
        expectedArchiveChecksum: '0'.repeat(64),
      })).rejects.toMatchObject({ code: 'checksum_mismatch' })
    })
  })

  it('fully validates icon PNG structure, CRC, termination, and dimensions', async () => {
    await withTemp(async root => {
      const validIconArchive = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
        'review-helper/icon.png': validPng(),
      }, 'valid-icon.zip')
      expect((await validateCreatorSkillArchive({
        archivePath: validIconArchive,
        slug: 'review-helper',
      })).manifest.map(item => item.path)).toContain('icon.png')

      const badCrc = Buffer.from(validPng())
      badCrc[29] = badCrc[29]! ^ 0xff
      const truncatedChunk = Buffer.concat([
        PNG_SIGNATURE,
        Buffer.from([0, 0, 0, 13]),
        Buffer.from('IHDR'),
        Buffer.alloc(4),
      ])
      const invalidIcons: Array<[string, Buffer]> = [
        ['signature-only', Buffer.concat([PNG_SIGNATURE, Buffer.from('garbage')])],
        ['truncated-chunk', truncatedChunk],
        ['missing-iend', validPng(1, 1, false)],
        ['bad-crc', badCrc],
        ['oversized-dimensions', validPng(4_097, 1)],
      ]

      for (const [name, icon] of invalidIcons) {
        const archivePath = await writeZip(root, {
          'review-helper/SKILL.md': VALID_SKILL,
          'review-helper/icon.png': icon,
        }, `${name}.zip`)
        await expect(validateCreatorSkillArchive({
          archivePath,
          slug: 'review-helper',
        })).rejects.toMatchObject({
          code: 'invalid_skill_archive',
          issues: [{
            code: 'invalid_icon_format',
            path: 'review-helper/icon.png',
          }],
        })
      }
    })
  })

  it('rejects file and directory type conflicts before extraction', async () => {
    await withTemp(async root => {
      const archivePath = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
        'review-helper/references': 'not a directory',
        'review-helper/references/nested.txt': 'cannot exist below a file',
      })
      await expect(validateCreatorSkillArchive({
        archivePath,
        slug: 'review-helper',
        destinationRoot: join(root, 'stage'),
      })).rejects.toMatchObject({
        code: 'invalid_skill_archive',
        issues: [{ code: 'path_type_conflict', path: 'review-helper/references/nested.txt' }],
      })

      const referencesFile = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
        'review-helper/references': 'must be a directory',
      }, 'references-file.zip')
      await expect(preflightCreatorSkillArchive({
        archivePath: referencesFile,
        slug: 'review-helper',
      })).rejects.toMatchObject({
        code: 'invalid_skill_archive',
        issues: [{ code: 'skill_structure_type_mismatch' }],
      })
    })
  })

  it('rejects every additional or non-canonical SKILL.md basename', async () => {
    await withTemp(async root => {
      for (const [name, entries] of [
        ['nested', {
          'review-helper/SKILL.md': VALID_SKILL,
          'review-helper/references/SKILL.md': 'not another entrypoint',
        }],
        ['case-variant', {
          'review-helper/skill.MD': VALID_SKILL,
        }],
      ] as const) {
        const archivePath = await writeZip(root, entries, `${name}.zip`)
        await expect(validateCreatorSkillArchive({
          archivePath,
          slug: 'review-helper',
        })).rejects.toMatchObject({
          code: 'invalid_skill_archive',
          issues: [{ code: 'skill_file_count' }],
        })
      }
    })
  })

  it('rejects path traversal during preflight without writing outside staging', async () => {
    await withTemp(async root => {
      const archivePath = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
        'review-helper/references/../../escaped.txt': 'escaped',
      })
      await expect(preflightCreatorSkillArchive({
        archivePath,
        slug: 'review-helper',
      })).rejects.toMatchObject({
        code: 'invalid_skill_archive',
        issues: [{ code: 'path_traversal' }],
      })
      expect(await readFile(join(root, 'escaped.txt'), 'utf8').catch(() => null)).toBeNull()
    })
  })

  it('rejects an oversized central directory made only of empty directories', async () => {
    await withTemp(async root => {
      const directories = Object.fromEntries(
        Array.from({ length: 1_001 }, (_, index) => [
          `review-helper/references/empty-${index}/`,
          new Uint8Array(),
        ]),
      )
      const archivePath = await writeZip(root, directories, 'empty-directories.zip')

      await expect(preflightCreatorSkillArchive({
        archivePath,
        slug: 'review-helper',
      })).rejects.toMatchObject({
        code: 'archive_policy_exceeded',
        issues: [{ code: 'max_entry_count_exceeded' }],
      })
    })
  })

  it('excludes packaging noise from configured file-count and expanded-size limits', async () => {
    await withTemp(async root => {
      const skillBytes = Buffer.byteLength(VALID_SKILL)
      const noiseEntries = Object.fromEntries(
        Array.from({ length: 200 }, (_, index) => [
          `__MACOSX/noise-${index}/.DS_Store`,
          new Uint8Array(),
        ]),
      )
      const manyNoiseArchive = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
        ...noiseEntries,
      }, 'many-noise-files.zip')
      const manyNoise = await validateCreatorSkillArchive({
        archivePath: manyNoiseArchive,
        slug: 'review-helper',
        policy: {
          ...DEFAULT_SKILL_ARCHIVE_POLICY,
          maxFileCount: 1,
        },
      })
      expect(manyNoise.manifest.map(item => item.path)).toEqual(['SKILL.md'])
      expect(manyNoise.warnings).toHaveLength(200)

      const largeNoiseArchive = await writeZip(root, {
        'review-helper/SKILL.md': VALID_SKILL,
        '__MACOSX/large/.DS_Store': Buffer.alloc(skillBytes * 10),
      }, 'large-noise-file.zip')
      const largeNoise = await validateCreatorSkillArchive({
        archivePath: largeNoiseArchive,
        slug: 'review-helper',
        policy: {
          ...DEFAULT_SKILL_ARCHIVE_POLICY,
          maxFileCount: 1,
          maxFileBytes: skillBytes,
          maxExpandedBytes: skillBytes,
        },
      })
      expect(largeNoise.manifest.map(item => item.path)).toEqual(['SKILL.md'])
      expect(largeNoise.warnings).toMatchObject([{
        code: 'packaging_noise_removed',
        severity: 'warning',
      }])
    })
  })
})
