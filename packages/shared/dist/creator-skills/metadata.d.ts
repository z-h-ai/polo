import { type ValidatedSkillMetadata } from './skill-content.ts';
export interface NormalizedSkillZipEntry {
    /** POSIX, normalized ZIP path (for example `polo-test/SKILL.md`). */
    path: string;
    /** Omit for files when the ZIP reader does not expose explicit directory entries. */
    directory?: boolean;
    /** Required only for the root SKILL.md entry. */
    content?: string | Uint8Array;
}
export interface CreatorSkillMetadataIssue {
    code: 'missing_skill_file' | 'multiple_skill_files' | 'skill_file_not_root' | 'multiple_root_directories' | 'missing_skill_content' | 'invalid_skill_utf8' | 'invalid_skill_metadata';
    path: string;
    field?: string;
    message: string;
    suggestion?: string;
}
export declare class CreatorSkillMetadataError extends Error {
    readonly issues: CreatorSkillMetadataIssue[];
    constructor(message: string, issues: CreatorSkillMetadataIssue[]);
}
export interface ParsedCreatorSkillMetadata {
    slug: string;
    metadata: ValidatedSkillMetadata;
    body: string;
}
/**
 * Browser-safe parser for ZIP readers that have already normalized their
 * entries. It intentionally has no Node imports: callers supply entry paths
 * and the root SKILL.md bytes, then receive the canonical Creator Skill slug.
 */
export declare function parseCreatorSkillMetadata(entries: readonly NormalizedSkillZipEntry[]): ParsedCreatorSkillMetadata;
