import { describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readCreatorSkillsLedger,
  writeCreatorSkillsLedger,
  type CreatorSkillsLedgerWriteStep,
} from '../ledger'
import type { CreatorSkillsLedger } from '../types'

function ledger(version: string): CreatorSkillsLedger {
  return {
    schemaVersion: 1,
    installed: [{
      artifactId: 'artifact-one',
      organizationId: 'organization-one',
      slug: 'durable-skill',
      version,
      archiveChecksum: 'a'.repeat(64),
      contentDigest: 'b'.repeat(64),
      installedAt: '2026-07-30T00:00:00.000Z',
    }],
  }
}

async function withWorkspace(
  run: (workspaceRoot: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'creator-skill-ledger-test-'))
  try {
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('Creator Skills Ledger durability', () => {
  it('fsyncs the temporary file and parent directory around the atomic rename', async () => {
    await withWorkspace(async root => {
      const steps: CreatorSkillsLedgerWriteStep[] = []
      const syncedDirectories: string[] = []
      await writeCreatorSkillsLedger(root, ledger('1.0.0'), {
        syncDirectory: async directory => {
          syncedDirectories.push(directory)
        },
        onStep: step => {
          steps.push(step)
        },
      })

      expect(steps).toEqual([
        'temporary_file_synced',
        'ledger_renamed',
        'directory_synced',
      ])
      expect(syncedDirectories).toEqual([root])
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version)
        .toBe('1.0.0')
      expect((await readdir(root)).filter(name => name.endsWith('.tmp')))
        .toEqual([])
    })
  })

  it('preserves the previous Ledger when temporary-file fsync is interrupted', async () => {
    await withWorkspace(async root => {
      await writeCreatorSkillsLedger(root, ledger('1.0.0'))
      await expect(writeCreatorSkillsLedger(root, ledger('2.0.0'), {
        onStep: step => {
          if (step === 'temporary_file_synced') throw new Error('file fsync fault')
        },
      })).rejects.toThrow('file fsync fault')

      expect((await readCreatorSkillsLedger(root)).installed[0]?.version)
        .toBe('1.0.0')
      expect((await readdir(root)).filter(name => name.endsWith('.tmp')))
        .toEqual([])
    })
  })

  it('does not report success when the post-rename checkpoint fails', async () => {
    await withWorkspace(async root => {
      await writeCreatorSkillsLedger(root, ledger('1.0.0'))
      await expect(writeCreatorSkillsLedger(root, ledger('2.0.0'), {
        onStep: step => {
          if (step === 'ledger_renamed') throw new Error('rename checkpoint fault')
        },
      })).rejects.toThrow('rename checkpoint fault')
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version)
        .toBe('2.0.0')
    })
  })

  it('does not report success when the Ledger parent directory fsync fails', async () => {
    await withWorkspace(async root => {
      await writeCreatorSkillsLedger(root, ledger('1.0.0'))
      await expect(writeCreatorSkillsLedger(root, ledger('2.0.0'), {
        syncDirectory: async () => {
          throw Object.assign(new Error('directory fsync fault'), { code: 'EIO' })
        },
      })).rejects.toMatchObject({ code: 'EIO' })
      expect((await readCreatorSkillsLedger(root)).installed[0]?.version)
        .toBe('2.0.0')
    })
  })
})
