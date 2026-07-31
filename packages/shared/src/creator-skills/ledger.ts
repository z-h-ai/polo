import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type CreatorSkillsLedger,
  type InstalledCreatorSkill,
} from './types.ts'
import { InstalledCreatorSkillSchema } from './schemas.ts'

export const CREATOR_SKILLS_LEDGER_FILE = 'creator-skills.json'

export type CreatorSkillsLedgerWriteStep =
  | 'temporary_file_synced'
  | 'ledger_renamed'
  | 'directory_synced'

export interface CreatorSkillsLedgerWriteDependencies {
  syncDirectory?: (directoryPath: string) => Promise<void>
  onStep?: (step: CreatorSkillsLedgerWriteStep) => Promise<void> | void
}

export function emptyCreatorSkillsLedger(): CreatorSkillsLedger {
  return { schemaVersion: 1, installed: [] }
}

function isInstalledCreatorSkill(value: unknown): value is InstalledCreatorSkill {
  return InstalledCreatorSkillSchema.safeParse(value).success
}

export function parseCreatorSkillsLedger(raw: unknown): CreatorSkillsLedger {
  if (!raw || typeof raw !== 'object') return emptyCreatorSkillsLedger()
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== 1 || !Array.isArray(record.installed)) {
    return emptyCreatorSkillsLedger()
  }
  const bySlug = new Map<string, InstalledCreatorSkill>()
  for (const item of record.installed) {
    if (isInstalledCreatorSkill(item)) {
      bySlug.set(item.slug, InstalledCreatorSkillSchema.parse(item))
    }
  }
  return {
    schemaVersion: 1,
    installed: [...bySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug)),
  }
}

export async function readCreatorSkillsLedger(
  workspaceRoot: string,
): Promise<CreatorSkillsLedger> {
  try {
    return parseCreatorSkillsLedger(JSON.parse(
      await readFile(join(workspaceRoot, CREATOR_SKILLS_LEDGER_FILE), 'utf8'),
    ) as unknown)
  } catch {
    return emptyCreatorSkillsLedger()
  }
}

export async function writeCreatorSkillsLedger(
  workspaceRoot: string,
  ledger: CreatorSkillsLedger,
  dependencies: CreatorSkillsLedgerWriteDependencies = {},
): Promise<void> {
  const ledgerPath = join(workspaceRoot, CREATOR_SKILLS_LEDGER_FILE)
  const ledgerDirectory = dirname(ledgerPath)
  await mkdir(ledgerDirectory, { recursive: true })
  const tempPath = `${ledgerPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const normalized: CreatorSkillsLedger = {
    schemaVersion: 1,
    installed: [...ledger.installed].sort((left, right) => left.slug.localeCompare(right.slug)),
  }
  let handle
  try {
    handle = await open(tempPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await handle.sync()
    await dependencies.onStep?.('temporary_file_synced')
    await handle.close()
    handle = undefined
    await rename(tempPath, ledgerPath)
    await dependencies.onStep?.('ledger_renamed')
    if (dependencies.syncDirectory) {
      await dependencies.syncDirectory(ledgerDirectory)
    } else {
      const directoryHandle = await open(ledgerDirectory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    }
    await dependencies.onStep?.('directory_synced')
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(tempPath, { force: true })
    throw error
  }
}

export function replaceLedgerInstallation(
  ledger: CreatorSkillsLedger,
  installation: InstalledCreatorSkill,
): CreatorSkillsLedger {
  return {
    schemaVersion: 1,
    installed: [
      ...ledger.installed.filter(item => item.slug !== installation.slug),
      installation,
    ],
  }
}

export function removeLedgerInstallation(
  ledger: CreatorSkillsLedger,
  slug: string,
): CreatorSkillsLedger {
  return {
    schemaVersion: 1,
    installed: ledger.installed.filter(item => item.slug !== slug),
  }
}
