import { parseDocument } from 'yaml'

export const CREATOR_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const CREATOR_SKILL_NAME_MAX_LENGTH = 64
export const CREATOR_SKILL_DESCRIPTION_MAX_LENGTH = 1_024
export const CREATOR_SKILL_MAX_METADATA_ITEMS = 1_000
export const CREATOR_SKILL_ICON_MAX_LENGTH = 64
export const CREATOR_SKILL_GLOB_MAX_LENGTH = 2_048
export const CREATOR_SKILL_PERMISSION_MAX_LENGTH = 512
export const CANONICAL_SKILL_FILE_MESSAGE = 'Exactly one SKILL.md basename is allowed and it must be at the package root'
export const EMPTY_SKILL_CONTENT_MESSAGE = 'Skill content is empty (nothing after frontmatter)'
export const EMPTY_SKILL_CONTENT_SUGGESTION = 'Add instructions after the frontmatter describing what the skill should do'
export const CREATOR_SKILL_ROOT_ERROR_MESSAGE = 'ZIP must contain exactly one root directory matching the Creator Skill slug'
export const INVALID_YAML_FRONTMATTER_MESSAGE = 'SKILL.md frontmatter must contain valid YAML metadata'
const MAX_YAML_ALIAS_COUNT = 32

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
    | 'invalid_skill_root'
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

function rootIssue(): CreatorSkillMetadataError {
  return new CreatorSkillMetadataError(CREATOR_SKILL_ROOT_ERROR_MESSAGE, [
    metadataIssue('invalid_skill_root', '', CREATOR_SKILL_ROOT_ERROR_MESSAGE),
  ])
}

/** Resolves the one ZIP root used by both browser and archive validation. */
export function resolveCreatorSkillRoot(
  entries: readonly Pick<NormalizedSkillZipEntry, 'path' | 'directory'>[],
  expectedRootDirectory?: string,
): string {
  const businessEntries = entries.filter(entry => entry.path.length > 0 && !isCreatorSkillPackagingNoise(entry.path))
  const roots = new Set<string>()
  for (const entry of businessEntries) {
    const parts = entry.path.replace(/\/$/, '').split('/').filter(Boolean)
    if (parts.length < 2) {
      if (parts.length === 1 && (entry.directory || entry.path.endsWith('/'))) {
        roots.add(parts[0]!)
        continue
      }
      throw rootIssue()
    }
    roots.add(parts[0]!)
  }
  if (roots.size !== 1) throw rootIssue()
  const rootDirectory = [...roots][0]!
  if (expectedRootDirectory !== undefined && rootDirectory !== expectedRootDirectory) throw rootIssue()
  return rootDirectory
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue('invalid_skill_content', path, 'SKILL.md frontmatter must be a YAML mapping', 'frontmatter'),
    ])
  }
  return value as Record<string, unknown>
}

function requiredName(data: Record<string, unknown>, path: string): string {
  const value = data.name
  if (typeof value !== 'string' || value.length === 0) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue('invalid_skill_content', path, 'Creator Skill name is required and must be a string', 'name'),
    ])
  }
  return value
}

function requiredDescription(data: Record<string, unknown>, path: string): string {
  const value = data.description
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue('invalid_skill_content', path, 'Creator Skill description is required and must be a string', 'description'),
    ])
  }
  return value.trim()
}

/** Counts Unicode code points without depending on Node or UTF-16 code units. */
function unicodeCodePointLength(value: string): number {
  return Array.from(value).length
}

function optionalString(data: Record<string, unknown>, field: 'icon', path: string): string | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue('invalid_skill_content', path, `Creator Skill ${field} must be a non-empty string`, field),
    ])
  }
  const normalized = value.trim()
  if (!isCreatorSkillEmojiIcon(normalized)) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue(
        'invalid_skill_content',
        path,
        'Creator Skill frontmatter icon must be an emoji, not a URL, file path, or decorative text',
        field,
      ),
    ])
  }
  return normalized
}

export function isCreatorSkillEmojiIcon(value: string): boolean {
  if (/^https?:\/\//i.test(value) || value.includes('/') || value.includes('\\')) return false
  if (value.length > CREATOR_SKILL_ICON_MAX_LENGTH || !/\p{Extended_Pictographic}/u.test(value)) return false
  return value
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D\s]/gu, '')
    .length === 0
}

