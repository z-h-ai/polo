import { type CreatorSkillManifestEntry, type SkillArchivePolicy, type SkillValidationIssue, type SkillVersionMetadata } from './types.ts';
export interface CreatorSkillArchiveValidation {
    archiveChecksum: string;
    contentDigest: string;
    manifest: CreatorSkillManifestEntry[];
    metadata: SkillVersionMetadata;
    warnings: SkillValidationIssue[];
    expandedBytes: number;
}
export declare class CreatorSkillArchiveError extends Error {
    readonly code: 'invalid_skill_archive' | 'skill_validation_failed' | 'archive_policy_exceeded' | 'checksum_mismatch' | 'content_digest_mismatch';
    readonly issues: SkillValidationIssue[];
    constructor(code: CreatorSkillArchiveError['code'], message: string, issues?: SkillValidationIssue[]);
}
export declare function canonicalManifestJson(manifest: CreatorSkillManifestEntry[]): string;
export declare function calculateContentDigest(manifest: CreatorSkillManifestEntry[]): string;
/**
 * Fast renderer/server-core preflight. It reads the ZIP directory only, so it
 * can reject obvious size, path, entry-type, root, and structure problems
 * before upload without pretending to replace the Admin service validation.
 */
export declare function preflightCreatorSkillArchive(args: {
    archivePath: string;
    slug: string;
    policy?: SkillArchivePolicy;
}): Promise<{
    archiveChecksum: string;
    warnings: SkillValidationIssue[];
}>;
export declare function validateCreatorSkillArchive(args: {
    archivePath: string;
    slug: string;
    destinationRoot?: string;
    policy?: SkillArchivePolicy;
    expectedArchiveChecksum?: string;
    expectedContentDigest?: string;
    expectedManifest?: CreatorSkillManifestEntry[];
}): Promise<CreatorSkillArchiveValidation>;
export declare function scanCreatorSkillDirectory(skillDirectory: string): Promise<{
    manifest: CreatorSkillManifestEntry[];
    contentDigest: string;
}>;
export declare function directorySize(path: string): Promise<number>;
export declare function creatorSkillBackupTimestamp(date?: Date): string;
export declare function inferBackupCreatedAt(path: string): string;
export declare function hasArchiveLikeExtension(path: string): boolean;
