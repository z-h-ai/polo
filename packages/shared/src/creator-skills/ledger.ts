import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type CreatorSkillsLedger,
  type InstalledCreatorSkill,
} from './types'
import { InstalledCreatorSkillSchema } from './schemas'

export const CREATOR_SKILLS_LEDGER_FILE = 'creator-skills.json'

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
): Promise<void> {
  const ledgerPath = join(workspaceRoot, CREATOR_SKILLS_LEDGER_FILE)
  await mkdir(dirname(ledgerPath), { recursive: true })
  const tempPath = `${ledgerPath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const normalized: CreatorSkillsLedger = {
    schemaVersion: 1,
    installed: [...ledger.installed].sort((left, right) => left.slug.localeCompare(right.slug)),
  }
  await writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  try {
    await rename(tempPath, ledgerPath)
  } catch (error) {
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
