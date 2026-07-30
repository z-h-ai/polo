import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import {
  DEFAULT_SKILL_ARCHIVE_POLICY,
  HARD_SKILL_ARCHIVE_POLICY,
  type CreatorSkillManifestEntry,
  type SkillArchivePolicy,
  type SkillValidationIssue,
  type SkillVersionMetadata,
} from './types'
import {
  readValidatedSkillMetadata,
  validatePortableSkillContent,
} from './skill-content'

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const EXECUTABLE_MAGICS = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from([0x4d, 0x5a]), // PE / DOS
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
  Buffer.from([0xbe, 0xba, 0xfe, 0xca]),
]
const NESTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.tgz', '.tar.gz']

interface NormalizedArchiveEntry {
  entry: Entry
  normalizedPath: string
  directory: boolean
  ignored: boolean
}

export interface CreatorSkillArchiveValidation {
  archiveChecksum: string
  contentDigest: string
  manifest: CreatorSkillManifestEntry[]
  metadata: SkillVersionMetadata
  warnings: SkillValidationIssue[]
  expandedBytes: number
}

export class CreatorSkillArchiveError extends Error {
  readonly code:
    | 'invalid_skill_archive'
    | 'skill_validation_failed'
    | 'archive_policy_exceeded'
    | 'checksum_mismatch'
    | 'content_digest_mismatch'
  readonly issues: SkillValidationIssue[]

  constructor(
    code: CreatorSkillArchiveError['code'],
    message: string,
    issues: SkillValidationIssue[] = [],
  ) {
    super(message)
    this.name = 'CreatorSkillArchiveError'
    this.code = code
    this.issues = issues
  }
}

function issue(
  code: string,
  path: string,
  message: string,
  field?: string,
  suggestion?: string,
  severity: 'error' | 'warning' = 'error',
): SkillValidationIssue {
  return {
    code,
    severity,
    path,
    ...(field ? { field } : {}),
    message,
    ...(suggestion ? { suggestion } : {}),
  }
}

function effectivePolicy(policy?: SkillArchivePolicy): SkillArchivePolicy {
  const candidate = policy ?? DEFAULT_SKILL_ARCHIVE_POLICY
  const positive = (value: number, fallback: number) => (
    Number.isSafeInteger(value) && value > 0 ? value : fallback
  )
  return {
    version: candidate.version || DEFAULT_SKILL_ARCHIVE_POLICY.version,
    maxArchiveBytes: Math.min(
      positive(candidate.maxArchiveBytes, DEFAULT_SKILL_ARCHIVE_POLICY.maxArchiveBytes),
      HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes,
    ),
    maxFileCount: Math.min(
      positive(candidate.maxFileCount, DEFAULT_SKILL_ARCHIVE_POLICY.maxFileCount),
      HARD_SKILL_ARCHIVE_POLICY.maxFileCount,
    ),
    maxFileBytes: Math.min(
      positive(candidate.maxFileBytes, DEFAULT_SKILL_ARCHIVE_POLICY.maxFileBytes),
      HARD_SKILL_ARCHIVE_POLICY.maxFileBytes,
    ),
    maxExpandedBytes: Math.min(
      positive(candidate.maxExpandedBytes, DEFAULT_SKILL_ARCHIVE_POLICY.maxExpandedBytes),
      HARD_SKILL_ARCHIVE_POLICY.maxExpandedBytes,
    ),
  }
}

function isPackagingNoise(path: string): boolean {
  const parts = path.split('/').filter(Boolean)
  if (parts[0] === '__MACOSX') return true
  const name = parts.at(-1) ?? ''
  return name === '.DS_Store'
    || name === 'Thumbs.db'
    || name === 'desktop.ini'
    || name.startsWith('._')
}

