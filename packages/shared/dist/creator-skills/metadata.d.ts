export declare const CREATOR_SKILL_NAME_PATTERN: RegExp;
export declare const CREATOR_SKILL_NAME_MAX_LENGTH = 64;
export declare const CREATOR_SKILL_DESCRIPTION_MAX_LENGTH = 1024;
export declare const CANONICAL_SKILL_FILE_MESSAGE = "Exactly one SKILL.md basename is allowed and it must be at the package root";
export declare const EMPTY_SKILL_CONTENT_MESSAGE = "Skill content is empty (nothing after frontmatter)";
export declare const EMPTY_SKILL_CONTENT_SUGGESTION = "Add instructions after the frontmatter describing what the skill should do";
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
    code: 'skill_file_count' | 'multiple_root_directories' | 'missing_skill_content' | 'invalid_skill_utf8' | 'invalid_skill_content';
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
/** Browser-safe YAML and metadata core shared by ZIP and server validation paths. */
export declare function parseCreatorSkillDocument(content: string, rootDirectory: string, path?: string): {
    metadata: CreatorSkillMetadata;
    body: string;
};
export declare function parseCreatorSkillMetadata(entries: readonly NormalizedSkillZipEntry[]): ParsedCreatorSkillMetadata;
