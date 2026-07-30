import { describe, expect, it } from 'bun:test'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { validateCreatorSkillArchive } from '../archive'
import {
  deleteCreatorSkillBackups,
  installCreatorSkill,
  listCreatorSkillBackups,
  recoverCreatorSkillOperations,
  uninstallCreatorSkill,
  updateCreatorSkillInstallationMetadata,
} from '../installer'
import { readCreatorSkillsLedger } from '../ledger'
import {
  DEFAULT_SKILL_ARCHIVE_POLICY,
  type CreatorSkillDownloadGrant,
} from '../types'

const OP_INSTALL = '11111111-1111-4111-8111-111111111111'
const OP_FIRST = '22222222-2222-4222-8222-222222222222'
const OP_BLOCKED = '33333333-3333-4333-8333-333333333333'
const OP_BASE = '44444444-4444-4444-8444-444444444444'
const OP_UPDATE = '55555555-5555-4555-8555-555555555555'
const OP_UNINSTALL = '66666666-6666-4666-8666-666666666666'
const OP_RECOVERY = '77777777-7777-4777-8777-777777777777'
const OP_FAULT_LEDGER = '88888888-8888-4888-8888-888888888888'
const OP_FAULT_COMMITTED = '99999999-9999-4999-8999-999999999999'
const OP_FAULT_STAGE_PROMOTED = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OP_UNSUPPORTED_DIRECTORY_SYNC = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OP_FAULT_BACKUP_REMOVED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OP_FAULT_OPERATION_REMOVED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

function skillContent(version: string): string {
  return `---
name: Install Test
description: Exercises the Creator Skill installer.
---

Installed content for ${version}.
`
}

async function packageGrant(
  root: string,
  version: string,
): Promise<{ bytes: Uint8Array; grant: CreatorSkillDownloadGrant }> {
  const bytes = zipSync({
    'install-test/SKILL.md': strToU8(skillContent(version)),
    'install-test/references/version.txt': strToU8(version),
  })
  const archivePath = join(root, `${version}.zip`)
  await writeFile(archivePath, bytes)
  const validated = await validateCreatorSkillArchive({
    archivePath,
    slug: 'install-test',
  })
  return {
    bytes,
    grant: {
      artifactId: 'artifact-1',
      organizationId: 'organization-1',
      slug: 'install-test',
      version,
      url: `https://download.invalid/${version}.zip`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      archiveChecksum: validated.archiveChecksum,
      contentDigest: validated.contentDigest,
      manifest: validated.manifest,
      validationPolicy: DEFAULT_SKILL_ARCHIVE_POLICY,
    },
  }
}

function responseFetch(bytes: Uint8Array): typeof fetch {
  return (async () => new Response(bytes, {
    status: 200,
    headers: { 'content-length': String(bytes.byteLength) },
  })) as unknown as typeof fetch
}