function normalizeArchivePath(rawPath: string): string {
  if (!rawPath || rawPath.includes('\0')) {
    throw new CreatorSkillArchiveError(
      'invalid_skill_archive',
      'Archive contains an empty or NUL path',
      [issue('invalid_path', '', 'Archive path is empty or contains a NUL byte')],
    )
  }
  const separated = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/')
  if (
    separated.startsWith('/')
    || separated.startsWith('//')
    || /^[a-zA-Z]:/.test(separated)
  ) {
    throw new CreatorSkillArchiveError(
      'invalid_skill_archive',
      'Archive contains an absolute path',
      [issue('absolute_path', rawPath, 'Absolute archive paths are not allowed')],
    )
  }
  const trailingSlash = separated.endsWith('/')
  const parts = separated.split('/').filter((part, index, all) => (
    !(part === '' && index === all.length - 1)
  ))
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new CreatorSkillArchiveError(
        'invalid_skill_archive',
        'Archive contains path traversal',
        [issue('path_traversal', rawPath, "Archive paths cannot contain '.' or '..' segments")],
      )
    }
    if (part.endsWith(' ') || part.endsWith('.')) {
      throw new CreatorSkillArchiveError(
        'invalid_skill_archive',
        'Archive contains an ambiguous path',
        [issue('ambiguous_path', rawPath, 'Path segments cannot end with a space or dot')],
      )
    }
    if (/[<>:"|?*\u0001-\u001F]/u.test(part)) {
      throw new CreatorSkillArchiveError(
        'invalid_skill_archive',
        'Archive contains a path that is invalid on Windows',
        [issue('invalid_windows_path', rawPath, 'Path segments cannot contain Windows-invalid characters')],
      )
    }
    if (WINDOWS_RESERVED_NAME.test(part)) {
      throw new CreatorSkillArchiveError(
        'invalid_skill_archive',
        'Archive contains a Windows reserved path',
        [issue('windows_reserved_name', rawPath, `'${part}' is a Windows reserved name`)],
      )
    }
  }
  const normalized = parts.map(part => part.normalize('NFC')).join('/')
  return trailingSlash ? `${normalized}/` : normalized
}

function entryKind(entry: Entry): 'file' | 'directory' | 'link' | 'special' {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff
  const unixType = mode & 0o170000
  if (unixType === 0o120000) return 'link'
  if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
    return 'special'
  }
  if (
    entry.fileName.endsWith('/')
    || unixType === 0o040000
    || (entry.externalFileAttributes & 0x10) === 0x10
  ) {
    return 'directory'
  }
  return 'file'
}

