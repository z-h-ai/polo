import { createReadStream } from 'fs'
import { chmod, mkdir, open, readFile, writeFile } from 'fs/promises'
import { dirname, normalize, resolve, sep } from 'path'
import { inflateRawSync } from 'zlib'
import * as tar from 'tar'
import { LocalAppRuntimeError } from './runtime-error'

const MAX_ARCHIVE_ENTRIES = 20_000
const MAX_UNCOMPRESSED_BYTES = 4 * 1024 * 1024 * 1024
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_LOCAL_SIGNATURE = 0x04034b50

function unsafe(message: string, details?: Record<string, unknown>): never {
  throw new LocalAppRuntimeError('UNSAFE_ARCHIVE', message, details)
}

function normalizeArchivePath(input: string): string {
  if (!input || input.includes('\0')) unsafe('Archive contains an empty path or NUL byte')
  const portable = input.replaceAll('\\', '/')
  if (
    portable.startsWith('/')
    || /^[A-Za-z]:\//.test(portable)
    || portable.split('/').includes('..')
  ) {
    unsafe(`Archive entry escapes the bundle root: ${input}`, { path: input })
  }
  const normalized = normalize(portable)
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    unsafe(`Archive entry escapes the bundle root: ${input}`, { path: input })
  }
  return normalized.replaceAll('\\', '/').replace(/^\.\/+/, '')
}

function assertDestinationPath(root: string, relativePath: string): string {
  const destination = resolve(root, relativePath)
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (destination !== root && !destination.startsWith(rootPrefix)) {
    unsafe(`Archive entry escapes the bundle root: ${relativePath}`, { path: relativePath })
  }
  return destination
}

async function detectArchiveType(archivePath: string): Promise<'zip' | 'tar'> {
  const handle = await open(archivePath, 'r')
  try {
    const header = Buffer.alloc(512)
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    if (bytesRead >= 4 && header.readUInt32LE(0) === 0x04034b50) return 'zip'
    if (bytesRead >= 2 && header[0] === 0x1f && header[1] === 0x8b) return 'tar'
    if (bytesRead >= 262 && header.subarray(257, 262).toString('ascii') === 'ustar') return 'tar'
  } finally {
    await handle.close()
  }
  throw new LocalAppRuntimeError(
    'UNSUPPORTED_ARCHIVE',
    'Bundle must be a .zip, .tar, .tar.gz, or .tgz archive',
  )
}

async function extractTar(archivePath: string, destination: string): Promise<void> {
  const seen = new Set<string>()
  let entryCount = 0
  let totalSize = 0

  await tar.t({
    file: archivePath,
    strict: true,
    onentry: (entry) => {
      const relativePath = normalizeArchivePath(entry.path)
      if (!relativePath) return
      const dedupeKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath
      if (seen.has(dedupeKey)) unsafe(`Archive contains duplicate entry: ${entry.path}`)
      seen.add(dedupeKey)

      entryCount += 1
      totalSize += entry.size
      if (entryCount > MAX_ARCHIVE_ENTRIES) unsafe('Archive contains too many entries')
      if (totalSize > MAX_UNCOMPRESSED_BYTES) unsafe('Archive expands beyond the supported size limit')

      if (!['File', 'OldFile', 'Directory', 'ExtendedHeader', 'GlobalExtendedHeader'].includes(entry.type)) {
        unsafe(`Archive entry type "${entry.type}" is not allowed`, {
          path: entry.path,
          type: entry.type,
        })
      }
    },
  })

  await tar.x({
    file: archivePath,
    cwd: destination,
    strict: true,
    preservePaths: false,
    filter: (path) => {
      normalizeArchivePath(path)
      return true
    },
  })
}

function findZipEndOfCentralDirectory(buffer: Buffer): number {
  const minimumOffset = Math.max(0, buffer.length - 65_557)
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) return offset
  }
  throw new LocalAppRuntimeError('UNSUPPORTED_ARCHIVE', 'ZIP archive is missing its central directory')
}

interface ZipEntry {
  path: string
  compressedSize: number
  uncompressedSize: number
  compressionMethod: number
  flags: number
  localHeaderOffset: number
  mode: number
  isDirectory: boolean
}

