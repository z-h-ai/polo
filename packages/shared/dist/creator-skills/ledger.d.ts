import { type CreatorSkillsLedger, type InstalledCreatorSkill } from './types.ts';
export declare const CREATOR_SKILLS_LEDGER_FILE = "creator-skills.json";
export type CreatorSkillsLedgerWriteStep = 'temporary_file_synced' | 'ledger_renamed' | 'directory_synced';
export interface CreatorSkillsLedgerWriteDependencies {
    syncDirectory?: (directoryPath: string) => Promise<void>;
    onStep?: (step: CreatorSkillsLedgerWriteStep) => Promise<void> | void;
}
export declare function emptyCreatorSkillsLedger(): CreatorSkillsLedger;
export declare function parseCreatorSkillsLedger(raw: unknown): CreatorSkillsLedger;
export declare function readCreatorSkillsLedger(workspaceRoot: string): Promise<CreatorSkillsLedger>;
export declare function writeCreatorSkillsLedger(workspaceRoot: string, ledger: CreatorSkillsLedger, dependencies?: CreatorSkillsLedgerWriteDependencies): Promise<void>;
export declare function replaceLedgerInstallation(ledger: CreatorSkillsLedger, installation: InstalledCreatorSkill): CreatorSkillsLedger;
export declare function removeLedgerInstallation(ledger: CreatorSkillsLedger, slug: string): CreatorSkillsLedger;