function inspectArchiveDirectory(
  rawEntries: Entry[],
  policy: SkillArchivePolicy,
  slug: string,
): {
  normalizedEntries: NormalizedArchiveEntry[]
  warnings: SkillValidationIssue[]
} {
  let fileCount = 0
  let declaredExpandedBytes = 0
  const warnings: SkillValidationIssue[] = []
  const normalizedEntries: NormalizedArchiveEntry[] = []
  const exactPaths = new Map<string, string>()
  const portablePaths = new Map<string, string>()
  const pathKinds = new Map<string, 'file' | 'directory'>()

  for (const entry of rawEntries) {
    const normalizedPath = normalizeArchivePath(entry.fileName)
    const kind = entryKind(entry)
    if (kind === 'link' || kind === 'special') {
      throw new CreatorSkillArchiveError(
        'invalid_skill_archive',
        'Archive contains a link or special file',
        [issue('unsupported_entry_type', normalizedPath, 'Only regular files and directories are allowed')],
      )
    }
    const directory = kind === 'directory'
    const ignored = isPackagingNoise(normalizedPath)
    if (!directory) {
      fileCount += 1
      declaredExpandedBytes += entry.uncompressedSize
      if (fileCount > policy.maxFileCount) {
        throw new CreatorSkillArchiveError(
          'archive_policy_exceeded',
          'ZIP contains too many files',
          [issue('max_file_count_exceeded', normalizedPath, `Archive must contain at most ${policy.maxFileCount} files`)],
        )
      }
      if (entry.uncompressedSize > policy.maxFileBytes) {
        throw new CreatorSkillArchiveError(
          'archive_policy_exceeded',
          'ZIP contains a file over the size limit',
          [issue('max_file_bytes_exceeded', normalizedPath, `File must be at most ${policy.maxFileBytes} bytes`)],
        )
      }
      if (declaredExpandedBytes > policy.maxExpandedBytes) {
        throw new CreatorSkillArchiveError(
          'archive_policy_exceeded',
          'ZIP expands beyond the size policy',
          [issue('max_expanded_bytes_exceeded', normalizedPath, `Expanded archive must be at most ${policy.maxExpandedBytes} bytes`)],
        )
      }
    }
    if (ignored) {
      warnings.push(issue(
        'packaging_noise_removed',
        normalizedPath.replace(/\/$/, ''),
        'Known packaging noise was ignored',
        undefined,
        undefined,
        'warning',
      ))
      normalizedEntries.push({ entry, normalizedPath, directory, ignored })
      continue
    }

    const comparable = normalizedPath.replace(/\/$/, '')
    const exactPrevious = exactPaths.get(comparable)
    if (exactPrevious) {
      throw new CreatorSkillArchiveError(
        'invalid_skill_archive',
        'ZIP contains duplicate normalized paths',
        [issue('duplicate_path', comparable, `Conflicts with '${exactPrevious}'`)],
      )
    }
    exactPaths.set(comparable, entry.fileName)
    pathKinds.set(comparable, directory ? 'directory' : 'file')
    const portable = comparable.toLocaleLowerCase('en-US')
    const portablePrevious = portablePaths.get(portable)
    if (portablePrevious) {
      throw new CreatorSkillArchiveError(
        'invalid_skill_archive',
        'ZIP contains case or Unicode normalization conflicts',
        [issue('portable_path_conflict', comparable, `Conflicts with '${portablePrevious}'`)],
      )
    }
    portablePaths.set(portable, comparable)
    normalizedEntries.push({ entry, normalizedPath, directory, ignored })
  }

  for (const [normalizedPath] of pathKinds) {
    const parts = normalizedPath.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/')
      if (pathKinds.get(parent) === 'file') {
        throw new CreatorSkillArchiveError(
          'invalid_skill_archive',
          'ZIP contains a file and directory type conflict',
          [issue(
            'path_type_conflict',
            normalizedPath,
            `'${parent}' is a file but is also used as a directory`,
          )],
        )
      }
    }
  }

  const businessEntries = normalizedEntries.filter(entry => !entry.ignored)
  const roots = new Set(
    businessEntries
      .map(entry => entry.normalizedPath.replace(/\/$/, '').split('/')[0])
      .filter(Boolean),
  )
  if (roots.size !== 1 || !roots.has(slug)) {
    throw new CreatorSkillArchiveError(
      'invalid_skill_archive',
      'ZIP must contain exactly one root directory matching the Skill slug',
      [issue('root_directory_mismatch', '', `Expected the only root directory to be '${slug}'`)],
    )
  }

  const fileEntries = businessEntries.filter(entry => !entry.directory)
  const skillFiles = fileEntries.filter(
    entry => entry.normalizedPath === `${slug}/SKILL.md`,
  )
  if (skillFiles.length !== 1) {
    throw new CreatorSkillArchiveError(
      'invalid_skill_archive',
      'ZIP must contain exactly one root SKILL.md',
      [issue('skill_file_count', `${slug}/SKILL.md`, 'Exactly one SKILL.md is required')],
    )
  }

  for (const archiveEntry of businessEntries) {
    const relative = archiveEntry.normalizedPath
      .replace(/\/$/, '')
      .slice(slug.length + 1)
    if (!relative) continue
    const allowed = relative === 'SKILL.md'
      || relative === 'icon.png'
      || relative === 'references'
      || relative.startsWith('references/')
    if (!allowed) {
      throw new CreatorSkillArchiveError(
        'invalid_skill_archive',
        'ZIP contains a file outside the allowed Skill structure',
        [issue('unexpected_skill_path', archiveEntry.normalizedPath, 'Only SKILL.md, icon.png, and references/ are allowed')],
      )
    }
    if (
      (relative === 'icon.png' && archiveEntry.directory)
      || (relative === 'references' && !archiveEntry.directory)
    ) {
      throw new CreatorSkillArchiveError(
        'invalid_skill_archive',
        'ZIP contains a file or directory with the wrong type',
        [issue(
          'skill_structure_type_mismatch',
          archiveEntry.normalizedPath,
          relative === 'icon.png'
            ? 'icon.png must be a regular file'
            : 'references must be a directory',
        )],
      )
    }
  }

  return { normalizedEntries, warnings }
}

