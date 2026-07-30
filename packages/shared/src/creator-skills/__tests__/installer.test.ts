import { describe, expect, it } from 'bun:test'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { validateCreatorSkillArchive } from '../archive'
import {
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
        operationId: 'operation-install',
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
        operationId: 'operation-first',
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: 'operation-blocked',
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

  it('backs up local changes and detaches modified content on safe uninstall', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: 'operation-base',
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const skillPath = join(root, 'skills', 'install-test', 'SKILL.md')
      await writeFile(skillPath, `${skillContent('1.0.0')}\nLocal note.\n`)
      const next = await packageGrant(root, '2.0.0')
      const update = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: 'operation-update',
        grant: next.grant,
        replaceExisting: true,
        backupLocalChanges: true,
      }, { fetch: responseFetch(next.bytes) })

      expect(update.success).toBe(true)
      const backups = await listCreatorSkillBackups(root)
      expect(backups).toHaveLength(1)
      expect(await readFile(join(backups[0]!.path, 'SKILL.md'), 'utf8')).toContain('Local note.')

      await writeFile(skillPath, `${skillContent('2.0.0')}\nAnother local note.\n`)
      const uninstall = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: 'operation-uninstall',
        slug: 'install-test',
      })
      expect(uninstall).toMatchObject({ success: true, detached: true })
      expect(await access(skillPath).then(() => true, () => false)).toBe(true)
      expect((await readCreatorSkillsLedger(root)).installed).toHaveLength(0)
    })
  })

  it('rolls back a crash after a preserved local backup was moved', async () => {
    await withWorkspace(async root => {
      const operationPath = join(root, '.creator-skill-ops', 'recovery-operation')
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
        operationId: 'recovery-operation',
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
})
