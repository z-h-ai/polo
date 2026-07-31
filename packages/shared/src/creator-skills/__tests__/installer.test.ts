import { describe, expect, it } from 'bun:test'
import {
  access,
  mkdir,
  mkdtemp,
  open,
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
  cancelCreatorSkillOperation,
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
const OP_LATE_DOWNLOAD_EDIT = '12121212-1212-4212-8212-121212121212'
const OP_LATE_SAFETY_EDIT = '13131313-1313-4313-8313-131313131313'
const OP_LATE_JOURNAL_EDIT = '14141414-1414-4414-8414-141414141414'
const OP_POST_JOURNAL_EDIT = '15151515-1515-4515-8515-151515151515'
const OP_OPEN_HANDLE_OLD_BACKED_UP = '16161616-1616-4616-8616-161616161616'
const OP_OPEN_HANDLE_NEW_INSTALLED = '17171717-1717-4717-8717-171717171717'
const OP_OPEN_HANDLE_LEDGER_COMMITTED = '18181818-1818-4818-8818-181818181818'
const OP_OPEN_HANDLE_COMMITTED = '19191919-1919-4919-8919-191919191919'
const OP_OPEN_HANDLE_CLEANUP = '20202020-2020-4020-8020-202020202020'

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
  options: {
    slug?: string
    artifactId?: string
    organizationId?: string
  } = {},
): Promise<{ bytes: Uint8Array; grant: CreatorSkillDownloadGrant }> {
  const slug = options.slug ?? 'install-test'
  const bytes = zipSync({
    [`${slug}/SKILL.md`]: strToU8(skillContent(version)),
    [`${slug}/references/version.txt`]: strToU8(version),
  })
  const archivePath = join(root, `${slug}-${version}.zip`)
  await writeFile(archivePath, bytes)
  const validated = await validateCreatorSkillArchive({
    archivePath,
    slug,
  })
  return {
    bytes,
    grant: {
      artifactId: options.artifactId ?? 'artifact-1',
      organizationId: options.organizationId ?? 'organization-1',
      slug,
      version,
      url: `https://download.invalid/${slug}-${version}.zip`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      archiveChecksum: validated.archiveChecksum,
      contentDigest: validated.contentDigest,
      manifest: validated.manifest,
      validationPolicy: DEFAULT_SKILL_ARCHIVE_POLICY,
    },
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
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

  it('durably journals preparing before download content is persisted', async () => {
    await withWorkspace(async root => {
      const packaged = await packageGrant(root, '1.0.0')
      const fetchStarted = deferred()
      const releaseFetch = deferred<Response>()
      const install = installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '28282828-2828-4828-8828-282828282828',
        grant: packaged.grant,
      }, {
        fetch: (async () => {
          fetchStarted.resolve()
          return releaseFetch.promise
        }) as unknown as typeof fetch,
      })
      await fetchStarted.promise

      const operationPath = join(
        root,
        '.creator-skill-ops',
        '28282828-2828-4828-8828-282828282828',
      )
      expect(JSON.parse(await readFile(
        join(operationPath, 'journal.json'),
        'utf8',
      ))).toMatchObject({
        state: 'preparing',
        slug: packaged.grant.slug,
      })
      expect(await access(join(operationPath, 'stage')).then(
        () => true,
        () => false,
      )).toBe(true)
      expect(await access(join(operationPath, 'archive.zip')).then(
        () => true,
        () => false,
      )).toBe(false)

      releaseFetch.resolve(new Response(packaged.bytes, {
        status: 200,
        headers: { 'content-length': String(packaged.bytes.byteLength) },
      }))
      expect((await install).success).toBe(true)
    })
  })

  it('cleans abandoned download, extraction, and validation preparation on startup', async () => {
    const phases = ['download', 'extract', 'validate'] as const
    for (const [index, phase] of phases.entries()) {
      await withWorkspace(async root => {
        const operationId = `2929292${index}-2929-4929-8929-29292929292${index}`
        const operationPath = join(root, '.creator-skill-ops', operationId)
        await mkdir(operationPath, { recursive: true })
        if (phase !== 'download') {
          await mkdir(join(operationPath, 'stage', 'install-test'), {
            recursive: true,
          })
          await writeFile(
            join(operationPath, 'stage', 'install-test', 'SKILL.md'),
            phase === 'extract' ? 'partial' : skillContent('1.0.0'),
          )
        }
        await writeFile(join(operationPath, 'archive.zip'), `partial-${phase}`)

        await recoverCreatorSkillOperations(root)

        expect(await access(operationPath).then(
          () => true,
          () => false,
        )).toBe(false)
      })
    }
  })

  it('rejects operationId replay without deleting an inherited backup', async () => {
    await withWorkspace(async root => {
      const operationId = '2a2a2a2a-2a2a-4a2a-8a2a-2a2a2a2a2a2a'
      const operationPath = join(root, '.creator-skill-ops', operationId)
      await mkdir(join(operationPath, 'backup'), { recursive: true })
      await writeFile(join(operationPath, 'backup', 'sentinel.txt'), 'keep')
      const packaged = await packageGrant(root, '1.0.0')

      expect(await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId,
        grant: packaged.grant,
      }, {
        fetch: responseFetch(packaged.bytes),
      })).toMatchObject({
        success: false,
        errorCode: 'creator_skill_operation_id_conflict',
      })
      expect(await readFile(
        join(operationPath, 'backup', 'sentinel.txt'),
        'utf8',
      )).toBe('keep')
      await expect(recoverCreatorSkillOperations(root)).rejects.toMatchObject({
        code: 'creator_skill_recovery_failed',
      })
      expect(await readFile(
        join(operationPath, 'backup', 'sentinel.txt'),
        'utf8',
      )).toBe('keep')
    })
  })

  it('reserves operationId across slugs and scopes cancellation to workspace and client', async () => {
    await withWorkspace(async root => {
      const operationId = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b'
      const alpha = await packageGrant(root, '1.0.0', {
        slug: 'alpha-skill',
        artifactId: 'artifact-alpha',
      })
      const beta = await packageGrant(root, '1.0.0', {
        slug: 'beta-skill',
        artifactId: 'artifact-beta',
      })
      const fetchStarted = deferred()
      const releaseFetch = deferred<Response>()
      const first = installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId,
        grant: alpha.grant,
      }, {
        operationOwnerId: 'client-one',
        fetch: (async () => {
          fetchStarted.resolve()
          return releaseFetch.promise
        }) as unknown as typeof fetch,
      })
      await fetchStarted.promise

      expect(await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId,
        grant: beta.grant,
      }, {
        operationOwnerId: 'client-two',
        fetch: responseFetch(beta.bytes),
      })).toMatchObject({
        success: false,
        errorCode: 'creator_skill_operation_id_conflict',
      })
      expect(await cancelCreatorSkillOperation(
        root,
        'client-two',
        operationId,
      )).toBe(false)
      expect(await cancelCreatorSkillOperation(
        root,
        'client-one',
        operationId,
      )).toBe(true)

      releaseFetch.resolve(new Response(alpha.bytes, {
        status: 200,
        headers: { 'content-length': String(alpha.bytes.byteLength) },
      }))
      expect(await first).toMatchObject({
        success: false,
        errorCode: 'creator_skill_cancelled',
      })
      expect(await access(join(
        root,
        '.creator-skill-ops',
        operationId,
      )).then(() => true, () => false)).toBe(false)
    })
  })

  it('serializes different-slug installs through the workspace Ledger lock', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0', {
        slug: 'alpha-skill',
        artifactId: 'artifact-alpha',
      })
      const second = await packageGrant(root, '1.0.0', {
        slug: 'beta-skill',
        artifactId: 'artifact-beta',
      })
      const firstLocked = deferred()
      const releaseFirst = deferred()
      const secondContended = deferred()
      let secondLocked = false
      const firstInstall = installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '30303030-3030-4030-8030-303030303030',
        grant: first.grant,
      }, {
        fetch: responseFetch(first.bytes),
        onLedgerMutationLocked: async () => {
          firstLocked.resolve()
          await releaseFirst.promise
        },
      })
      await firstLocked.promise

      const secondInstall = installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '31313131-3131-4131-8131-313131313131',
        grant: second.grant,
      }, {
        fetch: responseFetch(second.bytes),
        onLedgerMutationLockContended: () => secondContended.resolve(),
        onLedgerMutationLocked: () => {
          secondLocked = true
        },
      })
      await secondContended.promise
      expect(secondLocked).toBe(false)

      releaseFirst.resolve()
      expect((await Promise.all([firstInstall, secondInstall])).every(
        result => result.success,
      )).toBe(true)
      expect((await readCreatorSkillsLedger(root)).installed.map(
        item => item.slug,
      )).toEqual(['alpha-skill', 'beta-skill'])
    })
  })

  it('merges a different-slug uninstall with an in-flight safety metadata update', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0', {
        slug: 'alpha-skill',
        artifactId: 'artifact-alpha',
      })
      const second = await packageGrant(root, '1.0.0', {
        slug: 'beta-skill',
        artifactId: 'artifact-beta',
      })
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '32323232-3232-4232-8232-323232323232',
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '33333334-3333-4333-8333-333333333334',
        grant: second.grant,
      }, { fetch: responseFetch(second.bytes) })).success).toBe(true)

      const uninstallLocked = deferred()
      const releaseUninstall = deferred()
      const metadataContended = deferred()
      let metadataLocked = false
      const uninstall = uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: '34343434-3434-4434-8434-343434343434',
        slug: first.grant.slug,
      }, {
        onLedgerMutationLocked: async () => {
          uninstallLocked.resolve()
          await releaseUninstall.promise
        },
      })
      await uninstallLocked.promise

      const metadataUpdate = updateCreatorSkillInstallationMetadata({
        workspaceRoot: root,
        artifactId: second.grant.artifactId,
        version: second.grant.version,
        archiveChecksum: second.grant.archiveChecksum,
        changes: {
          lastKnownStatus: 'revoked',
          lastCheckedAt: '2026-07-30T12:00:00.000Z',
        },
      }, {
        onLedgerMutationLockContended: () => metadataContended.resolve(),
        onLedgerMutationLocked: () => {
          metadataLocked = true
        },
      })
      await metadataContended.promise
      expect(metadataLocked).toBe(false)

      releaseUninstall.resolve()
      expect((await uninstall).success).toBe(true)
      expect(await metadataUpdate).toBe(true)
      expect((await readCreatorSkillsLedger(root)).installed).toEqual([
        expect.objectContaining({
          slug: 'beta-skill',
          lastKnownStatus: 'revoked',
          lastCheckedAt: '2026-07-30T12:00:00.000Z',
        }),
      ])
    })
  })

  it('keeps revoked terminal when a delayed active safety response arrives', async () => {
    await withWorkspace(async root => {
      const packaged = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '2c2c2c2c-2c2c-4c2c-8c2c-2c2c2c2c2c2c',
        grant: packaged.grant,
      }, { fetch: responseFetch(packaged.bytes) })).success).toBe(true)

      expect(await updateCreatorSkillInstallationMetadata({
        workspaceRoot: root,
        artifactId: packaged.grant.artifactId,
        version: packaged.grant.version,
        archiveChecksum: packaged.grant.archiveChecksum,
        changes: {
          lastKnownStatus: 'revoked',
          lastCheckedAt: '2026-07-30T10:00:00.000Z',
        },
      })).toBe(true)
      expect(await updateCreatorSkillInstallationMetadata({
        workspaceRoot: root,
        artifactId: packaged.grant.artifactId,
        version: packaged.grant.version,
        archiveChecksum: packaged.grant.archiveChecksum,
        changes: {
          lastKnownStatus: 'active',
          lastCheckedAt: '2026-07-30T10:01:00.000Z',
        },
      })).toBe(true)

      expect((await readCreatorSkillsLedger(root)).installed[0]).toMatchObject({
        lastKnownStatus: 'revoked',
        lastCheckedAt: '2026-07-30T10:01:00.000Z',
      })
    })
  })

  it('rolls back directory and Ledger when Ledger durability is not confirmed', async () => {
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
        operationId: '2d2d2d2d-2d2d-4d2d-8d2d-2d2d2d2d2d2d',
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        ledgerWriteDependencies: {
          onStep: step => {
            if (step === 'ledger_renamed') {
              throw Object.assign(new Error('Ledger directory fsync interrupted'), {
                code: 'EIO',
              })
            }
          },
        },
      })

      expect(result.success).toBe(false)
      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('1.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version)
        .toBe('1.0.0')
      expect(await listCreatorSkillBackups(root)).toHaveLength(0)
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

  it('keeps raw Node filesystem errors server-only', async () => {
    await withWorkspace(async root => {
      const packaged = await packageGrant(root, '1.0.0')
      const privatePath = join(root, '.creator-skill-ops', 'private-stage')
      const systemError = Object.assign(
        new Error(`EACCES: permission denied, rename '${privatePath}'`),
        {
          code: 'EACCES',
          path: privatePath,
          dest: join(root, 'skills', 'install-test'),
        },
      )
      let loggedError: unknown

      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '50505050-5050-4050-8050-505050505050',
        grant: packaged.grant,
      }, {
        fetch: responseFetch(packaged.bytes),
        beforeCommitSnapshot: () => {
          throw systemError
        },
        onError: error => {
          loggedError = error
        },
      })

      expect(result).toMatchObject({
        success: false,
        errorCode: 'creator_skill_install_failed',
        message: 'Creator Skill installation failed',
      })
      expect(loggedError).toBe(systemError)
      expect(JSON.stringify(result)).not.toContain(root)
      expect(JSON.stringify(result)).not.toContain('EACCES')
      expect(result).not.toHaveProperty('path')
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
      expect(backups[0]).toMatchObject({
        operation: 'modified_update',
        version: '1.0.0',
      })
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
      expect(uninstall).toMatchObject({
        success: true,
        detached: true,
      })
      const forceDeleteCredential = uninstall.success
        ? uninstall.forceDeleteCredential
        : undefined
      expect(typeof forceDeleteCredential).toBe('string')
      expect(await access(skillPath).then(() => true, () => false)).toBe(true)
      expect((await readCreatorSkillsLedger(root)).installed).toHaveLength(0)

      let forceError: unknown
      const forced = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        slug: 'install-test',
        forceDeleteModified: true,
        forceDeleteCredential,
      }, { onError: error => { forceError = error } })
      expect(forceError).toBeUndefined()
      expect(forced).toMatchObject({ success: true })
      expect(await access(skillPath).then(() => true, () => false)).toBe(false)
    })
  })

  it('requires a persistent one-time credential bound to the detached directory', async () => {
    await withWorkspace(async root => {
      const packaged = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: packaged.grant,
      }, { fetch: responseFetch(packaged.bytes) })).success).toBe(true)
      const targetPath = join(root, 'skills', 'install-test')
      await writeFile(join(targetPath, 'local-note.txt'), 'first local change')

      const detached = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: '37373737-3737-4737-8737-373737373737',
        slug: 'install-test',
      })
      expect(detached).toMatchObject({
        success: true,
        detached: true,
      })
      const initialCredential = detached.success
        ? detached.forceDeleteCredential
        : undefined
      expect(typeof initialCredential).toBe('string')
      expect(await access(join(root, '.creator-skill-force-delete.json')).then(
        () => true,
        () => false,
      )).toBe(true)
      expect(await readFile(join(root, '.creator-skill-force-delete.json'), 'utf8'))
        .not.toContain(initialCredential!)

      for (const [operationId, forceDeleteCredential] of [
        ['38383838-3838-4838-8838-383838383838', undefined],
        ['39393939-3939-4939-8939-393939393939', 'wrong-credential-token-that-is-long-enough'],
      ] as const) {
        const rejected = await uninstallCreatorSkill({
          workspaceRoot: root,
          workspaceId: 'workspace-1',
          operationId,
          slug: 'install-test',
          forceDeleteModified: true,
          ...(forceDeleteCredential ? { forceDeleteCredential } : {}),
        })
        expect(rejected).toMatchObject({
          success: false,
          errorCode: 'creator_skill_force_delete_credential_required',
        })
      }

      await writeFile(join(targetPath, 'local-note.txt'), 'changed after confirmation')
      let staleError: unknown
      const stale = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: '40404040-4040-4040-8040-404040404040',
        slug: 'install-test',
        forceDeleteModified: true,
        forceDeleteCredential: initialCredential,
      }, { onError: error => { staleError = error } })
      expect(staleError).toMatchObject({
        code: 'creator_skill_force_delete_stale',
      })
      expect(stale).toMatchObject({
        success: false,
        errorCode: 'creator_skill_force_delete_stale',
      })
      expect(await readFile(join(targetPath, 'local-note.txt'), 'utf8'))
        .toBe('changed after confirmation')

      const reconfirmed = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: '41414141-4141-4141-8141-414141414141',
        slug: 'install-test',
      })
      expect(reconfirmed).toMatchObject({
        success: true,
        detached: true,
      })
      const refreshedCredential = reconfirmed.success
        ? reconfirmed.forceDeleteCredential
        : undefined
      expect(typeof refreshedCredential).toBe('string')
      const deleted = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: '42424242-4242-4242-8242-424242424242',
        slug: 'install-test',
        forceDeleteModified: true,
        forceDeleteCredential: refreshedCredential,
      })
      expect(deleted).toMatchObject({ success: true })
      expect(await access(targetPath).then(() => true, () => false)).toBe(false)
      expect(await access(join(root, '.creator-skill-force-delete.json')).then(
        () => true,
        () => false,
      )).toBe(false)

      const replay = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: '43434343-4343-4343-8343-434343434343',
        slug: 'install-test',
        forceDeleteModified: true,
        forceDeleteCredential: refreshedCredential,
      })
      expect(replay).toMatchObject({
        success: false,
        errorCode: 'creator_skill_not_installed',
      })
    })
  })

  it('never force-deletes an unmanaged ordinary Skill without a credential', async () => {
    await withWorkspace(async root => {
      const targetPath = join(root, 'skills', 'install-test')
      await mkdir(targetPath, { recursive: true })
      await writeFile(join(targetPath, 'SKILL.md'), skillContent('local'))

      const result = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: '44444445-4444-4444-8444-444444444445',
        slug: 'install-test',
        forceDeleteModified: true,
        forceDeleteCredential: 'untrusted-credential-token-that-is-long-enough',
      })

      expect(result).toMatchObject({
        success: false,
        errorCode: 'creator_skill_not_installed',
      })
      expect(await readFile(join(targetPath, 'SKILL.md'), 'utf8'))
        .toBe(skillContent('local'))
    })
  })

  it('rejects local edits made while the update archive is downloading', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const lateEditPath = join(root, 'skills', 'install-test', 'late-download-edit.txt')
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_LATE_DOWNLOAD_EDIT,
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: (async () => {
          await writeFile(lateEditPath, 'keep this download-window edit')
          return new Response(next.bytes, {
            status: 200,
            headers: { 'content-length': String(next.bytes.byteLength) },
          })
        }) as unknown as typeof fetch,
      })

      expect(result).toMatchObject({
        success: false,
        errorCode: 'creator_skill_conflict',
        conflicts: ['local_changes'],
      })
      expect(await readFile(lateEditPath, 'utf8')).toBe('keep this download-window edit')
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
      expect(await listCreatorSkillBackups(root)).toHaveLength(0)
    })
  })

  it('rejects local edits made by the final safety-check window', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const lateEditPath = join(root, 'skills', 'install-test', 'late-safety-edit.txt')
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_LATE_SAFETY_EDIT,
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        assertCommitAllowed: async () => {
          await writeFile(lateEditPath, 'keep this safety-window edit')
        },
      })

      expect(result).toMatchObject({
        success: false,
        errorCode: 'creator_skill_conflict',
        conflicts: ['local_changes'],
      })
      expect(await readFile(lateEditPath, 'utf8')).toBe('keep this safety-window edit')
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
      expect(await listCreatorSkillBackups(root)).toHaveLength(0)
    })
  })

  it('backs up the latest old directory snapshot when a pre-journal edit was confirmed', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const lateEditPath = join(root, 'skills', 'install-test', 'late-journal-edit.txt')
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_LATE_JOURNAL_EDIT,
        grant: next.grant,
        replaceExisting: true,
        backupLocalChanges: true,
      }, {
        fetch: responseFetch(next.bytes),
        beforeCommitSnapshot: async () => {
          await writeFile(lateEditPath, 'preserve this pre-journal edit')
        },
      })

      expect(result.success).toBe(true)
      const backups = await listCreatorSkillBackups(root)
      expect(backups).toHaveLength(1)
      expect(await readFile(join(
        root,
        'skill-backups',
        backups[0]!.slug,
        backups[0]!.backupId,
        'late-journal-edit.txt',
      ), 'utf8')).toBe('preserve this pre-journal edit')
      expect(await access(lateEditPath).then(() => true, () => false)).toBe(false)
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('2.0.0')
    })
  })

  it('rolls back an unconfirmed edit made after the prepared journal was persisted', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      const lateEditPath = join(root, 'skills', 'install-test', 'post-journal-edit.txt')
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_POST_JOURNAL_EDIT,
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        onJournalPersisted: async state => {
          if (state === 'prepared') {
            await writeFile(lateEditPath, 'keep this post-journal edit')
          }
        },
      })

      expect(result).toMatchObject({
        success: false,
        errorCode: 'creator_skill_conflict',
        conflicts: ['local_changes'],
      })
      expect(await readFile(lateEditPath, 'utf8')).toBe('keep this post-journal edit')
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
      expect(await listCreatorSkillBackups(root)).toHaveLength(0)
    })
  })

  it('preserves empty and non-empty target recreations before update promotion', async () => {
    for (const [index, nonEmpty] of [false, true].entries()) {
      await withWorkspace(async root => {
        const first = await packageGrant(root, '1.0.0')
        expect((await installCreatorSkill(root, {
          workspaceId: 'workspace-1',
          operationId: OP_BASE,
          grant: first.grant,
        }, { fetch: responseFetch(first.bytes) })).success).toBe(true)
        const next = await packageGrant(root, '2.0.0')
        const targetPath = join(root, 'skills', 'install-test')

        const result = await installCreatorSkill(root, {
          workspaceId: 'workspace-1',
          operationId: index === 0
            ? '45454545-4545-4545-8545-454545454545'
            : '46464646-4646-4646-8646-464646464646',
          grant: next.grant,
          replaceExisting: true,
        }, {
          fetch: responseFetch(next.bytes),
          onJournalPersisted: async state => {
            if (state !== 'old_backed_up') return
            await mkdir(targetPath)
            if (nonEmpty) {
              await writeFile(join(targetPath, 'concurrent.txt'), 'preserve recreation')
            }
          },
        })

        expect(result).toMatchObject({ success: true })
        expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('2.0.0')
        const recreated = (await listCreatorSkillBackups(root))
          .find(backup => backup.operation === 'concurrent_recreation')
        expect(recreated).toBeTruthy()
        if (nonEmpty) {
          expect(await readFile(join(
            root,
            'skill-backups',
            recreated!.slug,
            recreated!.backupId,
            'concurrent.txt',
          ), 'utf8')).toBe('preserve recreation')
        }
      })
    }
  })

  it('snapshots a replaced transaction target before restoring the old Skill', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)
      const next = await packageGrant(root, '2.0.0')
      const targetPath = join(root, 'skills', 'install-test')

      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '47474747-4747-4747-8747-474747474747',
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        onJournalPersisted: async state => {
          if (state !== 'new_installed') return
          await rm(targetPath, { recursive: true })
          await mkdir(targetPath)
          await writeFile(join(targetPath, 'concurrent.txt'), 'replacement content')
        },
      })

      expect(result).toMatchObject({
        success: false,
        errorCode: 'creator_skill_conflict',
      })
      expect(await readFile(join(targetPath, 'SKILL.md'), 'utf8'))
        .toBe(skillContent('1.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
      const recreated = (await listCreatorSkillBackups(root))
        .find(backup => backup.operation === 'concurrent_recreation')
      expect(await readFile(join(
        root,
        'skill-backups',
        recreated!.slug,
        recreated!.backupId,
        'concurrent.txt',
      ), 'utf8')).toBe('replacement content')
    })
  })

  it('moves clean-uninstall target recreations into managed safety snapshots', async () => {
    for (const [index, nonEmpty] of [false, true].entries()) {
      await withWorkspace(async root => {
        const packaged = await packageGrant(root, '1.0.0')
        expect((await installCreatorSkill(root, {
          workspaceId: 'workspace-1',
          operationId: OP_BASE,
          grant: packaged.grant,
        }, { fetch: responseFetch(packaged.bytes) })).success).toBe(true)
        const targetPath = join(root, 'skills', 'install-test')

        const result = await uninstallCreatorSkill({
          workspaceRoot: root,
          workspaceId: 'workspace-1',
          operationId: index === 0
            ? '48484848-4848-4848-8848-484848484848'
            : '49494949-4949-4949-8949-494949494949',
          slug: 'install-test',
        }, {
          onJournalPersisted: async state => {
            if (state !== 'old_backed_up') return
            await mkdir(targetPath)
            if (nonEmpty) {
              await writeFile(join(targetPath, 'concurrent.txt'), 'uninstall recreation')
            }
          },
        })

        expect(result).toMatchObject({ success: true })
        expect(await access(targetPath).then(() => true, () => false)).toBe(false)
        const recreated = (await listCreatorSkillBackups(root))
          .find(backup => backup.operation === 'concurrent_recreation')
        expect(recreated).toBeTruthy()
        if (nonEmpty) {
          expect(await readFile(join(
            root,
            'skill-backups',
            recreated!.slug,
            recreated!.backupId,
            'concurrent.txt',
          ), 'utf8')).toBe('uninstall recreation')
        }
      })
    }
  })

  it('keeps open-handle writes from every post-rename update window', async () => {
    const cases = [
      {
        operationId: OP_OPEN_HANDLE_OLD_BACKED_UP,
        journalState: 'old_backed_up',
      },
      {
        operationId: OP_OPEN_HANDLE_NEW_INSTALLED,
        journalState: 'new_installed',
      },
      {
        operationId: OP_OPEN_HANDLE_LEDGER_COMMITTED,
        journalState: 'ledger_committed',
      },
      {
        operationId: OP_OPEN_HANDLE_COMMITTED,
        journalState: 'committed',
      },
      {
        operationId: OP_OPEN_HANDLE_CLEANUP,
        cleanupStep: 'operation_removed',
      },
    ] as const

    for (const testCase of cases) {
      await withWorkspace(async root => {
        const first = await packageGrant(root, '1.0.0')
        expect((await installCreatorSkill(root, {
          workspaceId: 'workspace-1',
          operationId: OP_BASE,
          grant: first.grant,
        }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

        const oldFilePath = join(
          root,
          'skills',
          'install-test',
          'references',
          'version.txt',
        )
        const oldFileHandle = await open(oldFilePath, 'a')
        const marker = `late-${testCase.operationId}`
        const writeLateEdit = async () => {
          await oldFileHandle.writeFile(`\n${marker}`)
          await oldFileHandle.sync()
        }
        try {
          const next = await packageGrant(root, '2.0.0')
          const result = await installCreatorSkill(root, {
            workspaceId: 'workspace-1',
            operationId: testCase.operationId,
            grant: next.grant,
            replaceExisting: true,
          }, {
            fetch: responseFetch(next.bytes),
            onJournalPersisted: async state => {
              if ('journalState' in testCase && state === testCase.journalState) {
                await writeLateEdit()
              }
            },
            onCleanupStep: async step => {
              if ('cleanupStep' in testCase && step === testCase.cleanupStep) {
                await writeLateEdit()
              }
            },
          })

          expect(result.success).toBe(true)
        } finally {
          await oldFileHandle.close()
        }

        const backups = await listCreatorSkillBackups(root)
        expect(backups).toHaveLength(1)
        expect(await readFile(join(
          root,
          'skill-backups',
          backups[0]!.slug,
          backups[0]!.backupId,
          'references',
          'version.txt',
        ), 'utf8')).toContain(marker)
        expect(await readFile(
          join(root, 'skills', 'install-test', 'references', 'version.txt'),
          'utf8',
        )).toBe('2.0.0')
      })
    }
  })

  it('moves a clean uninstall into a safety snapshot and preserves every late-write window', async () => {
    const cases = [
      {
        operationId: '21212121-2121-4121-8121-212121212121',
        afterScan: true,
      },
      {
        operationId: '22222223-2222-4222-8222-222222222223',
        journalState: 'old_backed_up',
      },
      {
        operationId: '23232323-2323-4323-8323-232323232323',
        journalState: 'ledger_committed',
      },
      {
        operationId: '24242424-2424-4424-8424-242424242424',
        journalState: 'committed',
      },
      {
        operationId: '25252525-2525-4525-8525-252525252525',
        cleanupStep: 'operation_removed',
      },
    ] as const

    for (const testCase of cases) {
      await withWorkspace(async root => {
        const first = await packageGrant(root, '1.0.0')
        expect((await installCreatorSkill(root, {
          workspaceId: 'workspace-1',
          operationId: OP_BASE,
          grant: first.grant,
        }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

        const oldFilePath = join(
          root,
          'skills',
          'install-test',
          'references',
          'version.txt',
        )
        const oldFileHandle = await open(oldFilePath, 'a')
        const marker = `late-uninstall-${testCase.operationId}`
        const writeLateEdit = async () => {
          await oldFileHandle.writeFile(`\n${marker}`)
          await oldFileHandle.sync()
        }
        try {
          const result = await uninstallCreatorSkill({
            workspaceRoot: root,
            workspaceId: 'workspace-1',
            operationId: testCase.operationId,
            slug: 'install-test',
          }, {
            beforeCommitSnapshot: async () => {
              if ('afterScan' in testCase) await writeLateEdit()
            },
            onJournalPersisted: async state => {
              if ('journalState' in testCase && state === testCase.journalState) {
                await writeLateEdit()
              }
            },
            onCleanupStep: async step => {
              if ('cleanupStep' in testCase && step === testCase.cleanupStep) {
                await writeLateEdit()
              }
            },
          })

          expect(result).toMatchObject({
            success: true,
          })
        } finally {
          await oldFileHandle.close()
        }

        expect(await access(oldFilePath).then(() => true, () => false)).toBe(false)
        const backups = await listCreatorSkillBackups(root)
        expect(backups).toHaveLength(1)
        expect(backups[0]).toMatchObject({
          slug: 'install-test',
          operation: 'clean_uninstall_snapshot',
          version: '1.0.0',
        })
        expect(await readFile(join(
          root,
          'skill-backups',
          backups[0]!.slug,
          backups[0]!.backupId,
          'references',
          'version.txt',
        ), 'utf8')).toContain(marker)
        expect((await readCreatorSkillsLedger(root)).installed).toHaveLength(0)
        expect(await access(join(
          root,
          '.creator-skill-ops',
          testCase.operationId,
        )).then(() => true, () => false)).toBe(false)
      })
    }
  })

  it('retains a distinct safety snapshot for consecutive clean upgrades', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const second = await packageGrant(root, '2.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_UPDATE,
        grant: second.grant,
        replaceExisting: true,
      }, { fetch: responseFetch(second.bytes) })).success).toBe(true)

      const third = await packageGrant(root, '3.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '26262626-2626-4626-8626-262626262626',
        grant: third.grant,
        replaceExisting: true,
      }, { fetch: responseFetch(third.bytes) })).success).toBe(true)

      const backups = await listCreatorSkillBackups(root)
      expect(backups).toHaveLength(2)
      expect(backups.map(item => item.operation)).toEqual([
        'update_safety_snapshot',
        'update_safety_snapshot',
      ])
      expect(backups.map(item => item.version).sort()).toEqual(['1.0.0', '2.0.0'])
      expect(await readFile(
        join(root, 'skills', 'install-test', 'references', 'version.txt'),
        'utf8',
      )).toBe('3.0.0')
    })
  })

  it('rolls a clean uninstall back if it fails after the Ledger checkpoint', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const result = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: '27272727-2727-4727-8727-272727272727',
        slug: 'install-test',
      }, {
        onJournalPersisted: state => {
          if (state === 'ledger_committed') {
            throw new Error('fault after uninstall ledger checkpoint')
          }
        },
      })

      expect(result).toMatchObject({
        success: false,
        errorCode: 'creator_skill_uninstall_failed',
      })
      expect(await readFile(
        join(root, 'skills', 'install-test', 'references', 'version.txt'),
        'utf8',
      )).toBe('1.0.0')
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
      expect(await listCreatorSkillBackups(root)).toHaveLength(0)
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
      const recreation = (await listCreatorSkillBackups(root))
        .find(backup => backup.operation === 'concurrent_recreation')
      expect(await readFile(join(
        root,
        'skill-backups',
        recreation!.slug,
        recreation!.backupId,
        'SKILL.md',
      ), 'utf8')).toBe('new promoted content')

      await recoverCreatorSkillOperations(root)
      expect(await readFile(join(targetPath, 'SKILL.md'), 'utf8'))
        .toBe('old installed content')
      expect((await listCreatorSkillBackups(root))
        .filter(backup => backup.operation === 'concurrent_recreation'))
        .toHaveLength(1)
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

  it('keeps a restored detached directory when recovery sees the pre-commit checkpoint', async () => {
    await withWorkspace(async root => {
      const operationId = '26262626-2626-4626-8626-262626262626'
      const operationPath = join(root, '.creator-skill-ops', operationId)
      const targetPath = join(root, 'skills', 'install-test')
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
      await mkdir(operationPath, { recursive: true })
      await mkdir(targetPath, { recursive: true })
      await writeFile(join(targetPath, 'SKILL.md'), 'restored detached content')
      await writeFile(join(root, 'creator-skills.json'), JSON.stringify({
        schemaVersion: 1,
        installed: [],
      }))
      await writeFile(join(operationPath, 'journal.json'), JSON.stringify({
        schemaVersion: 1,
        operationId,
        action: 'uninstall',
        slug: 'install-test',
        targetPath,
        transactionBackupPath: join(operationPath, 'backup'),
        ledgerPath: join(root, 'creator-skills.json'),
        oldLedger,
        state: 'detaching',
      }))

      await recoverCreatorSkillOperations(root)

      expect(await readFile(join(targetPath, 'SKILL.md'), 'utf8'))
        .toBe('restored detached content')
      expect((await readCreatorSkillsLedger(root)).installed[0])
        .toMatchObject({ artifactId: 'artifact-old', version: '1.0.0' })
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

  it('keeps an update rollback private from concurrent backup deletion until committed is durable', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      const next = await packageGrant(root, '2.0.0')
      let failCommittedSync = false
      let deletedDuringWindow = -1
      const result = await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '35353535-3535-4535-8535-353535353535',
        grant: next.grant,
        replaceExisting: true,
      }, {
        fetch: responseFetch(next.bytes),
        onJournalPersisted: async state => {
          if (state !== 'ledger_committed') return
          deletedDuringWindow = await deleteCreatorSkillBackups(root)
          failCommittedSync = true
        },
        syncJournalDirectory: async () => {
          if (!failCommittedSync) return
          failCommittedSync = false
          throw Object.assign(new Error('committed journal fsync failed'), {
            code: 'EIO',
          })
        },
      })

      expect(deletedDuringWindow).toBe(0)
      expect(result.success).toBe(false)
      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('1.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
      expect(await listCreatorSkillBackups(root)).toHaveLength(0)
    })
  })

  it('keeps a clean-uninstall rollback private until committed is durable', async () => {
    await withWorkspace(async root => {
      const first = await packageGrant(root, '1.0.0')
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: OP_BASE,
        grant: first.grant,
      }, { fetch: responseFetch(first.bytes) })).success).toBe(true)

      let failCommittedSync = false
      let deletedDuringWindow = -1
      const result = await uninstallCreatorSkill({
        workspaceRoot: root,
        workspaceId: 'workspace-1',
        operationId: '36363636-3636-4636-8636-363636363636',
        slug: 'install-test',
      }, {
        onJournalPersisted: async state => {
          if (state !== 'ledger_committed') return
          deletedDuringWindow = await deleteCreatorSkillBackups(root)
          failCommittedSync = true
        },
        syncJournalDirectory: async () => {
          if (!failCommittedSync) return
          failCommittedSync = false
          throw Object.assign(new Error('committed journal fsync failed'), {
            code: 'EIO',
          })
        },
      })

      expect(deletedDuringWindow).toBe(0)
      expect(result.success).toBe(false)
      expect(await readFile(
        join(root, 'skills', 'install-test', 'SKILL.md'),
        'utf8',
      )).toBe(skillContent('1.0.0'))
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('1.0.0')
      expect(await listCreatorSkillBackups(root)).toHaveLength(0)
    })
  })

  it('publishes the transaction backup only after committed is durable', async () => {
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
          const journal = JSON.parse(await readFile(join(
            root,
            '.creator-skill-ops',
            OP_FAULT_COMMITTED,
            'journal.json',
          ), 'utf8'))
          expect(await access(join(
            root,
            '.creator-skill-ops',
            OP_FAULT_COMMITTED,
            'backup',
          )).then(
            () => true,
            () => false,
          )).toBe(true)
          expect(await access(journal.preserveBackupPath).then(
            () => true,
            () => false,
          )).toBe(false)
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
      expect(await listCreatorSkillBackups(root)).toEqual([
        expect.objectContaining({
          slug: 'install-test',
          operation: 'update_safety_snapshot',
          version: '1.0.0',
        }),
      ])
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
      const persistedJournal = JSON.parse(await readFile(
        join(operationPath, 'journal.json'),
        'utf8',
      ))
      expect(await access(persistedJournal.preserveBackupPath).then(
        () => true,
        () => false,
      )).toBe(false)
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version).toBe('2.0.0')

      const other = await packageGrant(root, '1.0.0', {
        slug: 'other-skill',
        artifactId: 'artifact-other',
      })
      expect((await installCreatorSkill(root, {
        workspaceId: 'workspace-1',
        operationId: '37373737-3737-4737-8737-373737373737',
        grant: other.grant,
      }, { fetch: responseFetch(other.bytes) })).success).toBe(true)

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
      expect((await readCreatorSkillsLedger(root)).installed).toEqual([
        expect.objectContaining({
          slug: 'install-test',
          version: '1.0.0',
        }),
        expect.objectContaining({
          slug: 'other-skill',
          version: '1.0.0',
        }),
      ])
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