function openZip(archivePath: string): Promise<ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(archivePath, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      strictFileNames: false,
      validateEntrySizes: true,
    }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(new CreatorSkillArchiveError(
          'invalid_skill_archive',
          'Archive is not a valid ZIP',
          [issue('invalid_zip', '', error?.message ?? 'Unable to open ZIP archive')],
        ))
      } else {
        resolvePromise(zipFile)
      }
    })
  })
}

function readEntries(zipFile: ZipFile): Promise<Entry[]> {
  return new Promise((resolvePromise, reject) => {
    const entries: Entry[] = []
    const fail = (error: Error) => {
      const traversalRejected = /invalid relative path|absolute path|\.\./i.test(error.message)
      reject(new CreatorSkillArchiveError(
        'invalid_skill_archive',
        traversalRejected
          ? 'Archive contains path traversal'
          : 'Unable to read ZIP directory',
        [issue(
          traversalRejected ? 'path_traversal' : 'invalid_zip',
          '',
          traversalRejected
            ? "Archive paths cannot contain '.' or '..' segments"
            : error.message,
        )],
      ))
    }
    zipFile.once('error', fail)
    zipFile.on('entry', (entry: Entry) => {
      entries.push(entry)
      zipFile.readEntry()
    })
    zipFile.once('end', () => {
      zipFile.removeListener('error', fail)
      resolvePromise(entries)
    })
    zipFile.readEntry()
  })
}

function readEntry(zipFile: ZipFile, entry: Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    zipFile.openReadStream(entry, (openError, stream) => {
      if (openError || !stream) {
        reject(new CreatorSkillArchiveError(
          'invalid_skill_archive',
          'Unable to decompress archive entry',
          [issue('entry_read_failed', entry.fileName, openError?.message ?? 'No entry stream')],
        ))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) {
          stream.destroy(new CreatorSkillArchiveError(
            'archive_policy_exceeded',
            'Archive entry exceeds the size policy',
            [issue('max_file_bytes_exceeded', entry.fileName, 'File exceeds the configured size limit')],
          ))
          return
        }
        chunks.push(chunk)
      })
      stream.once('error', reject)
      stream.once('end', () => resolvePromise(Buffer.concat(chunks, size)))
    })
  })
}

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix)
}

function isNestedArchive(path: string, data: Buffer): boolean {
  const lower = path.toLowerCase()
  if (NESTED_ARCHIVE_EXTENSIONS.some(extension => lower.endsWith(extension))) return true
  if (
    startsWith(data, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    || startsWith(data, Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    || startsWith(data, Buffer.from([0x50, 0x4b, 0x07, 0x08]))
  ) {
    return true
  }
  return data.length >= 262 && data.subarray(257, 262).toString('ascii') === 'ustar'
}

function isExecutableBinary(data: Buffer): boolean {
  return EXECUTABLE_MAGICS.some(magic => startsWith(data, magic))
}

function isEmojiIcon(value: string): boolean {
  if (/^https?:\/\//i.test(value) || value.includes('/') || value.includes('\\')) return false
  if (value.length > 64 || !/\p{Extended_Pictographic}/u.test(value)) return false
  return value
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D\s]/gu, '')
    .length === 0
}

export function canonicalManifestJson(manifest: CreatorSkillManifestEntry[]): string {
  return JSON.stringify(manifest.map(entry => ({
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256,
  })))
}

export function calculateContentDigest(manifest: CreatorSkillManifestEntry[]): string {
  return createHash('sha256').update(canonicalManifestJson(manifest), 'utf8').digest('hex')
}

function sortManifest(
  entries: CreatorSkillManifestEntry[],
): CreatorSkillManifestEntry[] {
  return entries.sort((left, right) => Buffer
    .from(left.path, 'utf8')
    .compare(Buffer.from(right.path, 'utf8')))
}

function compareExpectedManifest(
  actual: CreatorSkillManifestEntry[],
  expected?: CreatorSkillManifestEntry[],
): void {
  if (!expected) return
  const normalizedExpected = sortManifest(expected.map(entry => ({
    path: entry.path.normalize('NFC').replace(/\\/g, '/'),
    size: entry.size,
    sha256: entry.sha256.toLowerCase(),
  })))
  if (canonicalManifestJson(actual) !== canonicalManifestJson(normalizedExpected)) {
    throw new CreatorSkillArchiveError(
      'content_digest_mismatch',
      'Extracted files do not match the published manifest',
      [issue('manifest_mismatch', '', 'File paths, sizes, or hashes differ from the published manifest')],
    )
  }
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolvePromise(hash.digest('hex')))
  })
}

