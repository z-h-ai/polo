import { randomUUID } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { appendFile, mkdir, open, rename, rm, stat } from 'fs/promises'
import { dirname } from 'path'
import { pipeline } from 'stream/promises'

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_PENDING_BYTES = 256 * 1024
const DEFAULT_MAX_LINE_BYTES = 64 * 1024
const DEFAULT_FLUSH_BYTES = 64 * 1024
const DEFAULT_FLUSH_INTERVAL_MS = 50
const READ_BLOCK_BYTES = 64 * 1024

export interface BoundedLogWriterOptions {
  path: string
  now?: () => number
  onError?: (error: unknown) => void
  maxFileBytes?: number
  maxPendingBytes?: number
  maxLineBytes?: number
  flushBytes?: number
  flushIntervalMs?: number
}

export class BoundedLogWriter {
  private readonly path: string
  private readonly rotatedPath: string
  private readonly now: () => number
  private readonly onError: (error: unknown) => void
  private readonly maxFileBytes: number
  private readonly maxPendingBytes: number
  private readonly maxLineBytes: number
  private readonly flushBytes: number
  private readonly flushIntervalMs: number
  private pending: string[] = []
  private pendingBytes = 0
  private droppedLines = 0
  private droppedBytes = 0
  private flushTimer?: ReturnType<typeof setTimeout>
  private flushPromise?: Promise<void>

  constructor(options: BoundedLogWriterOptions) {
    this.path = options.path
    this.rotatedPath = `${options.path}.1`
    this.now = options.now ?? Date.now
    this.onError = options.onError ?? (() => {})
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    this.flushBytes = options.flushBytes ?? DEFAULT_FLUSH_BYTES
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
  }

  append(source: 'stdout' | 'stderr' | 'system', message: string): void {
    const normalized = message.replaceAll('\0', '').split(/\r?\n/)
    for (const physicalLine of normalized) {
      const line = this.formatLine(source, physicalLine)
      const bytes = Buffer.byteLength(line)
      if (bytes > this.maxPendingBytes || this.pendingBytes + bytes > this.maxPendingBytes) {
        this.droppedLines += 1
        this.droppedBytes += bytes
        continue
      }
      this.pending.push(line)
      this.pendingBytes += bytes
    }
    this.scheduleFlush()
  }

  async flush(): Promise<void> {
    this.clearFlushTimer()
    while (this.flushPromise || this.hasPendingData()) {
      const activeFlush = this.flushPromise ?? this.startFlush()
      await activeFlush
      this.clearFlushTimer()
    }
    await this.enforceExistingLimits()
  }

  async readTail(maxLines: number): Promise<string> {
    await this.flush()
    const currentLines = await this.readTailLines(this.path, maxLines)
    if (currentLines.length >= maxLines) return currentLines.join('\n')
    const rotatedLines = await this.readTailLines(
      this.rotatedPath,
      maxLines - currentLines.length,
    )
    return [...rotatedLines, ...currentLines].join('\n')
  }

  private formatLine(source: 'stdout' | 'stderr' | 'system', message: string): string {
    const prefix = `[${new Date(this.now()).toISOString()}] [${source}] `
    const suffix = '\n'
    const availableBytes = Math.max(0, this.maxLineBytes - Buffer.byteLength(prefix + suffix))
    const raw = Buffer.from(message)
    const truncated = raw.length > availableBytes
      ? `${raw.subarray(0, Math.max(0, availableBytes - 3)).toString('utf8')}...`
      : message
    return `${prefix}${truncated}${suffix}`
  }

  private scheduleFlush(): void {
    if (!this.hasPendingData() || this.flushPromise || this.flushTimer) return
    if (this.pendingBytes >= this.flushBytes) {
      void this.startFlush()
      return
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.startFlush()
    }, this.flushIntervalMs)
    this.flushTimer.unref?.()
  }

  private startFlush(): Promise<void> {
    if (this.flushPromise) return this.flushPromise
    this.clearFlushTimer()
    if (!this.hasPendingData()) return Promise.resolve()

    const chunks = this.pending
    const droppedLines = this.droppedLines
    const droppedBytes = this.droppedBytes
    this.pending = []
    this.pendingBytes = 0
    this.droppedLines = 0
    this.droppedBytes = 0
    if (droppedLines > 0) {
      chunks.push(this.formatLine(
        'system',
        `Dropped ${droppedLines} log lines (${droppedBytes} bytes) because the log buffer was full`,
      ))
    }
    const batch = Buffer.from(chunks.join(''))
    const write = this.writeBatch(batch)
      .catch(error => this.onError(error))
      .finally(() => {
        if (this.flushPromise === write) this.flushPromise = undefined
        this.scheduleFlush()
      })
    this.flushPromise = write
    return write
  }

  private async writeBatch(rawBatch: Buffer): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await this.enforceExistingLimits()
    const batch = rawBatch.length > this.maxFileBytes
      ? rawBatch.subarray(rawBatch.length - this.maxFileBytes)
      : rawBatch
    let currentSize = await this.fileSize(this.path)
    if (currentSize + batch.length > this.maxFileBytes) {
      await rm(this.rotatedPath, { force: true })
      try {
        await rename(this.path, this.rotatedPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      currentSize = 0
    }
    if (currentSize === 0 || batch.length > 0) {
      await appendFile(this.path, batch, { mode: 0o600 })
    }
  }

  private async enforceExistingLimits(): Promise<void> {
    await this.trimFileToTail(this.path)
    await this.trimFileToTail(this.rotatedPath)
  }

  private async trimFileToTail(path: string): Promise<void> {
    const size = await this.fileSize(path)
    if (size <= this.maxFileBytes) return
    const temporaryPath = `${path}.${randomUUID()}.trim`
    await pipeline(
      createReadStream(path, { start: size - this.maxFileBytes }),
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    )
    await rm(path, { force: true })
    await rename(temporaryPath, path)
  }

  private async readTailLines(path: string, maxLines: number): Promise<string[]> {
    if (maxLines <= 0) return []
    let handle
    try {
      handle = await open(path, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    try {
      const fileStat = await handle.stat()
      let position = fileStat.size
      let newlineCount = 0
      const chunks: Buffer[] = []
      while (position > 0 && newlineCount <= maxLines) {
        const length = Math.min(READ_BLOCK_BYTES, position)
        position -= length
        const buffer = Buffer.allocUnsafe(length)
        const { bytesRead } = await handle.read(buffer, 0, length, position)
        const chunk = buffer.subarray(0, bytesRead)
        chunks.unshift(chunk)
        for (const byte of chunk) {
          if (byte === 0x0a) newlineCount += 1
        }
      }
      const lines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)
      if (lines.at(-1) === '') lines.pop()
      return lines.slice(-maxLines)
    } finally {
      await handle.close()
    }
  }

  private async fileSize(path: string): Promise<number> {
    try {
      return (await stat(path)).size
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }
  }

  private hasPendingData(): boolean {
    return this.pending.length > 0 || this.droppedLines > 0
  }

  private clearFlushTimer(): void {
    if (!this.flushTimer) return
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
  }
}
