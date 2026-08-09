import { z } from 'zod';
export interface SkillContentValidationIssue {
    code?: string;
    file: string;
    path: string;
    message: string;
    severity: 'error' | 'warning';
    suggestion?: string;
}
export interface SkillContentValidationResult {
    valid: boolean;
    errors: SkillContentValidationIssue[];
    warnings: SkillContentValidationIssue[];
}
export interface ValidatedSkillMetadata {
    name: string;
    description: string;
    globs?: string[];
    alwaysAllow?: string[];
    icon?: string;
    requiredSources?: string[];
}
/**
 * Portable Creator/local Skill metadata contract. This module intentionally
 * has no config, filesystem, Node, or Electron imports so the Admin validator
 * and desktop installer can return the same field errors.
 */
export declare const PortableSkillMetadataSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodString;
    globs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    alwaysAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
    icon: z.ZodOptional<z.ZodString>;
    requiredSources: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$loose>;
/**
 * The published Creator Skill contract deliberately treats `name` as the
 * stable package identifier, rather than a display label. Local skills keep
 * using PortableSkillMetadataSchema for backwards compatibility.
 */
export declare const CreatorSkillMetadataSchema: z.ZodObject<{
    globs: z.ZodOptional<z.ZodArray<z.ZodString>>;
    alwaysAllow: z.ZodOptional<z.ZodArray<z.ZodString>>;
    icon: z.ZodOptional<z.ZodString>;
    requiredSources: z.ZodOptional<z.ZodArray<z.ZodString>>;
    name: z.ZodString;
    description: z.ZodString;
}, z.core.$loose>;
export declare function isValidSkillSlug(slug: string): boolean;
export declare function isValidCreatorSkillSlug(slug: string): boolean;
export declare function suggestSkillSlug(slug: string): string;
export declare function validatePortableSkillContent(markdownContent: string, slug: string): SkillContentValidationResult;
export declare function validateCreatorSkillContent(markdownContent: string, slug: string): SkillContentValidationResult;
export declare function readValidatedSkillMetadata(markdownContent: string, slug: string): {
    metadata: ValidatedSkillMetadata;
    body: string;
} | null;