/**
 * Fast renderer/server-core preflight. It reads the ZIP directory only, so it
 * can reject obvious size, path, entry-type, root, and structure problems
 * before upload without pretending to replace the Admin service validation.
 */
export async function preflightCreatorSkillArchive(args: {
  archivePath: string
  slug: string
  policy?: SkillArchivePolicy
}): Promise<{
  archiveChecksum: string
  warnings: SkillValidationIssue[]
}> {
  const policy = effectivePolicy(args.policy)
  const archiveStats = await stat(args.archivePath)
  if (!archiveStats.isFile() || archiveStats.size > policy.maxArchiveBytes) {
    throw new CreatorSkillArchiveError(
      'archive_policy_exceeded',
      'ZIP exceeds the archive size policy',
      [issue('max_archive_bytes_exceeded', '', `Archive must be at most ${policy.maxArchiveBytes} bytes`)],
    )
  }
  const archiveChecksum = await sha256File(args.archivePath)
  const zipFile = await openZip(args.archivePath)
  try {
    const rawEntries = await readEntries(zipFile)
    const { warnings } = inspectArchiveDirectory(rawEntries, policy, args.slug)
    return { archiveChecksum, warnings }
  } finally {
    zipFile.close()
  }
}

export async function validateCreatorSkillArchive(args: {
  archivePath: string
  slug: string
  destinationRoot?: string
  policy?: SkillArchivePolicy
  expectedArchiveChecksum?: string
  expectedContentDigest?: string
  expectedManifest?: CreatorSkillManifestEntry[]
}): Promise<CreatorSkillArchiveValidation> {
  const policy = effectivePolicy(args.policy)
  const archiveStats = await stat(args.archivePath)
  if (!archiveStats.isFile() || archiveStats.size > policy.maxArchiveBytes) {
    throw new CreatorSkillArchiveError(
      'archive_policy_exceeded',
      'ZIP exceeds the archive size policy',
      [issue('max_archive_bytes_exceeded', '', `Archive must be at most ${policy.maxArchiveBytes} bytes`)],
    )
  }
  const archiveChecksum = await sha256File(args.archivePath)
  if (
    args.expectedArchiveChecksum
    && archiveChecksum !== args.expectedArchiveChecksum.toLowerCase()
  ) {
    throw new CreatorSkillArchiveError(
      'checksum_mismatch',
      'Downloaded ZIP checksum does not match the published version',
      [issue('archive_checksum_mismatch', '', 'The downloaded object failed its SHA-256 check')],
    )
  }

  const zipFile = await openZip(args.archivePath)
  try {
    const rawEntries = await readEntries(zipFile)
    const { normalizedEntries, warnings } = inspectArchiveDirectory(
      rawEntries,
      policy,
      args.slug,
    )
    const businessEntries = normalizedEntries.filter(entry => !entry.ignored)

    const manifest: CreatorSkillManifestEntry[] = []
    let metadata: SkillVersionMetadata | undefined
    let expandedBytes = 0
    const destination = args.destinationRoot
      ? resolve(args.destinationRoot)
      : undefined
    if (destination) await mkdir(destination, { recursive: true })

    for (const archiveEntry of businessEntries) {
      if (archiveEntry.directory) {
        if (destination) {
          const outputDir = resolve(destination, archiveEntry.normalizedPath.replace(/\/$/, ''))
          if (!outputDir.startsWith(`${destination}${sep}`) && outputDir !== destination) {
            throw new CreatorSkillArchiveError(
              'invalid_skill_archive',
              'Archive extraction escaped the staging directory',
              [issue('path_traversal', archiveEntry.normalizedPath, 'Unsafe extraction target')],
            )
          }
          await mkdir(outputDir, { recursive: true, mode: 0o755 })
          await chmod(outputDir, 0o755)
        }
        continue
      }
      const data = await readEntry(zipFile, archiveEntry.entry, policy.maxFileBytes)
      expandedBytes += data.length
      if (expandedBytes > policy.maxExpandedBytes) {
        throw new CreatorSkillArchiveError(
          'archive_policy_exceeded',
          'ZIP expands beyond the size policy',
          [issue('max_expanded_bytes_exceeded', archiveEntry.normalizedPath, 'Expanded data exceeded the configured limit')],
        )
      }
      if (isNestedArchive(archiveEntry.normalizedPath, data)) {
        throw new CreatorSkillArchiveError(
          'invalid_skill_archive',
          'Nested archives are not allowed',
          [issue('nested_archive', archiveEntry.normalizedPath, 'ZIP and TAR payloads cannot be bundled inside a Creator Skill')],
        )
      }
      if (isExecutableBinary(data)) {
        throw new CreatorSkillArchiveError(
          'invalid_skill_archive',
          'Executable binaries are not allowed',
          [issue('executable_binary', archiveEntry.normalizedPath, 'ELF, PE, and Mach-O binaries are rejected')],
        )
      }
      if (
        archiveEntry.normalizedPath === `${args.slug}/icon.png`
        && !startsWith(data, PNG_SIGNATURE)
      ) {
        throw new CreatorSkillArchiveError(
          'invalid_skill_archive',
          'icon.png is not a PNG image',
          [issue('invalid_icon_format', archiveEntry.normalizedPath, 'The package icon must be a PNG file')],
        )
      }
      if (archiveEntry.normalizedPath === `${args.slug}/SKILL.md`) {
        const content = data.toString('utf8')
        const contentValidation = validatePortableSkillContent(content, args.slug)
        if (!contentValidation.valid) {
          throw new CreatorSkillArchiveError(
            'skill_validation_failed',
            'SKILL.md validation failed',
            contentValidation.errors.map(error => issue(
              'invalid_skill_content',
              'SKILL.md',
              error.message,
              error.path,
              error.suggestion,
            )),
          )
        }
        const parsed = readValidatedSkillMetadata(content, args.slug)
        if (!parsed) {
          throw new CreatorSkillArchiveError(
            'skill_validation_failed',
            'SKILL.md validation failed',
          )
        }
        if (parsed.metadata.icon && !isEmojiIcon(parsed.metadata.icon)) {
          throw new CreatorSkillArchiveError(
            'skill_validation_failed',
            'Creator Skill icon must be an emoji',
            [issue(
              'invalid_creator_icon',
              'SKILL.md',
              'Creator Skill frontmatter icon must be an emoji, not a URL or file path',
              'icon',
            )],
          )
        }
        metadata = parsed.metadata
      }

      const relativePath = archiveEntry.normalizedPath.slice(args.slug.length + 1)
      manifest.push({
        path: relativePath,
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      })
      if (destination) {
        const outputPath = resolve(destination, archiveEntry.normalizedPath)
        if (!outputPath.startsWith(`${destination}${sep}`)) {
          throw new CreatorSkillArchiveError(
            'invalid_skill_archive',
            'Archive extraction escaped the staging directory',
            [issue('path_traversal', archiveEntry.normalizedPath, 'Unsafe extraction target')],
          )
        }
        await mkdir(resolve(outputPath, '..'), { recursive: true, mode: 0o755 })
        await writeFile(outputPath, data, { mode: 0o644, flag: 'wx' })
        await chmod(outputPath, 0o644)
      }
    }

    if (!metadata) {
      throw new CreatorSkillArchiveError(
        'skill_validation_failed',
        'SKILL.md metadata was not produced',
      )
    }
    sortManifest(manifest)
    compareExpectedManifest(manifest, args.expectedManifest)
    const contentDigest = calculateContentDigest(manifest)
    if (
      args.expectedContentDigest
      && contentDigest !== args.expectedContentDigest.toLowerCase()
    ) {
      throw new CreatorSkillArchiveError(
        'content_digest_mismatch',
        'Extracted content digest does not match the published version',
        [issue('content_digest_mismatch', '', 'Canonical manifest digest differs from the published digest')],
      )
    }
    return {
      archiveChecksum,
      contentDigest,
      manifest,
      metadata,
      warnings,
      expandedBytes,
    }
  } finally {
    zipFile.close()
  }
}

