import matter from 'gray-matter'
import { z } from 'zod'
import {
  CREATOR_SKILL_DESCRIPTION_MAX_LENGTH,
  CREATOR_SKILL_NAME_MAX_LENGTH,
  CREATOR_SKILL_NAME_PATTERN,
  CreatorSkillMetadataError,
  parseCreatorSkillDocument,
} from './metadata.ts'

export interface SkillContentValidationIssue {
  code?: string
  file: string
  path: string
  message: string
  severity: 'error' | 'warning'
  suggestion?: string
}

export interface SkillContentValidationResult {
  valid: boolean
  errors: SkillContentValidationIssue[]
  warnings: SkillContentValidationIssue[]
}

export interface ValidatedSkillMetadata {
  name: string
  description: string
  globs?: string[]
  alwaysAllow?: string[]
  icon?: string
  requiredSources?: string[]
}

/**
 * Portable Creator/local Skill metadata contract. This module intentionally
 * has no config, filesystem, Node, or Electron imports so the Admin validator
 * and desktop installer can return the same field errors.
 */
export const PortableSkillMetadataSchema = z.object({
  name: z.string().trim().min(
    1,
    "Add a 'name' field with a human-readable title (e.g., 'Git Commit Helper')",
  ),
  description: z.string().trim().min(
    1,
    "Add a 'description' field explaining what this skill does and when to use it (1-2 sentences)",
  ),
  globs: z.array(z.string()).optional(),
  alwaysAllow: z.array(z.string()).optional(),
  icon: z.string().trim().min(1).optional(),
  requiredSources: z.array(z.string()).optional(),
}).passthrough()

/**
 * The published Creator Skill contract deliberately treats `name` as the
 * stable package identifier, rather than a display label. Local skills keep
 * using PortableSkillMetadataSchema for backwards compatibility.
 */
export const CreatorSkillMetadataSchema = PortableSkillMetadataSchema.extend({
  name: z.string().trim().min(1).max(CREATOR_SKILL_NAME_MAX_LENGTH).regex(
    CREATOR_SKILL_NAME_PATTERN,
    'Creator Skill name must use strict kebab-case (for example, polo-test)',
  ),
  description: z.string().trim().min(1).max(
    CREATOR_SKILL_DESCRIPTION_MAX_LENGTH,
    'Creator Skill description must be at most 1024 characters',
  ),
}).passthrough()

export function isValidSkillSlug(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug)
}

export function isValidCreatorSkillSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
}

export function suggestSkillSlug(slug: string): string {
  return slug
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-') || 'valid-slug-name'
}

function zodIssues(
  error: z.ZodError,
  file: string,
): SkillContentValidationIssue[] {
  return error.issues.map(issue => ({
    file,
    path: issue.path.join('.') || 'frontmatter',
    message: issue.message,
    severity: 'error' as const,
  }))
}

export function validatePortableSkillContent(
  markdownContent: string,
  slug: string,
): SkillContentValidationResult {
  const file = `skills/${slug}/SKILL.md`
  const errors: SkillContentValidationIssue[] = []

  if (!isValidSkillSlug(slug)) {
    errors.push({
      file: `skills/${slug}`,
      path: 'slug',
      message: 'Slug must be lowercase alphanumeric with hyphens',
      severity: 'error',
      suggestion: `Rename folder to '${suggestSkillSlug(slug)}'`,
    })
  }

  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(markdownContent)
  } catch (error) {
    return {
      valid: false,
      errors: [{
        file,
        path: 'frontmatter',
        message: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : 'Unknown error'}`,
        severity: 'error',
        suggestion: 'See ~/.polo-ai/docs/skills.md for SKILL.md format reference',
      }],
      warnings: [],
    }
  }

  const metadata = PortableSkillMetadataSchema.safeParse(parsed.data)
  if (!metadata.success) {
    errors.push(...zodIssues(metadata.error, file))
  }

  if (!parsed.content || parsed.content.trim().length === 0) {
    errors.push({
      file,
      path: 'content',
      message: 'Skill content is empty (nothing after frontmatter)',
      severity: 'error',
      suggestion: 'Add instructions after the frontmatter describing what the skill should do',
    })
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
  }
}

export function validateCreatorSkillContent(
  markdownContent: string,
  slug: string,
): SkillContentValidationResult {
  const errors: SkillContentValidationIssue[] = []
  if (!isValidCreatorSkillSlug(slug)) {
    errors.push({
      file: `skills/${slug}`,
      path: 'slug',
      message: 'Creator Skill slug must use strict kebab-case',
      severity: 'error',
      suggestion: `Rename folder to '${suggestSkillSlug(slug)}'`,
    })
  }

  try {
    parseCreatorSkillDocument(markdownContent, slug, `skills/${slug}/SKILL.md`)
  } catch (error) {
    if (error instanceof CreatorSkillMetadataError) {
      errors.push(...error.issues.map(issue => ({
        code: issue.code,
        file: `skills/${slug}/SKILL.md`,
        path: issue.field ?? 'frontmatter',
        message: issue.message,
        severity: 'error' as const,
        ...(issue.suggestion ? { suggestion: issue.suggestion } : {}),
      })))
    } else {
      throw error
    }
  }

  if (errors.length === 0) return { valid: true, errors: [], warnings: [] }
  return {
    valid: false,
    errors,
    warnings: [],
  }
}

export function readValidatedSkillMetadata(
  markdownContent: string,
  slug: string,
): { metadata: ValidatedSkillMetadata; body: string } | null {
  const validation = validatePortableSkillContent(markdownContent, slug)
  if (!validation.valid) return null
  const parsed = matter(markdownContent)
  const metadata = PortableSkillMetadataSchema.parse(parsed.data)
  return {
    metadata: {
      name: metadata.name,
      description: metadata.description,
      ...(metadata.globs ? { globs: metadata.globs } : {}),
      ...(metadata.alwaysAllow ? { alwaysAllow: metadata.alwaysAllow } : {}),
      ...(metadata.icon ? { icon: metadata.icon } : {}),
      ...(metadata.requiredSources ? { requiredSources: metadata.requiredSources } : {}),
    },
    body: parsed.content,
  }
}
