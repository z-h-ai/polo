import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { createClaudeContext } from '../claude-context.ts'
import { defaultWorkspaceSessionStorage } from '../../sessions/session-storage.ts'

// POO-205 C5-fix (§5 X7): the session-tool context (generate_app's canvas
// write root, plan/data folders) must derive from the host-provided store
// directory when one exists — a project session's artifacts landed in the
// legacy `{workspace}/sessions/{id}/data` layout that the storage-twin gates
// no longer read, so "save to my apps" could not find the freshly written
// bundle. Without a sessionDir the legacy composition is byte-for-byte
// unchanged.

const WORKSPACE = '/tmp/polo-ctx-test'
const SESSION = 'session-ctx'

describe('session tool context store-dir override (POO-205 C5-fix X7)', () => {
  it('derives sessionPath/dataPath/plansFolderPath from the store dir verbatim', () => {
    const storeDir = join(WORKSPACE, 'project-sessions', 'prj_x', 'sessions', SESSION)
    const ctx = createClaudeContext({
      sessionId: SESSION,
      workspacePath: WORKSPACE,
      workspaceId: 'ws-test',
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
      sessionDir: storeDir,
    })
    expect(ctx.sessionPath).toBe(storeDir)
    expect(ctx.dataPath).toBe(join(storeDir, 'data'))
    expect(ctx.plansFolderPath).toBe(join(storeDir, 'plans'))
  })

  it('keeps the legacy workspace-root composition when no sessionDir is given', () => {
    const ctx = createClaudeContext({
      sessionId: SESSION,
      workspacePath: WORKSPACE,
      workspaceId: 'ws-test',
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    })
    expect(ctx.sessionPath).toBe(defaultWorkspaceSessionStorage.getSessionPath(WORKSPACE, SESSION))
    expect(ctx.dataPath).toBe(defaultWorkspaceSessionStorage.getDataPath(WORKSPACE, SESSION))
    expect(ctx.plansFolderPath).toBe(defaultWorkspaceSessionStorage.getPlansPath(WORKSPACE, SESSION))
  })

  it('the store-dir dataPath mirrors the storage composition (<session>/data)', () => {
    const storeDir = join(WORKSPACE, 'project-sessions', 'prj_x', 'sessions', SESSION)
    const ctx = createClaudeContext({
      sessionId: SESSION,
      workspacePath: WORKSPACE,
      workspaceId: 'ws-test',
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
      sessionDir: storeDir,
    })
    // The twin gates compose data as `<session dir>/data` — the override must
    // match that shape exactly or the publish chain still misses the bundle.
    expect(ctx.dataPath).toBe(join(storeDir, 'data'))
  })
})