export async function scanCreatorSkillDirectory(
  skillDirectory: string,
): Promise<{ manifest: CreatorSkillManifestEntry[]; contentDigest: string }> {
  const root = resolve(skillDirectory)
  const manifest: CreatorSkillManifestEntry[] = []
  let fileCount = 0
  let totalBytes = 0

  const scan = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name.normalize('NFC')}`
        : entry.name.normalize('NFC')
      const fullPath = join(directory, entry.name)
      const fileStat = await lstat(fullPath)
      if (fileStat.isSymbolicLink() || (!fileStat.isDirectory() && !fileStat.isFile())) {
        throw new CreatorSkillArchiveError(
          'content_digest_mismatch',
          'Installed Skill contains a link or special file',
          [issue('local_type_mismatch', relative, 'Only regular files and directories are expected')],
        )
      }
      if (fileStat.isDirectory()) {
        await scan(fullPath, relative)
      } else {
        fileCount += 1
        totalBytes += fileStat.size
        if (
          fileCount > HARD_SKILL_ARCHIVE_POLICY.maxFileCount
          || fileStat.size > HARD_SKILL_ARCHIVE_POLICY.maxFileBytes
          || totalBytes > HARD_SKILL_ARCHIVE_POLICY.maxExpandedBytes
        ) {
          throw new CreatorSkillArchiveError(
            'content_digest_mismatch',
            'Installed Skill exceeds the local integrity scan limits',
            [issue(
              'local_policy_exceeded',
              relative,
              'The installed Skill exceeds an absolute file count or size limit',
            )],
          )
        }
        const fileHash = await sha256File(fullPath)
        const afterHashStat = await lstat(fullPath)
        if (
          !afterHashStat.isFile()
          || afterHashStat.size !== fileStat.size
          || afterHashStat.mtimeMs !== fileStat.mtimeMs
        ) {
          throw new CreatorSkillArchiveError(
            'content_digest_mismatch',
            'Installed Skill changed during the integrity scan',
            [issue('local_scan_race', relative, 'The file changed while it was being checked')],
          )
        }
        manifest.push({
          path: relative,
          size: fileStat.size,
          sha256: fileHash,
        })
      }
    }
  }

  await scan(root, '')
  sortManifest(manifest)
  return { manifest, contentDigest: calculateContentDigest(manifest) }
}

export async function directorySize(path: string): Promise<number> {
  const pathStat = await lstat(path)
  if (pathStat.isFile()) return pathStat.size
  if (!pathStat.isDirectory()) return 0
  const entries = await readdir(path)
  let total = 0
  for (const entry of entries) total += await directorySize(join(path, entry))
  return total
}

export function creatorSkillBackupTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

export function inferBackupCreatedAt(path: string): string {
  const name = basename(path)
  const candidate = name.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    '$1:$2:$3.$4',
  )
  return Number.isNaN(Date.parse(candidate)) ? new Date(0).toISOString() : candidate
}

export function hasArchiveLikeExtension(path: string): boolean {
  const lower = path.toLowerCase()
  return NESTED_ARCHIVE_EXTENSIONS.some(extension => lower.endsWith(extension))
    || extname(lower) === '.gz'
}