async function withWorkspace(
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'creator-skill-installer-test-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('Creator Skill workspace installer', () => {
  it('commits an install only after validation and records the exact identity', async () => {
    await withWorkspace(async root => {
      const packaged = await packageGrant(root, '1.0.0')
      const stages: string[] = []
      let commitChecked = false
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_INSTALL,
        grant: packaged.grant,
      }, {
        fetch: responseFetch(packaged.bytes),
        assertCommitAllowed: async identity => {
          expect(identity).toEqual({
            artifactId: 'artifact-1',
            version: '1.0.0',
            archiveChecksum: packaged.grant.archiveChecksum,
          })
          commitChecked = true
        },
        onProgress: progress => stages.push(progress.stage),
      })

      expect(result.success).toBe(true)
      expect(commitChecked).toBe(true)
      expect(stages).toContain('commit')
      expect(stages.at(-1)).toBe('refresh')
      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('1.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]).toMatchObject({
        artifactId: 'artifact-1',
        slug: 'install-test',
        version: '1.0.0',
        archiveChecksum: packaged.grant.archiveChecksum,
        contentDigest: packaged.grant.contentDigest,
      })
      expect(await updateCreatorSkillInstallationMetadata({
        workspaceRoot: root,
        artifactId: 'artifact-1',
        version: '1.0.0',
        archiveChecksum: packaged.grant.archiveChecksum,
        changes: { ignoredVersion: '1.1.0' },
      })).toBe(true)
      expect(await updateCreatorSkillInstallationMetadata({
        workspaceRoot: root,
        artifactId: 'artifact-1',
        version: '1.0.0',
        archiveChecksum: packaged.grant.archiveChecksum,
        changes: {
          lastKnownStatus: 'active',
          lastCheckedAt: '2026-07-30T00:00:00.000Z',
        },
      })).toBe(true)
      expect((await readCreatorSkillsLedger(root)).installed[0]).toMatchObject({
        ignoredVersion: '1.1.0',
        lastKnownStatus: 'active',
        lastCheckedAt: '2026-07-30T00:00:00.000Z',
      })
    })
  })

  it('keeps the old Skill intact when the final safety check rejects', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_FIRST,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BLOCKED,
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        assertCommitAllowed: async () => {
          throw Object.assign(new Error('Version was revoked'), {
            code: 'artifact_version_revoked',
          })
        },
      })

      expect(result).toMatchObject({
        success: false,
        errorCode: 'artifact_version_revoked',
      })
      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('1.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
    })
  })

  it('returns structured existing and incoming identities for an unmanaged conflict', async () => {
    await withWorkspace(async root => {
      await mkdir(join(root, 'skills', 'install-test'), { recursive: true })
      await writeFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        skillContent('local'),
      )
      const packaged = await packageGrant(root, '1.0.0')

      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_INSTALL,
        grant: packaged.grant,
      }, { fetch: responseFetch(packaged.bytes) })

      expect(result).toMatchObject({
        success: false,
        conflicts: ['workspace_skill'],
        conflictDetails: {
          existing: [{
            source: 'workspace',
            slug: 'install-test',
          }],
          incoming: {
            source: 'creator_space',
            artifactId: 'artifact-1',
            organizationId: 'organization-1',
            slug: 'install-test',
            version: '1.0.0',
          },
        },
      })
    })
  })

  it('identifies a different Creator artifact and both versions in conflict details', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_FIRST,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_UPDATE,
        grant: {
          ...next.grant,
          artifactId: 'artifact-2',
          organizationId: 'organization-2',
        },
      }, { fetch: responseFetch(next.bytes) })

      expect(result).toMatchObject({
        success: false,
        conflicts: ['different_artifact'],
        conflictDetails: {
          existing: [{
            source: 'creator_space',
            artifactId: 'artifact-1',
            organizationId: 'organization-1',
            slug: 'install-test',
            version: '1.0.0',
          }],
          incoming: {
            source: 'creator_space',
            artifactId: 'artifact-2',
            organizationId: 'organization-2',
            slug: 'install-test',
            version: '2.0.0',
          },
        },
      })
    })
  })

  it('backs up local changes and detaches modified content on safe uninstall', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const skillPath = join(root, 'skills', 'install-test', 'SKILL.md')
      await writeFile(skillPath, `${skillContent('1.0.0')}\nLocal note.\n`)
      const next = await packageGrant(root, '2.0.0')
      const update = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_UPDATE,
        grant: next.grant,
        replaceExisting: true,
        backupLocalChanges: true,
      }, { fetch: responseFetch(next.bytes) })

      expect(update.success).toBe(true)
      const backups = await listCreatorSkillBackups(root)
      expect(backups).toHaveLength(1)
      expect(await readFile(join(
        root,
        'skill-backups',
        backups[0]!.slug,
        backups[0]!.backupId,
        'SKILL.md',
      ), 'utf8')).toContain('Local note.')

      await writeFile(skillPath, `${skillContent('2.0.0')}\nAnother local note.\n`)
      const uninstall = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: OP_UNINSTALL,
        slug: 'install-test',
      })
      expect(uninstall).toMatchObject({ success: true, detached: true })
      expect(await access(skillPath).then(() => true, () => false)).toBe(true)
      expect((await readCreatorSkillsLedger(root)).installed).toHaveLength(0)

      const forced = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        slug: 'install-test',
        forceDeleteModified: true,
      })
      expect(forced).toMatchObject({ success: true })
      expect(await access(skillPath).then(() => true, () => false)).toBe(false)
    })
  })

  it('rejects backup deletion through a symlink ancestor outside the workspace', async () => {
    await withWorkspace(async root => {
      const outside = await mkdtemp(join(tmpdir(), 'creator-skill-backup-outside-'))
      const backupId = '2026-07-30T00-00-00-000Z'
      try {
        await mkdir(join(root, 'skill-backups'), { recursive: true })
        await mkdir(join(outside, backupId), { recursive: true })
        await writeFile(join(outside, backupId, 'victim.txt'), 'keep')
        await writeFile(join(outside, 'sentinel.txt'), 'keep')
        await symlink(
          outside,
          join(root, 'skill-backups', 'link'),
          process.platform === 'win32' ? 'junction' : 'dir',
        )

        await expect(deleteCreatorSkillBackups(root, {
          slug: 'link',
          backupId,
        })).rejects.toMatchObject({ code: 'invalid_backup_path' })
        await expect(deleteCreatorSkillBackups(root))
          .rejects.toMatchObject({ code: 'invalid_backup_path' })

        expect(await readFile(join(outside, backupId, 'victim.txt'), 'utf8')).toBe('keep')
        expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep')
        expect(await access(root).then(() => true, () => false)).toBe(true)
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  it('rejects symlinked backup roots and targets without touching external content', async () => {
    await withWorkspace(async root => {
      const outside = await mkdtemp(join(tmpdir(), 'creator-skill-backup-root-outside-'))
      const backupId = '2026-07-30T00-00-00-000Z'
      try {
        await mkdir(join(outside, 'victim'), { recursive: true })
        await writeFile(join(outside, 'victim', 'sentinel.txt'), 'keep')
        await symlink(
          outside,
          join(root, 'skill-backups'),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
        await expect(deleteCreatorSkillBackups(root))
          .rejects.toMatchObject({ code: 'invalid_backup_path' })
        expect(await readFile(join(outside, 'victim', 'sentinel.txt'), 'utf8')).toBe('keep')

        await rm(join(root, 'skill-backups'))
        await mkdir(join(root, 'skill-backups', 'install-test'), { recursive: true })
        await symlink(
          join(outside, 'victim'),
          join(root, 'skill-backups', 'install-test', backupId),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
        await expect(deleteCreatorSkillBackups(root, {
          slug: 'install-test',
          backupId,
        })).rejects.toMatchObject({ code: 'invalid_backup_path' })
        expect(await readFile(join(outside, 'victim', 'sentinel.txt'), 'utf8')).toBe('keep')
        expect(await access(root).then(() => true, () => false)).toBe(true)
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  it('rejects preserved local backup writes through a symlink ancestor', async () => {
    await withWorkspace(async root => {
      const outside = await mkdtemp(join(tmpdir(), 'creator-skill-preserve-outside-'))
      try {
        const first = await packageGrant(root, '1.0.0')
        expect((await installCreatorSkill(root, {
          workspaceId: 'workspace-1',
          operationId: OP_BASE,
          grant: first.grant,
        }, { fetch: responseFetch(first.bytes) })).success).toBe(true)
        const skillPath = join(root, 'skills', 'install-test', 'SKILL.md')
        await writeFile(skillPath, `${skillContent('1.0.0')}\nLocal note.\n`)
        await mkdir(join(root, 'skill-backups'), { recursive: true })
        await symlink(
          outside,
          join(root, 'skill-backups', 'install-test'),
          process.platform === 'win32' ? 'junction' : 'dir',
        )
        await writeFile(join(outside, 'sentinel.txt'), 'keep')

        const next = await packageGrant(root, '2.0.0')
        const result = await installCreatorSkill(root, {
          workspaceId: 'workspace-1',
          operationId: OP_UPDATE,
          grant: next.grant,
          replaceExisting: true,
          backupLocalChanges: true,
        }, { fetch: responseFetch(next.bytes) })

        expect(result).toMatchObject({
          success: false,
          errorCode: 'invalid_backup_path',
        })
        expect(await readFile(skillPath, 'utf8')).toContain('Local note.')
        expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
        expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep')
        expect((await readdir(outside)).sort()).toEqual(['sentinel.txt'])
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  it('rolls back a crash after a preserved local backup was moved', async () => {
    await withWorkspace(async root => {
      const operationPath = join(root, '.creator-skill-ops', OP_RECOVERY)
      const targetPath = join(root, 'skills', 'install-test')
      const preserveBackupPath = join(
        root,
        'skill-backups',
        'install-test',
        '2026-07-30T00-00-00-000Z',
      )
      await mkdir(operationPath, { recursive: true })
      await mkdir(targetPath, { recursive: true })
      await mkdir(preserveBackupPath, { recursive: true })
      await writeFile(join(targetPath, 'SKILL.md'), 'new content')
      await writeFile(join(preserveBackupPath, 'SKILL.md'), 'old local content')
      await writeFile(join(root, 'creator-skills.json'), JSON.stringify({
        schemaVersion: 1,
        installed: [],
      }))
      const oldLedger = `${JSON.stringify({ schemaVersion: 1, installed: [] }, null, 2)}\n`
      await writeFile(join(operationPath, 'journal.json'), JSON.stringify({
        schemaVersion: 1,
        operationId: OP_RECOVERY,
        action: 'install',
        slug: 'install-test',
        targetPath,
        transactionBackupPath: join(operationPath, 'backup'),
        preserveBackupPath,
        ledgerPath: join(root, 'creator-skills.json'),
        oldLedger,
        state: 'ledger_committed',
      }))

      await recoverCreatorSkillOperations(root)

      expect(await readFile(join(targetPath, 'SKILL.md'), 'utf8')).toBe('old local content')
      expect((await readCreatorSkillsLedger(root)).installed).toHaveLength(0)
      expect(await access(operationPath).then(() => true, () => false)).toBe(false)
    })
  })

  it('restores the old directory when stage promotion lands before new_installed', async () => {
    await withWorkspace(async root => {
      const operationPath = join(root, '.creator-skill-ops', OP_FAULT_STAGE_PROMOTED)
      const targetPath = join(root, 'skills', 'install-test')
      const transactionBackupPath = join(operationPath, 'backup')
      await mkdir(targetPath, { recursive: true })
      await mkdir(transactionBackupPath, { recursive: true })
      await writeFile(join(targetPath, 'SKILL.md'), 'new promoted content')
      await writeFile(join(transactionBackupPath, 'SKILL.md'), 'old installed content')

      const oldInstallation = {
        artifactId: 'artifact-old',
        organizationId: 'organization-1',
        slug: 'install-test',
        version: '1.0.0',
        archiveChecksum: 'a'.repeat(64),
        contentDigest: 'b'.repeat(64),
        installedAt: '2026-07-30T00:00:00.000Z',
      }
      const oldLedger = `${JSON.stringify({
        schemaVersion: 1,
        installed: [oldInstallation],
      }, null, 2)}\n`
      await writeFile(join(root, 'creator-skills.json'), JSON.stringify({
        schemaVersion: 1,
        installed: [{
          ...oldInstallation,
          artifactId: 'artifact-new',
          version: '2.0.0',
        }],
      }))
      await writeFile(join(operationPath, 'journal.json'), JSON.stringify({
        schemaVersion: 1,
        operationId: OP_FAULT_STAGE_PROMOTED,
        action: 'install',
        slug: 'install-test',
        targetPath,
        transactionBackupPath,
        ledgerPath: join(root, 'creator-skills.json'),
        oldLedger,
        state: 'old_backed_up',
      }))

      await recoverCreatorSkillOperations(root)

      expect(await readFile(join(targetPath, 'SKILL.md'), 'utf8'))
        .toBe('old installed content')
      expect((await readCreatorSkillsLedger(root)).installed[0])
        .toMatchObject({ artifactId: 'artifact-old', version: '1.0.0' })
      expect(await access(operationPath).then(() => true, () => false)).toBe(false)
    })
  })

  it('restores a backup created before old_backed_up was journaled', async () => {
    await withWorkspace(async root => {
      const operationId = 'abababab-abab-4bab-8bab-abababababab'
      const operationPath = join(root, '.creator-skill-ops', operationId)
      const targetPath = join(root, 'skills', 'install-test')
      const transactionBackupPath = join(operationPath, 'backup')
      await mkdir(transactionBackupPath, { recursive: true })
      await writeFile(join(transactionBackupPath, 'SKILL.md'), 'old prepared content')
      await writeFile(join(operationPath, 'journal.json'), JSON.stringify({
        schemaVersion: 1,
        operationId,
        action: 'install',
        slug: 'install-test',
        targetPath,
        transactionBackupPath,
        ledgerPath: join(root, 'creator-skills.json'),
        oldLedger: null,
        state: 'prepared',
      }))

      await recoverCreatorSkillOperations(root)

      expect(await readFile(join(targetPath, 'SKILL.md'), 'utf8'))
        .toBe('old prepared content')
      expect(await access(join(root, 'creator-skills.json')).then(
        () => true,
        () => false,
      )).toBe(false)
      expect(await access(operationPath).then(() => true, () => false)).toBe(false)
    })
  })

  it('rejects operationId traversal before touching the derived operation path', async () => {
    await withWorkspace(async root => {
      const outside = join(root, 'outside-operation')
      await mkdir(outside)
      await writeFile(join(outside, 'sentinel.txt'), 'keep')
      const packaged = await packageGrant(root, '1.0.0')

      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '../outside-operation',
        grant: packaged.grant,
      }, { fetch: responseFetch(packaged.bytes) })

      expect(result).toMatchObject({
        success: false,
        errorCode: 'invalid_operation_id',
      })
      expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep')
    })
  })

  it('rejects recovery journals that point any transaction path outside the workspace', async () => {
    const pathFields = [
      'targetPath',
      'transactionBackupPath',
      'preserveBackupPath',
    ] as const
    for (const [index, field] of pathFields.entries()) {
      await withWorkspace(async root => {
        const operationId = `aaaaaaa${index + 1}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
        const operationPath = join(root, '.creator-skill-ops', operationId)
        const targetPath = join(root, 'skills', 'install-test')
        const outside = await mkdtemp(join(tmpdir(), `creator-skill-outside-${index}-`))
        try {
          await mkdir(operationPath, { recursive: true })
          await mkdir(targetPath, { recursive: true })
          await writeFile(join(targetPath, 'SKILL.md'), 'new content')
          await writeFile(join(outside, 'sentinel.txt'), 'keep')
          const journal = {
            schemaVersion: 1,
            operationId,
            action: 'install',
            slug: 'install-test',
            targetPath,
            transactionBackupPath: join(operationPath, 'backup'),
            preserveBackupPath: join(
              root,
              'skill-backups',
              'install-test',
              '2026-07-30T00-00-00-000Z',
            ),
            ledgerPath: join(root, 'creator-skills.json'),
            oldLedger: null,
            state: 'ledger_committed',
            [field]: outside,
          }
          await writeFile(join(operationPath, 'journal.json'), JSON.stringify(journal))

          await expect(recoverCreatorSkillOperations(root)).rejects.toMatchObject({
            code: 'creator_skill_recovery_failed',
          })
          expect(await readFile(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep')
          expect(await readFile(join(targetPath, 'SKILL.md'), 'utf8')).toBe('new content')
        } finally {
          await rm(outside, { recursive: true, force: true })
        }
      })
    }
  })

  it('keeps the rollback backup through ledger_committed fault injection', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_FAULT_LEDGER,
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        onJournalPersisted: async state => {
          if (state !== 'ledger_committed') return
          expect(await access(join(
            root,
            '.creator-skill-ops',
            OP_FAULT_LEDGER,
            'backup',
          )).then(() => true, () => false)).toBe(true)
          throw new Error('fault after ledger_committed')
        },
      })

      expect(result.success).toBe(false)
      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('1.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
    })
  })

  it('persists committed before deleting the transaction backup', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_FAULT_COMMITTED,
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        onJournalPersisted: async state => {
          if (state !== 'committed') return
          expect(await access(join(
            root,
            '.creator-skill-ops',
            OP_FAULT_COMMITTED,
            'backup',
          )).then(() => true, () => false)).toBe(true)
          throw new Error('simulated crash after committed')
        },
      })

      expect(result.success).toBe(true)
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('2.0.0')
      await recoverCreatorSkillOperations(root)
      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('2.0.0'))
      expect(await access(join(
        root,
        '.creator-skill-ops',
        OP_FAULT_COMMITTED,
      )).then(() => true, () => false)).toBe(false)
    })
  })

  it('keeps recovery material when committed directory fsync is unsupported', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const operationPath = join(
        root,
        '.creator-skill-ops',
        OP_UNSUPPORTED_DIRECTORY_SYNC,
      )
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_UNSUPPORTED_DIRECTORY_SYNC,
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        syncJournalDirectory: async () => {
          throw Object.assign(new Error('Directory fsync is not supported'), {
            code: 'ENOTSUP',
          })
        },
      })

      expect(result.success).toBe(true)
      expect(await access(join(operationPath, 'backup')).then(
        () => true,
        () => false,
      )).toBe(true)
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('2.0.0')

      // Model a power loss where the latest directory-entry rename is not
      // durable and recovery observes the previous checkpoint.
      const journalPath = join(operationPath, 'journal.json')
      const staleJournal = JSON.parse(await readFile(journalPath, 'utf8'))
      staleJournal.state = 'ledger_committed'
      await writeFile(journalPath, JSON.stringify(staleJournal))

      await recoverCreatorSkillOperations(root)

      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('1.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
      expect(await access(operationPath).then(() => true, () => false)).toBe(false)
    })
  })

  it('finishes committed recovery after a crash following transaction backup cleanup', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const operationPath = join(root, '.creator-skill-ops', OP_FAULT_BACKUP_REMOVED)
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_FAULT_BACKUP_REMOVED,
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        onCleanupStep: async step => {
          if (step !== 'transaction_backup_removed') return
          expect(await access(join(operationPath, 'backup')).then(
            () => true,
            () => false,
          )).toBe(false)
          expect(JSON.parse(
            await readFile(join(operationPath, 'journal.json'), 'utf8'),
          ).state).toBe('committed')
          throw new Error('simulated crash after transaction backup cleanup')
        },
      })

      expect(result.success).toBe(true)
      expect(await access(operationPath).then(() => true, () => false)).toBe(true)
      await recoverCreatorSkillOperations(root)
      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('2.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('2.0.0')
      expect(await access(operationPath).then(() => true, () => false)).toBe(false)
    })
  })

  it('returns the committed result after a crash following operation cleanup', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const operationPath = join(root, '.creator-skill-ops', OP_FAULT_OPERATION_REMOVED)
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_FAULT_OPERATION_REMOVED,
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        onCleanupStep: async step => {
          if (step !== 'operation_removed') return
          expect(await access(operationPath).then(() => true, () => false)).toBe(false)
          throw new Error('simulated crash after operation cleanup')
        },
      })

      expect(result.success).toBe(true)
      expect(await access(operationPath).then(() => true, () => false)).toBe(false)
      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('2.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('2.0.0')
    })
  })
})
