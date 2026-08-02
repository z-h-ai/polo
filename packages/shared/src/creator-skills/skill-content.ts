import matter from 'gray-matter'
import { z } from 'zod'

export interface SkillContentValidationIssue {
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
  const validation = validatePortableSkillContent(markdownContent, slug)
  if (isValidCreatorSkillSlug(slug)) return validation
  return {
    valid: false,
    errors: [
      ...validation.errors.filter(error => error.path !== 'slug'),
      {
        file: `skills/${slug}`,
        path: 'slug',
        message: 'Creator Skill slug must use strict kebab-case',
        severity: 'error',
        suggestion: `Rename folder to '${suggestSkillSlug(slug)}'`,
      },
    ],
    warnings: validation.warnings,
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
