export declare const CREATOR_SKILL_NAME_PATTERN: RegExp;
export declare const CREATOR_SKILL_NAME_MAX_LENGTH = 64;
export declare const CREATOR_SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export declare const CREATOR_SKILL_MAX_METADATA_ITEMS = 1000;
export declare const CREATOR_SKILL_ICON_MAX_LENGTH = 64;
export declare const CREATOR_SKILL_GLOB_MAX_LENGTH = 2048;
export declare const CREATOR_SKILL_PERMISSION_MAX_LENGTH = 512;
export declare const CANONICAL_SKILL_FILE_MESSAGE = "Exactly one SKILL.md basename is allowed and it must be at the package root";
export declare const EMPTY_SKILL_CONTENT_MESSAGE = "Skill content is empty (nothing after frontmatter)";
export declare const EMPTY_SKILL_CONTENT_SUGGESTION = "Add instructions after the frontmatter describing what the skill should do";
export declare const CREATOR_SKILL_ROOT_ERROR_MESSAGE = "ZIP must contain exactly one root directory matching the Creator Skill slug";
export declare const INVALID_YAML_FRONTMATTER_MESSAGE = "SKILL.md frontmatter must contain valid YAML metadata";
export interface NormalizedSkillZipEntry {
    path: string;
    directory?: boolean;
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
    code: 'skill_file_count' | 'invalid_skill_root' | 'missing_skill_content' | 'invalid_skill_utf8' | 'invalid_skill_content';
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
export declare function isCreatorSkillPackagingNoise(path: string): boolean;
/** Resolves the one ZIP root used by both browser and archive validation. */
export declare function resolveCreatorSkillRoot(entries: readonly Pick<NormalizedSkillZipEntry, 'path' | 'directory'>[], expectedRootDirectory?: string): string;
export declare function isCreatorSkillEmojiIcon(value: string): boolean;
/**
 * The sole production Creator Skill metadata constraint. Structured consumers
 * may omit rootDirectory; SKILL.md parsing supplies it to enforce ZIP identity.
 */
export declare function validateCreatorSkillMetadata(value: unknown, path: string, rootDirectory?: string): CreatorSkillMetadata;
/** Browser-safe YAML and metadata core shared by ZIP and server validation paths. */
export declare function parseCreatorSkillDocument(content: string, rootDirectory: string, path?: string): {
    metadata: CreatorSkillMetadata;
    body: string;
};
export declare function parseCreatorSkillMetadata(entries: readonly NormalizedSkillZipEntry[], expectedRootDirectory?: string): ParsedCreatorSkillMetadata;
