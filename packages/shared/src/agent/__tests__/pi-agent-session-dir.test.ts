import { describe, expect, it } from 'bun:test'
import { join } from 'path'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'
import { defaultWorkspaceSessionStorage } from '../../sessions/session-storage.ts'

// POO-205 C5: the host sends the session's ACTUAL store directory via
// CoreBackendConfig.sessionDir; every agent-side path composition (Pi init
// sessionPath, plans/data/RTK/screenshot dirs) must derive from it. When the
// field is absent (older hosts, external callers) the legacy
// `{workspace.rootPath}/sessions/{id}` layout is the fallback — byte-for-byte
// what pre-C5 code computed.

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/polo-ai-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/polo-ai-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...overrides,
  }
}

describe('agent sessionDir resolution (POO-205 C5)', () => {
  it('prefers the host-provided sessionDir (the project store) verbatim', () => {
    const projectStoreDir = join('/tmp/polo-ai-test', 'project-sessions', 'prj_x', 'sessions', 'session-test')
    const agent = new PiAgent(createConfig({ sessionDir: projectStoreDir }))
    expect((agent as any).resolveSessionDir()).toBe(projectStoreDir)
    agent.destroy()
  })

  it('falls back to the legacy {workspace.rootPath}/sessions/{id} layout when sessionDir is absent', () => {
    const agent = new PiAgent(createConfig())
    expect((agent as any).resolveSessionDir()).toBe(
      defaultWorkspaceSessionStorage.getSessionPath('/tmp/polo-ai-test', 'session-test'),
    )
    agent.destroy()
  })

  it('the fallback matches the shared storage path service exactly (no hand-rolled join)', () => {
    const agent = new PiAgent(createConfig())
    const resolved = (agent as any).resolveSessionDir() as string
    // The legacy layout is `<root>/sessions/<sanitized id>` — the same shape
    // every SessionStorage consumer uses.
    expect(resolved).toBe(join('/tmp/polo-ai-test', 'sessions', 'session-test'))
    agent.destroy()
  })
})