function readZipEntries(buffer: Buffer): ZipEntry[] {
  const eocdOffset = findZipEndOfCentralDirectory(buffer)
  const entryCount = buffer.readUInt16LE(eocdOffset + 10)
  const centralSize = buffer.readUInt32LE(eocdOffset + 12)
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new LocalAppRuntimeError('UNSUPPORTED_ARCHIVE', 'ZIP64 bundles are not supported')
  }
  if (entryCount > MAX_ARCHIVE_ENTRIES) unsafe('ZIP archive contains too many entries')
  if (centralOffset + centralSize > buffer.length) unsafe('ZIP central directory is truncated')

  const entries: ZipEntry[] = []
  const seen = new Set<string>()
  let totalSize = 0
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      unsafe('ZIP central directory is malformed')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const compressionMethod = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const externalAttributes = buffer.readUInt32LE(offset + 38)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if (nextOffset > buffer.length) unsafe('ZIP central directory entry is truncated')

    const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const path = normalizeArchivePath(rawName)
    if (!path) {
      offset = nextOffset
      continue
    }
    const dedupeKey = process.platform === 'win32' ? path.toLowerCase() : path
    if (seen.has(dedupeKey)) unsafe(`ZIP archive contains duplicate entry: ${rawName}`)
    seen.add(dedupeKey)

    if ((flags & 0x1) !== 0) unsafe(`Encrypted ZIP entries are not allowed: ${rawName}`)
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new LocalAppRuntimeError(
        'UNSUPPORTED_ARCHIVE',
        `ZIP compression method ${compressionMethod} is not supported`,
        { path: rawName },
      )
    }

    const unixMode = (externalAttributes >>> 16) & 0xffff
    const fileType = unixMode & 0o170000
    if (fileType === 0o120000) unsafe(`ZIP symbolic links are not allowed: ${rawName}`)
    if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
      unsafe(`ZIP special file is not allowed: ${rawName}`)
    }

    totalSize += uncompressedSize
    if (totalSize > MAX_UNCOMPRESSED_BYTES) unsafe('ZIP archive expands beyond the supported size limit')
    entries.push({
      path,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      flags,
      localHeaderOffset,
      mode: unixMode & 0o777,
      isDirectory: rawName.endsWith('/') || fileType === 0o040000,
    })
    offset = nextOffset
  }
  return entries
}

async function extractZip(archivePath: string, destination: string): Promise<void> {
  const buffer = await readFile(archivePath)
  const entries = readZipEntries(buffer)
  for (const entry of entries) {
    const outputPath = assertDestinationPath(destination, entry.path)
    if (entry.isDirectory) {
      await mkdir(outputPath, { recursive: true })
      continue
    }

    const offset = entry.localHeaderOffset
    if (offset + 30 > buffer.length || buffer.readUInt32LE(offset) !== ZIP_LOCAL_SIGNATURE) {
      unsafe(`ZIP local header is malformed: ${entry.path}`)
    }
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const dataOffset = offset + 30 + nameLength + extraLength
    const dataEnd = dataOffset + entry.compressedSize
    if (dataEnd > buffer.length) unsafe(`ZIP entry data is truncated: ${entry.path}`)

    const compressed = buffer.subarray(dataOffset, dataEnd)
    let content: Buffer
    try {
      content = entry.compressionMethod === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed)
    } catch (error) {
      unsafe(`ZIP entry could not be decompressed: ${entry.path}`, {
        cause: error instanceof Error ? error.message : String(error),
      })
    }
    if (content.length !== entry.uncompressedSize) {
      unsafe(`ZIP entry size does not match its central directory: ${entry.path}`)
    }

    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, content, { flag: 'wx', mode: entry.mode || 0o644 })
    if ((entry.mode & 0o111) !== 0) await chmod(outputPath, entry.mode)
  }
}

export async function extractBundleArchive(archivePath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true })
  const type = await detectArchiveType(archivePath)
  if (type === 'zip') {
    await extractZip(archivePath, destination)
  } else {
    // Opening once before tar gives clearer errors for files that disappeared.
    createReadStream(archivePath).destroy()
    await extractTar(archivePath, destination)
  }
}
