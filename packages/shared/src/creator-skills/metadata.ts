import { parseDocument } from 'yaml'

export const CREATOR_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const CREATOR_SKILL_NAME_MAX_LENGTH = 64
export const CREATOR_SKILL_DESCRIPTION_MAX_LENGTH = 1_024
export const CANONICAL_SKILL_FILE_MESSAGE = 'Exactly one SKILL.md basename is allowed and it must be at the package root'
export const EMPTY_SKILL_CONTENT_MESSAGE = 'Skill content is empty (nothing after frontmatter)'
export const EMPTY_SKILL_CONTENT_SUGGESTION = 'Add instructions after the frontmatter describing what the skill should do'

export interface NormalizedSkillZipEntry {
  path: string
  directory?: boolean
  content?: string | Uint8Array
}

export interface CreatorSkillMetadata {
  name: string
  description: string
  globs?: string[]
  alwaysAllow?: string[]
  icon?: string
  requiredSources?: string[]
}

export interface CreatorSkillMetadataIssue {
  code:
    | 'skill_file_count'
    | 'multiple_root_directories'
    | 'missing_skill_content'
    | 'invalid_skill_utf8'
    | 'invalid_skill_content'
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
  metadata: CreatorSkillMetadata
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

export function isCreatorSkillPackagingNoise(path: string): boolean {
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === '__MACOSX') return true
  const name = parts.at(-1) ?? ''
  return name === '.DS_Store'
    || name === 'Thumbs.db'
    || name === 'desktop.ini'
    || name.startsWith('._')
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

function canonicalSkillFileIssue(rootDirectory: string): CreatorSkillMetadataError {
  return new CreatorSkillMetadataError('ZIP must contain exactly one canonical root SKILL.md', [
    metadataIssue('skill_file_count', `${rootDirectory}/SKILL.md`, CANONICAL_SKILL_FILE_MESSAGE),
  ])
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue('invalid_skill_content', path, 'SKILL.md frontmatter must be a YAML mapping', 'frontmatter'),
    ])
  }
  return value as Record<string, unknown>
}

function requiredString(data: Record<string, unknown>, field: 'name' | 'description', path: string): string {
  const value = data[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue('invalid_skill_content', path, `Creator Skill ${field} is required and must be a string`, field),
    ])
  }
  return value.trim()
}

function optionalString(data: Record<string, unknown>, field: 'icon', path: string): string | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue('invalid_skill_content', path, `Creator Skill ${field} must be a non-empty string`, field),
    ])
  }
  return value.trim()
}

function optionalStrings(
  data: Record<string, unknown>,
  field: 'globs' | 'alwaysAllow' | 'requiredSources',
  path: string,
): string[] | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue('invalid_skill_content', path, `Creator Skill ${field} must be an array of strings`, field),
    ])
  }
  return value
}

/** Browser-safe YAML and metadata core shared by ZIP and server validation paths. */
export function parseCreatorSkillDocument(
  content: string,
  rootDirectory: string,
  path = `${rootDirectory}/SKILL.md`,
): { metadata: CreatorSkillMetadata; body: string } {
  const source = content.replace(/^\uFEFF/, '')
  const opening = /^---[ \t]*(?:#.*)?(?:\r?\n|$)/.exec(source)
  if (!opening) {
    throw new CreatorSkillMetadataError('SKILL.md frontmatter is invalid', [
      metadataIssue('invalid_skill_content', path, 'SKILL.md must start with YAML frontmatter', 'frontmatter'),
    ])
  }
  const closingPattern = /^(?:---|\.\.\.)[ \t]*(?:#.*)?\r?$/gm
  closingPattern.lastIndex = opening[0].length
  const closing = closingPattern.exec(source)
  if (!closing) {
    throw new CreatorSkillMetadataError('SKILL.md frontmatter is invalid', [
      metadataIssue('invalid_skill_content', path, 'SKILL.md frontmatter must end with a closing delimiter', 'frontmatter'),
    ])
  }
  const document = parseDocument(source.slice(opening[0].length, closing.index), {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  })
  if (document.errors.length > 0) {
    throw new CreatorSkillMetadataError('SKILL.md frontmatter is invalid', [
      metadataIssue('invalid_skill_content', path, `Invalid YAML frontmatter: ${document.errors[0]!.message}`, 'frontmatter'),
    ])
  }
  const data = asRecord(document.toJS(), path)
  const body = source.slice(closing.index + closing[0].length).replace(/^\r?\n/, '')
  if (body.trim().length === 0) {
    throw new CreatorSkillMetadataError('SKILL.md content is empty', [
      metadataIssue('invalid_skill_content', path, EMPTY_SKILL_CONTENT_MESSAGE, 'content', EMPTY_SKILL_CONTENT_SUGGESTION),
    ])
  }

  const name = requiredString(data, 'name', path)
  const description = requiredString(data, 'description', path)
  const issues: CreatorSkillMetadataIssue[] = []
  const validName = name.length <= CREATOR_SKILL_NAME_MAX_LENGTH && CREATOR_SKILL_NAME_PATTERN.test(name)
  if (!validName) {
    issues.push(metadataIssue('invalid_skill_content', path, 'Creator Skill name must use strict kebab-case (for example, polo-test)', 'name'))
  }
  if (description.length > CREATOR_SKILL_DESCRIPTION_MAX_LENGTH) {
    issues.push(metadataIssue('invalid_skill_content', path, 'Creator Skill description must be at most 1024 characters', 'description'))
  }
  if (validName && name !== rootDirectory) {
    issues.push(metadataIssue('invalid_skill_content', path, `Creator Skill name '${name}' must match root directory '${rootDirectory}'`, 'name', `Use 'name: ${rootDirectory}' or rename the root directory`))
  }
  if (issues.length > 0) throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', issues)

  const globs = optionalStrings(data, 'globs', path)
  const alwaysAllow = optionalStrings(data, 'alwaysAllow', path)
  const icon = optionalString(data, 'icon', path)
  const requiredSources = optionalStrings(data, 'requiredSources', path)
  return {
    metadata: {
      name,
      description,
      ...(globs ? { globs } : {}),
      ...(alwaysAllow ? { alwaysAllow } : {}),
      ...(icon ? { icon } : {}),
      ...(requiredSources ? { requiredSources } : {}),
    },
    body,
  }
}

export function parseCreatorSkillMetadata(
  entries: readonly NormalizedSkillZipEntry[],
): ParsedCreatorSkillMetadata {
  const businessEntries = entries.filter(entry => entry.path.length > 0 && !isCreatorSkillPackagingNoise(entry.path))
  const roots = new Set(businessEntries.map(entry => entry.path.replace(/\/$/, '').split('/')[0]).filter(Boolean))
  if (roots.size !== 1) {
    throw new CreatorSkillMetadataError('ZIP must contain exactly one root directory', [
      metadataIssue('multiple_root_directories', '', 'ZIP must contain exactly one root directory'),
    ])
  }
  const rootDirectory = [...roots][0]!
  const skillEntries = businessEntries.filter(entry => (
    !entry.directory && entry.path.split('/').at(-1)?.toLocaleLowerCase('en-US') === 'skill.md'
  ))
  if (skillEntries.length !== 1 || skillEntries[0]?.path !== `${rootDirectory}/SKILL.md`) {
    throw canonicalSkillFileIssue(rootDirectory)
  }

  const skillEntry = skillEntries[0]!
  const parsed = parseCreatorSkillDocument(readContent(skillEntry), rootDirectory, skillEntry.path)
  return { slug: parsed.metadata.name, ...parsed }
}
