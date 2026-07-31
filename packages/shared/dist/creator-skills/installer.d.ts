import { type CreatorSkillsLedgerWriteDependencies } from './ledger.ts';
import { type CreatorSkillBackup, type CreatorSkillInstallInput, type CreatorSkillOperationProgress, type CreatorSkillOperationResult, type InstalledCreatorSkill } from './types.ts';
export type CreatorSkillJournalState = 'preparing' | 'prepared' | 'old_backed_up' | 'new_installed' | 'ledger_committed' | 'detaching' | 'committed';
export interface CreatorSkillInstallerDependencies {
    fetch?: typeof fetch;
    onProgress?: (progress: CreatorSkillOperationProgress) => void;
    assertCommitAllowed?: (input: {
        artifactId: string;
        version: string;
        archiveChecksum: string;
    }) => Promise<void>;
    /** Runs immediately before the final target identity snapshot in deterministic race tests. */
    beforeCommitSnapshot?: () => Promise<void> | void;
    /** Transaction checkpoint hook used by deterministic crash/fault tests. */
    onJournalPersisted?: (state: CreatorSkillJournalState) => Promise<void> | void;
    /** Overrides directory fsync for deterministic durability tests. */
    syncJournalDirectory?: (directoryPath: string) => Promise<void>;
    /** Transaction cleanup hook used by deterministic crash/fault tests. */
    onCleanupStep?: (step: 'transaction_backup_removed' | 'operation_removed') => Promise<void> | void;
    /** Runs while the workspace-wide Ledger mutation lock is held in deterministic tests. */
    onLedgerMutationLocked?: () => Promise<void> | void;
    /** Reports deterministic in-process Ledger lock contention in fault-injection tests. */
    onLedgerMutationLockContended?: () => Promise<void> | void;
    /** RPC-client ownership scope for cancellation. Defaults to the workspace id in direct calls. */
    operationOwnerId?: string;
    /** Ledger durability fault injection used by deterministic transaction tests. */
    ledgerWriteDependencies?: CreatorSkillsLedgerWriteDependencies;
    /** Receives raw filesystem/download errors for server-only diagnostics. */
    onError?: (error: unknown) => void;
}
export type CreatorSkillUninstallerDependencies = Pick<CreatorSkillInstallerDependencies, 'beforeCommitSnapshot' | 'onJournalPersisted' | 'syncJournalDirectory' | 'onCleanupStep' | 'onLedgerMutationLocked' | 'onLedgerMutationLockContended' | 'ledgerWriteDependencies' | 'onError'>;
export type CreatorSkillMetadataUpdateDependencies = Pick<CreatorSkillInstallerDependencies, 'onLedgerMutationLocked' | 'onLedgerMutationLockContended' | 'ledgerWriteDependencies'>;
export declare function hasPendingCreatorSkillForceDelete(workspaceRoot: string, slug: string): Promise<boolean>;
export declare function installCreatorSkill(workspaceRoot: string, input: CreatorSkillInstallInput, dependencies?: CreatorSkillInstallerDependencies): Promise<CreatorSkillOperationResult>;
export declare function cancelCreatorSkillOperation(workspaceRoot: string, ownerId: string, operationId: string): Promise<boolean>;
export declare function uninstallCreatorSkill(args: {
    workspaceRoot: string;
    workspaceId: string;
    operationId: string;
    slug: string;
    forceDeleteModified?: boolean;
    forceDeleteCredential?: string;
}, dependencies?: CreatorSkillUninstallerDependencies): Promise<CreatorSkillOperationResult>;
export declare function recoverCreatorSkillOperations(workspaceRoot: string): Promise<void>;
export declare function listCreatorSkillBackups(workspaceRoot: string): Promise<CreatorSkillBackup[]>;
export declare function deleteCreatorSkillBackups(workspaceRoot: string, backup?: {
    slug: string;
    backupId: string;
}): Promise<number>;
export declare function updateCreatorSkillInstallationMetadata(args: {
    workspaceRoot: string;
    artifactId: string;
    version: string;
    archiveChecksum: string;
    changes: Pick<InstalledCreatorSkill, 'lastKnownStatus' | 'lastCheckedAt' | 'ignoredVersion'>;
}, dependencies?: CreatorSkillMetadataUpdateDependencies): Promise<boolean>;
export declare function copyCreatorSkillBackupForTesting(source: string, workspaceRoot: string, slug: string): Promise<string>;
