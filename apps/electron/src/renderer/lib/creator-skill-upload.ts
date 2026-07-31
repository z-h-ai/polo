import type { CreatorSkillUploadGrant } from '../../shared/types'

export class CreatorSkillUploadError extends Error {
  readonly errorCode:
    | 'invalid_skill_archive'
    | 'archive_policy_exceeded'
    | 'upload_expired'
    | 'creator_skill_upload_cancelled'
    | 'NETWORK_ERROR'

  constructor(errorCode: CreatorSkillUploadError['errorCode']) {
    super(errorCode)
    this.name = 'CreatorSkillUploadError'
    this.errorCode = errorCode
  }
}

const HARD_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const HARD_MAX_ARCHIVE_ENTRIES = 1_000
const MAX_EOCD_SCAN_BYTES = 65_557
const MAX_CENTRAL_DIRECTORY_BYTES = 8 * 1024 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })

function isIgnoredNoisePath(path: string): boolean {
  return path === '.DS_Store'
    || path === 'Thumbs.db'
    || path === 'desktop.ini'
    || path.startsWith('__MACOSX/')
    || path.split('/').some(part => part.startsWith('._'))
}

function invalidArchive(): never {
  throw new CreatorSkillUploadError('invalid_skill_archive')
}

/**
 * Fast, renderer-only ZIP central-directory inspection. It intentionally does
 * not extract data or replace server validation; it only catches the obvious
 * malformed root, traversal, link, and entry-count cases before a large PUT.
 */
export async function preflightCreatorSkillUploadFile(file: File, slug: string): Promise<void> {
  if (file.size <= 0) invalidArchive()
  if (file.size > HARD_MAX_ARCHIVE_BYTES) {
    throw new CreatorSkillUploadError('archive_policy_exceeded')
  }
  const tailOffset = Math.max(0, file.size - MAX_EOCD_SCAN_BYTES)
  const tail = new DataView(await file.slice(tailOffset).arrayBuffer())
  let eocd = -1
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (tail.getUint32(offset, true) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) invalidArchive()
  if (tail.getUint16(eocd + 4, true) !== 0 || tail.getUint16(eocd + 6, true) !== 0) invalidArchive()
  const entryCount = tail.getUint16(eocd + 10, true)
  const centralDirectorySize = tail.getUint32(eocd + 12, true)
  const centralDirectoryOffset = tail.getUint32(eocd + 16, true)
  if (
    entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
    || entryCount > HARD_MAX_ARCHIVE_ENTRIES
    || centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES
    || centralDirectoryOffset + centralDirectorySize > file.size
  ) invalidArchive()

  const directory = new DataView(await file.slice(
    centralDirectoryOffset,
    centralDirectoryOffset + centralDirectorySize,
  ).arrayBuffer())
  let offset = 0
  let skillFileCount = 0
  const seen = new Set<string>()
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > directory.byteLength || directory.getUint32(offset, true) !== 0x02014b50) invalidArchive()
    const nameLength = directory.getUint16(offset + 28, true)
    const extraLength = directory.getUint16(offset + 30, true)
    const commentLength = directory.getUint16(offset + 32, true)
    const externalAttributes = directory.getUint32(offset + 38, true)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > directory.byteLength) invalidArchive()
    let path: string
    try {
      path = decoder.decode(new Uint8Array(directory.buffer, directory.byteOffset + offset + 46, nameLength))
    } catch {
      invalidArchive()
    }
    offset = nextOffset
    if (!path || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) invalidArchive()
    const isDirectory = path.endsWith('/')
    const normalized = path.normalize('NFC')
    const parts = normalized.replace(/\/$/, '').split('/')
    if (parts.some(part => !part || part === '.' || part === '..')) invalidArchive()
    // Unix symlink file mode in the ZIP central-directory external attributes.
    if (((externalAttributes >>> 16) & 0o170000) === 0o120000) invalidArchive()
    if (isIgnoredNoisePath(normalized)) continue
    if (parts[0] !== slug || seen.has(normalized)) invalidArchive()
    seen.add(normalized)
    if (!isDirectory && normalized === `${slug}/SKILL.md`) skillFileCount += 1
  }
  if (offset !== directory.byteLength || skillFileCount !== 1) invalidArchive()
}

/**
 * The selected File remains in Chromium's file-backed Blob implementation.
 * It is deliberately PUT from the renderer to the signed object URL: archive
 * bytes must not be marshalled over Electron RPC or buffered by server-core.
 * The Admin service calculates the authoritative archive checksum from the
 * stored object, so this path never materializes a 100 MiB File in JS memory.
 */
export async function uploadCreatorSkillArchive(
  file: File,
  grant: CreatorSkillUploadGrant,
  options: {
    signal: AbortSignal
    fetchImpl?: typeof fetch
  },
): Promise<{ sizeBytes: number }> {
  const fetchImpl = options.fetchImpl ?? fetch

  let response: Response
  try {
    response = await fetchImpl(grant.url, {
      method: grant.method,
      headers: grant.headers,
      body: file,
      redirect: 'error',
      signal: options.signal,
    })
  } catch {
    if (options.signal.aborted) throw new CreatorSkillUploadError('creator_skill_upload_cancelled')
    throw new CreatorSkillUploadError('NETWORK_ERROR')
  }
  if (!response.ok) {
    throw new CreatorSkillUploadError(response.status === 403 ? 'upload_expired' : 'NETWORK_ERROR')
  }
  if (options.signal.aborted) throw new CreatorSkillUploadError('creator_skill_upload_cancelled')

  return {
    sizeBytes: file.size,
  }
}
