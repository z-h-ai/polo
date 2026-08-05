import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { savePiTurnAnchor } from './SessionManager.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('session sidecar permissions', () => {
  it('atomically writes private directories and files', async () => {
    const sessionPath = await mkdtemp(join(tmpdir(), 'polo-sidecar-mode-'))
    tempDirs.push(sessionPath)
    await savePiTurnAnchor(sessionPath, 'message-1', 'anchor-1')

    if (process.platform !== 'win32') {
      expect((await stat(join(sessionPath, 'meta'))).mode & 0o777).toBe(0o700)
      expect((await stat(join(sessionPath, 'meta', 'pi-turn-anchors.json'))).mode & 0o777).toBe(0o600)
    }
  })
})
