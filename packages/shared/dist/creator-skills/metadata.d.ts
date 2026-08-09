export interface NormalizedSkillZipEntry {
    /** POSIX, normalized ZIP path (for example `polo-test/SKILL.md`). */
    path: string;
    /** Omit for files when the ZIP reader does not expose explicit directory entries. */
    directory?: boolean;
    /** Required only for the root SKILL.md entry. */
    content?: string | Uint8Array;
}
export interface CreatorSkillMetadata {
    name: string;
    description: string;
    globs?: string[];
    alwaysAllow?: string[];
    icon?: string;
    requiredSources?: string[];
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
    metadata: CreatorSkillMetadata;
    body: string;
}
/** Shared packaging-noise policy for ZIP directory inspection and browser metadata parsing. */
export declare function isCreatorSkillPackagingNoise(path: string): boolean;
/**
 * Browser-safe parser for normalized ZIP entries. No runtime polyfills or
 * Node globals are required; callers provide the root SKILL.md bytes.
 */
export declare function parseCreatorSkillMetadata(entries: readonly NormalizedSkillZipEntry[]): ParsedCreatorSkillMetadata;
