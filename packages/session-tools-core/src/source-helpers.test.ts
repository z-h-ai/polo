import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSessionWorkingDirectory } from './source-helpers.ts'

const tempDirs: string[] = []

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('session working directory resolution', () => {
  it('uses the injected session context instead of a module-global resolver', () => {
    const temp = mkdtempSync(join(tmpdir(), 'polo-session-context-'))
    tempDirs.push(temp)
    const workspace = join(temp, 'workspace')
    const cliSession = join(temp, 'cli-thread', 'sessions', 'session-1')
    mkdirSync(join(workspace, 'sessions', 'session-1'), { recursive: true })
    mkdirSync(cliSession, { recursive: true })
    writeFileSync(
      join(workspace, 'sessions', 'session-1', 'session.jsonl'),
      `${JSON.stringify({ workingDirectory: '/electron-directory' })}\n`,
    )
    writeFileSync(
      join(cliSession, 'session.jsonl'),
      `${JSON.stringify({ workingDirectory: '/cli-directory' })}\n`,
    )

    expect(resolveSessionWorkingDirectory(workspace, 'session-1', cliSession)).toBe('/cli-directory')
    expect(resolveSessionWorkingDirectory(workspace, 'session-1')).toBe('/electron-directory')
  })
})
