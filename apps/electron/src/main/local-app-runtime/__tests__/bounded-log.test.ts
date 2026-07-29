import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { BoundedLogWriter } from '../bounded-log'

let testRoot = ''

beforeEach(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'polo-bounded-log-test-'))
})

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

describe('BoundedLogWriter', () => {
  it('bounds pending output and records a dropped-line marker without promise-per-line writes', async () => {
    const logPath = join(testRoot, 'runtime.log')
    const writer = new BoundedLogWriter({
      path: logPath,
      maxFileBytes: 2_048,
      maxPendingBytes: 512,
      maxLineBytes: 256,
      flushBytes: 4_096,
      flushIntervalMs: 60_000,
      now: () => 0,
    })

    for (let index = 0; index < 100; index += 1) {
      writer.append('stdout', `${index}:${'x'.repeat(100)}`)
    }
    await writer.flush()

    const content = await readFile(logPath, 'utf8')
    expect(content).toContain('Dropped ')
    expect(content).toContain('log lines')
    expect((await stat(logPath)).size).toBeLessThanOrEqual(2_048)
  })

  it('rotates at the configured limit and reads only the requested tail across files', async () => {
    const logPath = join(testRoot, 'runtime.log')
    const writer = new BoundedLogWriter({
      path: logPath,
      maxFileBytes: 320,
      maxPendingBytes: 256,
      maxLineBytes: 128,
      flushBytes: 1,
      flushIntervalMs: 60_000,
      now: () => 0,
    })

    for (let index = 0; index < 12; index += 1) {
      writer.append('system', `line-${index}-${'y'.repeat(40)}`)
      await writer.flush()
    }

    expect((await stat(logPath)).size).toBeLessThanOrEqual(320)
    expect((await stat(`${logPath}.1`)).size).toBeLessThanOrEqual(320)
    const tail = await writer.readTail(3)
    expect(tail).toContain('line-11-')
    expect(tail.split('\n')).toHaveLength(3)
    expect(tail).not.toContain('line-0-')
  })
})
