import matter from 'gray-matter'
import {
  CreatorSkillMetadataSchema,
  type ValidatedSkillMetadata,
} from './skill-content.ts'

export interface NormalizedSkillZipEntry {
  /** POSIX, normalized ZIP path (for example `polo-test/SKILL.md`). */
  path: string
  /** Omit for files when the ZIP reader does not expose explicit directory entries. */
  directory?: boolean
  /** Required only for the root SKILL.md entry. */
  content?: string | Uint8Array
}

export interface CreatorSkillMetadataIssue {
  code:
    | 'missing_skill_file'
    | 'multiple_skill_files'
    | 'skill_file_not_root'
    | 'multiple_root_directories'
    | 'missing_skill_content'
    | 'invalid_skill_utf8'
    | 'invalid_skill_metadata'
  path: string
  field?: string
  message: string
  suggestion?: string
}

export class CreatorSkillMetadataError extends Error {
  readonly issues: CreatorSkillMetadataIssue[]

  constructor(message: string, issues: CreatorSkillMetadataIssue[]) {
    super(message)
    this.name = 'CreatorSkillMetadataError'
    this.issues = issues
  }
}

export interface ParsedCreatorSkillMetadata {
  slug: string
  metadata: ValidatedSkillMetadata
  body: string
}

function metadataIssue(
  code: CreatorSkillMetadataIssue['code'],
  path: string,
  message: string,
  field?: string,
  suggestion?: string,
): CreatorSkillMetadataIssue {
  return { code, path, ...(field ? { field } : {}), message, ...(suggestion ? { suggestion } : {}) }
}

function readContent(entry: NormalizedSkillZipEntry): string {
  if (typeof entry.content === 'string') return entry.content
  if (!entry.content) {
    throw new CreatorSkillMetadataError('SKILL.md content is missing', [
      metadataIssue('missing_skill_content', entry.path, 'Provide the UTF-8 contents of the root SKILL.md entry'),
    ])
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(entry.content)
  } catch {
    throw new CreatorSkillMetadataError('SKILL.md must be UTF-8', [
      metadataIssue('invalid_skill_utf8', entry.path, 'SKILL.md must contain valid UTF-8 text'),
    ])
  }
}

/**
 * Browser-safe parser for ZIP readers that have already normalized their
 * entries. It intentionally has no Node imports: callers supply entry paths
 * and the root SKILL.md bytes, then receive the canonical Creator Skill slug.
 */
export function parseCreatorSkillMetadata(
  entries: readonly NormalizedSkillZipEntry[],
): ParsedCreatorSkillMetadata {
  const businessEntries = entries.filter(entry => entry.path.length > 0)
  const roots = new Set(businessEntries.map(entry => entry.path.replace(/\/$/, '').split('/')[0]).filter(Boolean))
  if (roots.size !== 1) {
    throw new CreatorSkillMetadataError('ZIP must contain exactly one root directory', [
      metadataIssue('multiple_root_directories', '', 'ZIP must contain exactly one root directory'),
    ])
  }

  const skillEntries = businessEntries.filter(entry => (
    !entry.directory && entry.path.split('/').at(-1)?.toLocaleLowerCase('en-US') === 'skill.md'
  ))
  if (skillEntries.length === 0) {
    throw new CreatorSkillMetadataError('ZIP is missing SKILL.md', [
      metadataIssue('missing_skill_file', 'SKILL.md', 'Add one root-level SKILL.md file'),
    ])
  }
  if (skillEntries.length !== 1) {
    throw new CreatorSkillMetadataError('ZIP contains multiple SKILL.md files', [
      metadataIssue('multiple_skill_files', 'SKILL.md', 'Keep exactly one root-level SKILL.md file'),
    ])
  }

  const skillEntry = skillEntries[0]!
  const rootDirectory = skillEntry.path.split('/')[0]!
  if (skillEntry.path !== `${rootDirectory}/SKILL.md`) {
    throw new CreatorSkillMetadataError('SKILL.md must be at the ZIP root', [
      metadataIssue('skill_file_not_root', skillEntry.path, 'Place SKILL.md directly under the Skill root directory'),
    ])
  }
  if (!roots.has(rootDirectory)) {
    throw new CreatorSkillMetadataError('SKILL.md root does not match ZIP root', [
      metadataIssue('skill_file_not_root', skillEntry.path, 'Place SKILL.md under the only ZIP root directory'),
    ])
  }

  const content = readContent(skillEntry)
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(content)
  } catch (error) {
    throw new CreatorSkillMetadataError('SKILL.md frontmatter is invalid', [
      metadataIssue('invalid_skill_metadata', skillEntry.path, `Invalid YAML frontmatter: ${error instanceof Error ? error.message : 'Unknown error'}`, 'frontmatter'),
    ])
  }
  const validation = CreatorSkillMetadataSchema.safeParse(parsed.data)
  if (!validation.success) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', validation.error.issues.map(issue => metadataIssue(
      'invalid_skill_metadata',
      skillEntry.path,
      issue.message,
      issue.path.join('.') || 'frontmatter',
    )))
  }
  const metadata = validation.data
  const issues: CreatorSkillMetadataIssue[] = []
  if (metadata.name !== rootDirectory) {
    issues.push(metadataIssue(
      'invalid_skill_metadata',
      skillEntry.path,
      `Creator Skill name '${metadata.name}' must match root directory '${rootDirectory}'`,
      'name',
      `Use 'name: ${rootDirectory}' or rename the root directory`,
    ))
  }
  if (issues.length > 0) throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', issues)

  return {
    slug: metadata.name,
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
