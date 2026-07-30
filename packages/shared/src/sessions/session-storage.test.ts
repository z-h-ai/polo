import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  RootedSessionStorage,
  ensureSessionDir,
  getSessionAttachmentsPath,
  getSessionDataPath,
  getSessionDownloadsPath,
  getSessionPath,
  getSessionPlansPath,
  resetSessionStorage,
  setSessionStorage,
} from './index.ts'

const tempDirs: string[] = []

afterEach(() => {
  resetSessionStorage()
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('RootedSessionStorage', () => {
  it('routes every Polo-owned session path under the injected CLI root', () => {
    const temp = mkdtempSync(join(tmpdir(), 'polo-rooted-storage-'))
    tempDirs.push(temp)
    const sessionsRoot = join(temp, 'thread', 'sessions')
    setSessionStorage(new RootedSessionStorage(sessionsRoot))

    const fakeWorkspace = join(temp, 'electron-workspace')
    const sessionDir = ensureSessionDir(fakeWorkspace, 'session-1')
    expect(sessionDir).toBe(join(sessionsRoot, 'session-1'))
    expect(getSessionPath(fakeWorkspace, 'session-1')).toBe(sessionDir)
    expect(getSessionAttachmentsPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'attachments'))
    expect(getSessionPlansPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'plans'))
    expect(getSessionDataPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'data'))
    expect(getSessionDownloadsPath(fakeWorkspace, 'session-1')).toBe(join(sessionDir, 'downloads'))

    if (process.platform !== 'win32') {
      expect(statSync(sessionDir).mode & 0o777).toBe(0o700)
    }
  })
})
