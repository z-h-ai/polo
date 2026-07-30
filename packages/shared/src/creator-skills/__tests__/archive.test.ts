import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import {
  CreatorSkillArchiveError,
  preflightCreatorSkillArchive,
  scanCreatorSkillDirectory,
  validateCreatorSkillArchive,
} from '../archive'

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
})
