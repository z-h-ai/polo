import { createReadStream, createWriteStream } from 'fs'
import { chmod, mkdir, open } from 'fs/promises'
import { dirname, normalize, resolve, sep } from 'path'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'
import * as tar from 'tar'
import * as yauzl from 'yauzl'
import { LocalAppRuntimeError } from './runtime-error'

const MAX_ARCHIVE_ENTRIES = 10_000
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024
const MAX_ZIP_ENTRY_BYTES = 256 * 1024 * 1024
const MAX_ZIP_COMPRESSION_RATIO = 200

function unsafe(message: string, details?: Record<string, unknown>): never {
  throw new LocalAppRuntimeError('UNSAFE_ARCHIVE', message, details)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  throw new LocalAppRuntimeError('INSTALL_CANCELLED', 'Archive extraction was cancelled')
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

async function extractTar(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  const seen = new Set<string>()
  let entryCount = 0
  let totalSize = 0

  await tar.t({
    file: archivePath,
    strict: true,
    onentry: (entry) => {
      throwIfAborted(signal)
      const relativePath = normalizeArchivePath(entry.path)
      if (!relativePath) return
      const dedupeKey = process.platform === 'win32' ? relativePath.toLowerCase() : relativePath
      if (seen.has(dedupeKey)) unsafe(`Archive contains duplicate entry: ${entry.path}`)
      seen.add(dedupeKey)

      entryCount += 1
      totalSize += entry.size
      if (entryCount > MAX_ARCHIVE_ENTRIES) unsafe('Archive contains too many entries')
      if (entry.size > MAX_ZIP_ENTRY_BYTES) unsafe(`Archive entry is too large: ${entry.path}`)
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
      throwIfAborted(signal)
      normalizeArchivePath(path)
      return true
    },
  })
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, rejectZip) => {
    yauzl.open(archivePath, {
      autoClose: true,
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    }, (error, zipFile) => {
      if (error || !zipFile) {
        rejectZip(new LocalAppRuntimeError(
          'UNSUPPORTED_ARCHIVE',
          `ZIP archive could not be opened: ${error?.message ?? 'unknown error'}`,
        ))
      } else {
        resolveZip(zipFile)
      }
    })
  })
}

function openZipEntryStream(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, rejectStream) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) rejectStream(error ?? new Error('ZIP entry stream is unavailable'))
      else resolveStream(stream)
    })
  })
}

function validateZipEntry(
  entry: yauzl.Entry,
  seen: Set<string>,
  totals: { entries: number; bytes: number },
): { path: string; isDirectory: boolean; mode: number } {
  const path = normalizeArchivePath(entry.fileName)
  const dedupeKey = process.platform === 'win32' ? path.toLowerCase() : path
  if (seen.has(dedupeKey)) unsafe(`ZIP archive contains duplicate entry: ${entry.fileName}`)
  seen.add(dedupeKey)

  totals.entries += 1
  totals.bytes += entry.uncompressedSize
  if (totals.entries > MAX_ARCHIVE_ENTRIES) unsafe('ZIP archive contains too many entries')
  if (entry.uncompressedSize > MAX_ZIP_ENTRY_BYTES) {
    unsafe(`ZIP entry is too large: ${entry.fileName}`)
  }
  if (totals.bytes > MAX_UNCOMPRESSED_BYTES) {
    unsafe('ZIP archive expands beyond the supported size limit')
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    unsafe(`Encrypted ZIP entries are not allowed: ${entry.fileName}`)
  }
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new LocalAppRuntimeError(
      'UNSUPPORTED_ARCHIVE',
      `ZIP compression method ${entry.compressionMethod} is not supported`,
      { path: entry.fileName },
    )
  }
  if (
    entry.uncompressedSize > 1024 * 1024
    && entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_ZIP_COMPRESSION_RATIO
  ) {
    unsafe(`ZIP entry exceeds the compression-ratio limit: ${entry.fileName}`)
  }

  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  const fileType = unixMode & 0o170000
  if (fileType === 0o120000) unsafe(`ZIP symbolic links are not allowed: ${entry.fileName}`)
  if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
    unsafe(`ZIP special file is not allowed: ${entry.fileName}`)
  }
  return {
    path,
    isDirectory: entry.fileName.endsWith('/') || fileType === 0o040000,
    mode: unixMode & 0o777,
  }
}

async function writeZipEntry(
  zipFile: yauzl.ZipFile,
  entry: yauzl.Entry,
  outputPath: string,
  mode: number,
  signal?: AbortSignal,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true })
  const input = await openZipEntryStream(zipFile, entry)
  let written = 0
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length
      if (written > entry.uncompressedSize || written > MAX_ZIP_ENTRY_BYTES) {
        callback(new LocalAppRuntimeError(
          'UNSAFE_ARCHIVE',
          `ZIP entry expanded beyond its declared size: ${entry.fileName}`,
        ))
        return
      }
      callback(null, chunk)
    },
  })
  await pipeline(
    input,
    limiter,
    createWriteStream(outputPath, { flags: 'wx', mode: mode || 0o644 }),
    { signal },
  )
  if (written !== entry.uncompressedSize) {
    unsafe(`ZIP entry size does not match its central directory: ${entry.fileName}`)
  }
  if ((mode & 0o111) !== 0) await chmod(outputPath, mode)
}

async function extractZip(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  const zipFile = await openZip(archivePath)
  const seen = new Set<string>()
  const totals = { entries: 0, bytes: 0 }
  await new Promise<void>((resolveExtraction, rejectExtraction) => {
    let settled = false
    let abort = () => {}
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      zipFile.close()
      rejectExtraction(error instanceof LocalAppRuntimeError
        ? error
        : new LocalAppRuntimeError(
            'UNSAFE_ARCHIVE',
            `ZIP archive is unsafe: ${error instanceof Error ? error.message : String(error)}`,
          ))
    }
    zipFile.once('error', fail)
    abort = () => fail(signal?.reason ?? new LocalAppRuntimeError(
      'INSTALL_CANCELLED',
      'Archive extraction was cancelled',
    ))
    signal?.addEventListener('abort', abort, { once: true })
    zipFile.once('end', () => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      resolveExtraction()
    })
    zipFile.on('entry', (entry) => {
      void (async () => {
        throwIfAborted(signal)
        const validated = validateZipEntry(entry, seen, totals)
        const outputPath = assertDestinationPath(destination, validated.path)
        if (validated.isDirectory) await mkdir(outputPath, { recursive: true })
        else await writeZipEntry(zipFile, entry, outputPath, validated.mode, signal)
        zipFile.readEntry()
      })().catch(fail)
    })
    zipFile.readEntry()
  })
}

export async function extractBundleArchive(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)
  await mkdir(destination, { recursive: true })
  const type = await detectArchiveType(archivePath)
  if (type === 'zip') {
    await extractZip(archivePath, destination, signal)
  } else {
    // Opening once before tar gives clearer errors for files that disappeared.
    createReadStream(archivePath).destroy()
    await extractTar(archivePath, destination, signal)
  }
}
