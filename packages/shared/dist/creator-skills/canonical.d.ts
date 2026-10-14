import { type CreatorSkillInstallerDependencies } from './installer.ts';
import { type CanonicalSkillSource, type CreatorSkillOperationResult, type CanonicalInstalledSkill } from './types.ts';
export declare const CANONICAL_SKILLS_DIRECTORY = ".polo/canonical-skills";
export declare function canonicalSkillIdentity(source: CanonicalSkillSource): string;
export declare function canonicalSkillRoot(workspaceRoot: string, source: CanonicalSkillSource): string;
/** Every ancestor must be an actual local directory, never a symlink. */
export declare function ensureCanonicalSkillRoot(workspaceRoot: string, source: CanonicalSkillSource): Promise<string>;
export interface CanonicalSkillNativeInput {
    workspaceId: string;
    operationId: string;
    source: CanonicalSkillSource;
    version: string;
    checksum: string;
    sizeBytes: number;
    downloadUrl: string;
    expiresAt: string;
    replaceExisting?: boolean;
    backupLocalChanges?: boolean;
}
/** Canonical grant is fetched in Main. Metadata is derived only from its verified ZIP. */
export declare function installCanonicalSkill(workspaceRoot: string, input: CanonicalSkillNativeInput, dependencies?: CreatorSkillInstallerDependencies & {
    signal?: AbortSignal;
    onValidated?: (root: string, slug: string) => Promise<{
        nativeInstallationAdmissionId?: string;
        onNativeCommitted?: CreatorSkillInstallerDependencies['onNativeCommitted'];
    }>;
}): Promise<CreatorSkillOperationResult>;
/** Reserved canonical native roots only; no symlink traversal or external cleanup. */
export declare function listCanonicalSkillRoots(workspaceRoot: string): Promise<string[]>;
export declare function recoverCanonicalSkillOperations(workspaceRoot: string): Promise<void>;
export interface CanonicalSkillInstallation {
    workspaceRoot: string;
    root: string;
    path: string;
    installation: CanonicalInstalledSkill;
}
export declare function readCanonicalSkillInstallations(workspaceRoot: string, scope: {
    accountId: string;
    productSpaceId: string;
}, options?: {
    nativeMutationFacts?: boolean;
}): Promise<CanonicalSkillInstallation[]>;
