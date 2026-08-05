import { describe, test, expect, afterEach } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import {
  getFileType,
  getMimeType,
  getProcessInstanceFingerprint,
  readFileAttachment,
  withCrossProcessFileLockSync,
} from '../files'

const cleanups: Array<() => void> = []

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'files-test-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c()
    } catch {
      // best-effort
    }
  }
})

// ---------------------------------------------------------------------------
// Regression for #719: audio extensions must NOT fall through to 'text'.
// ---------------------------------------------------------------------------

describe('getFileType — audio support', () => {
  test('voice note .ogg → audio (regression for default-to-text fallthrough)', () => {
    expect(getFileType('voice.ogg')).toBe('audio')
  })

  test('mp3 → audio', () => {
    expect(getFileType('song.mp3')).toBe('audio')
  })

  test('m4a → audio', () => {
    expect(getFileType('clip.m4a')).toBe('audio')
  })

  test('wav → audio', () => {
    expect(getFileType('beep.wav')).toBe('audio')
  })

  test('opus → audio', () => {
    expect(getFileType('voice.opus')).toBe('audio')
  })

  test('non-audio still resolves correctly (regression guard)', () => {
    expect(getFileType('file.txt')).toBe('text')
    expect(getFileType('image.png')).toBe('image')
    expect(getFileType('doc.pdf')).toBe('pdf')
    expect(getFileType('sheet.xlsx')).toBe('office')
  })
})

describe('getMimeType — audio support', () => {
  test('ogg → audio/ogg', () => {
    expect(getMimeType('voice.ogg')).toBe('audio/ogg')
  })

  test('mp3 → audio/mpeg', () => {
    expect(getMimeType('song.mp3')).toBe('audio/mpeg')
  })

  test('opus → audio/ogg', () => {
    expect(getMimeType('voice.opus')).toBe('audio/ogg')
  })
})

describe('readFileAttachment — audio fixture', () => {
  test('returns an audio attachment with base64 populated', () => {
    const dir = makeTmp()
    const path = join(dir, 'voice.ogg')
    const bytes = Buffer.from('fake-ogg-bytes')
    writeFileSync(path, bytes)

    const att = readFileAttachment(path)
    expect(att).not.toBeNull()
    expect(att?.type).toBe('audio')
    expect(att?.mimeType).toBe('audio/ogg')
    expect(att?.base64).toBe(bytes.toString('base64'))
    expect(att?.text).toBeUndefined()
    expect(att?.size).toBe(bytes.byteLength)
  })

  test('returns text attachment for .txt — regression guard', () => {
    const dir = makeTmp()
    const path = join(dir, 'note.txt')
    writeFileSync(path, 'hello world')

    const att = readFileAttachment(path)
    expect(att).not.toBeNull()
    expect(att?.type).toBe('text')
    expect(att?.text).toBe('hello world')
    expect(att?.base64).toBeUndefined()
  })
})

describe('cross-process file transaction lock', () => {
  test('releases the lock after a mutation throws', () => {
    const dir = makeTmp()
    const lockDir = join(dir, '.config.transaction.lock')
    expect(() => withCrossProcessFileLockSync(lockDir, () => {
      throw new Error('mutation failed')
    })).toThrow('mutation failed')
    expect(existsSync(lockDir)).toBe(false)
    expect(withCrossProcessFileLockSync(lockDir, () => 'recovered')).toBe('recovered')
  })

  test('recovers a lock left by a process that exited', () => {
    const dir = makeTmp()
    const lockDir = join(dir, '.credentials.transaction.lock')
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      nonce: 'abandoned-owner',
      processStartFingerprint: 'dead-process-instance',
      createdAt: Date.now() - 60_000,
    }))

    expect(withCrossProcessFileLockSync(lockDir, () => 'recovered')).toBe('recovered')
    expect(existsSync(lockDir)).toBe(false)
  })

  test('recovers a stale owner when its PID was reused by another process instance', () => {
    const dir = makeTmp()
    const lockDir = join(dir, '.config.transaction.lock')
    const currentFingerprint = getProcessInstanceFingerprint()
    expect(currentFingerprint).toBeTruthy()
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
      schemaVersion: 1,
      pid: process.pid,
      nonce: 'previous-process-with-reused-pid',
      processStartFingerprint: `${currentFingerprint}-previous-instance`,
      createdAt: Date.now() - 60_000,
    }))

    expect(withCrossProcessFileLockSync(lockDir, () => 'pid-reuse-recovered'))
      .toBe('pid-reuse-recovered')
    expect(existsSync(lockDir)).toBe(false)
  })
})