function optionalStrings(
  data: Record<string, unknown>,
  field: 'globs' | 'alwaysAllow' | 'requiredSources',
  path: string,
): string[] | undefined {
  const value = data[field]
  if (value === undefined) return undefined
  if (
    !Array.isArray(value)
    || value.length > CREATOR_SKILL_MAX_METADATA_ITEMS
    || value.some(item => typeof item !== 'string' || item.length === 0)
  ) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue('invalid_skill_content', path, `Creator Skill ${field} must be an array of strings`, field),
    ])
  }
  const itemMaxLength = field === 'globs'
    ? CREATOR_SKILL_GLOB_MAX_LENGTH
    : CREATOR_SKILL_PERMISSION_MAX_LENGTH
  if (value.some(item => item.length > itemMaxLength)) {
    throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', [
      metadataIssue(
        'invalid_skill_content',
        path,
        `Creator Skill ${field} entries must be at most ${itemMaxLength} characters`,
        field,
      ),
    ])
  }
  return value
}

/**
 * The sole production Creator Skill metadata constraint. Structured consumers
 * may omit rootDirectory; SKILL.md parsing supplies it to enforce ZIP identity.
 */
export function validateCreatorSkillMetadata(
  value: unknown,
  path: string,
  rootDirectory?: string,
): CreatorSkillMetadata {
  const data = asRecord(value, path)
  const name = requiredName(data, path)
  const description = requiredDescription(data, path)
  const issues: CreatorSkillMetadataIssue[] = []
  const validName = name.length <= CREATOR_SKILL_NAME_MAX_LENGTH && CREATOR_SKILL_NAME_PATTERN.test(name)
  if (!validName) {
    issues.push(metadataIssue('invalid_skill_content', path, 'Creator Skill name must use strict kebab-case (for example, polo-test)', 'name'))
  }
  if (unicodeCodePointLength(description) > CREATOR_SKILL_DESCRIPTION_MAX_LENGTH) {
    issues.push(metadataIssue('invalid_skill_content', path, 'Creator Skill description must be at most 1024 characters', 'description'))
  }
  if (rootDirectory !== undefined && validName && name !== rootDirectory) {
    issues.push(metadataIssue('invalid_skill_content', path, `Creator Skill name '${name}' must match root directory '${rootDirectory}'`, 'name', `Use 'name: ${rootDirectory}' or rename the root directory`))
  }
  if (issues.length > 0) throw new CreatorSkillMetadataError('SKILL.md metadata is invalid', issues)

  const globs = optionalStrings(data, 'globs', path)
  const alwaysAllow = optionalStrings(data, 'alwaysAllow', path)
  const icon = optionalString(data, 'icon', path)
  const requiredSources = optionalStrings(data, 'requiredSources', path)
  return {
    name,
    description,
    ...(globs ? { globs } : {}),
    ...(alwaysAllow ? { alwaysAllow } : {}),
    ...(icon ? { icon } : {}),
    ...(requiredSources ? { requiredSources } : {}),
  }
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
  let metadata: CreatorSkillMetadata
  try {
    const document = parseDocument(source.slice(opening[0].length, closing.index), {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    })
    if (document.errors.length > 0) throw new Error('YAML parse error')
    metadata = validateCreatorSkillMetadata(document.toJS({ maxAliasCount: MAX_YAML_ALIAS_COUNT }), path, rootDirectory)
  } catch (error) {
    if (error instanceof CreatorSkillMetadataError) throw error
    throw new CreatorSkillMetadataError('SKILL.md frontmatter is invalid', [
      metadataIssue('invalid_skill_content', path, INVALID_YAML_FRONTMATTER_MESSAGE, 'frontmatter'),
    ])
  }
  const body = source.slice(closing.index + closing[0].length).replace(/^\r?\n/, '')
  if (body.trim().length === 0) {
    throw new CreatorSkillMetadataError('SKILL.md content is empty', [
      metadataIssue('invalid_skill_content', path, EMPTY_SKILL_CONTENT_MESSAGE, 'content', EMPTY_SKILL_CONTENT_SUGGESTION),
    ])
  }

  return {
    metadata,
    body,
  }
}

export function parseCreatorSkillMetadata(
  entries: readonly NormalizedSkillZipEntry[],
  expectedRootDirectory?: string,
): ParsedCreatorSkillMetadata {
  const businessEntries = entries.filter(entry => entry.path.length > 0 && !isCreatorSkillPackagingNoise(entry.path))
  const rootDirectory = resolveCreatorSkillRoot(businessEntries, expectedRootDirectory)
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
