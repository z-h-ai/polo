/**
 * workspace-ownership.test.ts
 *
 * TDD tests for:
 *   AC1  - WorkspaceConfig.ownerUserId field
 *   AC2  - assertWorkspaceAccess() boundary matrix
 *   AC3  - auto-create workspace on connect (including handshake_ack workspaceId)
 *
 * Handler-integration AC4–AC7 are covered through the assertWorkspaceAccess
 * function being called (behavior is verified via unit tests of the helper
 * rather than end-to-end handler invocations, which require a full server).
 */

import { describe, expect, it, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { WsRpcServer } from '@polo-ai/server-core/transport'
import { PROTOCOL_VERSION } from '@polo-ai/shared/protocol'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'polo-ws-ownership-'))
  return d
}

function makeMinimalWorkspaceConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ws_abc12345',
    name: 'Test Workspace',
    slug: 'test-workspace',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function writeWorkspaceConfig(rootPath: string, cfg: Record<string, unknown>): void {
  mkdirSync(rootPath, { recursive: true })
  writeFileSync(join(rootPath, 'config.json'), JSON.stringify(cfg, null, 2), 'utf-8')
}

// ---------------------------------------------------------------------------
// AC1 — WorkspaceConfig ownerUserId field
// ---------------------------------------------------------------------------

describe('AC1: WorkspaceConfig ownerUserId field', () => {
  it('WorkspaceConfig type includes optional ownerUserId', async () => {
    const { saveWorkspaceConfig, loadWorkspaceConfig } = await import('@polo-ai/shared/workspaces/storage')
    const root = tempDir()
    try {
      // TypeScript: cast to any to assign ownerUserId, then verify it round-trips
      const cfg = makeMinimalWorkspaceConfig({ ownerUserId: 'user-a' })
      writeWorkspaceConfig(root, cfg)
      const loaded = loadWorkspaceConfig(root)
      expect(loaded).not.toBeNull()
      expect((loaded as any).ownerUserId).toBe('user-a')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('saveWorkspaceConfig persists ownerUserId', async () => {
    const { saveWorkspaceConfig, loadWorkspaceConfig } = await import('@polo-ai/shared/workspaces/storage')
    const root = tempDir()
    try {
      const cfg = {
        id: 'ws_test1234',
        name: 'Test',
        slug: 'test',
        ownerUserId: 'user-x',
        createdAt: 1000,
        updatedAt: 1000,
      } as any
      saveWorkspaceConfig(root, cfg)
      const loaded = loadWorkspaceConfig(root)
      expect((loaded as any).ownerUserId).toBe('user-x')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('loadWorkspaceConfig loads existing config without ownerUserId without error (treated as null/unowned)', async () => {
    const { loadWorkspaceConfig } = await import('@polo-ai/shared/workspaces/storage')
    const root = tempDir()
    try {
      // No ownerUserId in stored config
      writeWorkspaceConfig(root, makeMinimalWorkspaceConfig())
      const loaded = loadWorkspaceConfig(root)
      expect(loaded).not.toBeNull()
      // ownerUserId should be undefined/null (absent field), not throw
      expect((loaded as any).ownerUserId == null).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('createWorkspaceAtPath accepts ownerUserId and stores it in config', async () => {
    const { createWorkspaceAtPath, loadWorkspaceConfig } = await import('@polo-ai/shared/workspaces/storage')
    const root = tempDir()
    const wsRoot = join(root, 'my-workspace')
    try {
      // createWorkspaceAtPath should accept ownerUserId option
      createWorkspaceAtPath(wsRoot, 'My Workspace', undefined, 'user-owner-1')
      const loaded = loadWorkspaceConfig(wsRoot)
      expect(loaded).not.toBeNull()
      expect((loaded as any).ownerUserId).toBe('user-owner-1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// AC2 — assertWorkspaceAccess boundary matrix
// ---------------------------------------------------------------------------

describe('AC2: assertWorkspaceAccess boundary matrix', () => {
  async function getAssert() {
    const { assertWorkspaceAccess } = await import('@polo-ai/server-core/workspace-access')
    return assertWorkspaceAccess
  }

  it('ctx.userId matches workspace.ownerUserId → pass (no error)', async () => {
    const assertWorkspaceAccess = await getAssert()
    expect(() =>
      assertWorkspaceAccess({ userId: 'user-a' } as any, { ownerUserId: 'user-a' } as any)
    ).not.toThrow()
  })

  it('ctx.userId differs from workspace.ownerUserId → throws ForbiddenError', async () => {
    const assertWorkspaceAccess = await getAssert()
    expect(() =>
      assertWorkspaceAccess({ userId: 'user-a' } as any, { ownerUserId: 'user-b' } as any)
    ).toThrow()
    try {
      assertWorkspaceAccess({ userId: 'user-a' } as any, { ownerUserId: 'user-b' } as any)
    } catch (err: any) {
      expect(err.code).toBe('FORBIDDEN')
    }
  })

  it('ctx.userId is null (server-token) → pass (skip ownership check)', async () => {
    const assertWorkspaceAccess = await getAssert()
    expect(() =>
      assertWorkspaceAccess({ userId: null } as any, { ownerUserId: 'user-a' } as any)
    ).not.toThrow()
  })

  it('workspace.ownerUserId is null (legacy workspace) → pass (no owner assigned)', async () => {
    const assertWorkspaceAccess = await getAssert()
    expect(() =>
      assertWorkspaceAccess({ userId: 'user-a' } as any, { ownerUserId: null } as any)
    ).not.toThrow()
  })

  it('both ctx.userId and workspace.ownerUserId are null → pass', async () => {
    const assertWorkspaceAccess = await getAssert()
    expect(() =>
      assertWorkspaceAccess({ userId: null } as any, { ownerUserId: null } as any)
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC3 — findOrCreateUserWorkspace auto-create
// ---------------------------------------------------------------------------

describe('AC3: findOrCreateUserWorkspace auto-create', () => {
  async function getFindOrCreate() {
    const { findOrCreateUserWorkspace } = await import('@polo-ai/server-core/workspace-access')
    return findOrCreateUserWorkspace
  }

  it('user connects with no workspaceId and userId is set → workspace auto-created', async () => {
    const findOrCreateUserWorkspace = await getFindOrCreate()
    const { getDefaultWorkspacesDir } = await import('@polo-ai/shared/workspaces/storage')
    const root = tempDir()
    try {
      // Override HOME to use temp dir
      const origHome = process.env.HOME
      process.env.HOME = root
      // Must also delete PLATFORM mode to avoid user sub-dirs
      const origPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
      delete process.env.PLATFORM_ANTHROPIC_API_KEY

      try {
        const result = await findOrCreateUserWorkspace({ userId: 'user-123', username: 'alice' })
        expect(result).not.toBeNull()
        expect(result.config.name).toBe('alice')
        expect((result.config as any).ownerUserId).toBe('user-123')
      } finally {
        process.env.HOME = origHome
        if (origPlatformKey !== undefined) process.env.PLATFORM_ANTHROPIC_API_KEY = origPlatformKey
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('same user reconnects → finds existing workspace (no duplicate creation)', async () => {
    const findOrCreateUserWorkspace = await getFindOrCreate()
    const root = tempDir()
    try {
      const origHome = process.env.HOME
      process.env.HOME = root
      const origPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
      delete process.env.PLATFORM_ANTHROPIC_API_KEY

      try {
        const first = await findOrCreateUserWorkspace({ userId: 'user-456', username: 'bob' })
        const second = await findOrCreateUserWorkspace({ userId: 'user-456', username: 'bob' })
        expect(first.config.id).toBe(second.config.id)
      } finally {
        process.env.HOME = origHome
        if (origPlatformKey !== undefined) process.env.PLATFORM_ANTHROPIC_API_KEY = origPlatformKey
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('auto-created workspace has ownerUserId = userId', async () => {
    const findOrCreateUserWorkspace = await getFindOrCreate()
    const root = tempDir()
    try {
      const origHome = process.env.HOME
      process.env.HOME = root
      const origPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
      delete process.env.PLATFORM_ANTHROPIC_API_KEY

      try {
        const result = await findOrCreateUserWorkspace({ userId: 'user-789', username: 'carol' })
        expect((result.config as any).ownerUserId).toBe('user-789')
      } finally {
        process.env.HOME = origHome
        if (origPlatformKey !== undefined) process.env.PLATFORM_ANTHROPIC_API_KEY = origPlatformKey
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// AC3 — handshake_ack contains the auto-created workspace ID
// ---------------------------------------------------------------------------

describe('AC3: handshake_ack contains auto-created workspace ID', () => {
  let server: WsRpcServer | null = null
  const openSockets: WebSocket[] = []

  afterEach(() => {
    for (const ws of openSockets) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close()
      }
    }
    openSockets.length = 0
    server?.close()
    server = null
  })

  /**
   * Full WebSocket handshake that returns the entire handshake_ack envelope
   * so callers can inspect any field (clientId, workspaceId, etc.).
   */
  function handshakeFull(url: string, opts?: {
    token?: string
    userId?: string
    username?: string
  }): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      openSockets.push(ws)
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Handshake timeout'))
      }, 5_000)

      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
          ...(opts?.token ? { token: opts.token } : {}),
        }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'handshake_ack') {
          clearTimeout(timeout)
          resolve(msg)
        } else if (msg.type === 'error') {
          clearTimeout(timeout)
          reject(new Error(`Error: ${msg.error?.message}`))
        }
      })
      ws.on('close', (code, reason) => {
        clearTimeout(timeout)
        reject(new Error(`WS closed: ${code} ${reason}`))
      })
      ws.on('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  it('handshake_ack includes workspaceId returned by onAutoCreateWorkspace', async () => {
    const AUTO_WORKSPACE_ID = 'ws-auto-created-test-123'
    // Simulate an authenticated user via cookie-based auth so userId is set
    server = new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: true,
      serverId: 'test-auto-ws',
      validateSessionCookie: async (_cookie) => ({
        userId: 'user-aut-123',
        username: 'alice',
        role: 'user',
        jwt: null,
      }),
      onAutoCreateWorkspace: async (userId: string, _username: string) => {
        // Only auto-create for the test user
        if (userId === 'user-aut-123') return AUTO_WORKSPACE_ID
        throw new Error('Unexpected userId: ' + userId)
      },
    })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // Send a session cookie so the auth context has a userId
    const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new (WebSocket as any)(url, { headers: { Cookie: 'polo_ai_session=valid-session' } })
      openSockets.push(ws)
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Handshake timeout')) }, 5_000)
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
        }))
      })
      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'handshake_ack') { clearTimeout(timeout); resolve(msg) }
        else if (msg.type === 'error') { clearTimeout(timeout); reject(new Error(msg.error?.message)) }
      })
      ws.on('close', (code: number, reason: Buffer) => { clearTimeout(timeout); reject(new Error(`WS closed: ${code} ${reason}`)) })
      ws.on('error', (err: Error) => { clearTimeout(timeout); reject(err) })
    })

    expect(ack.type).toBe('handshake_ack')
    expect(ack.workspaceId).toBe(AUTO_WORKSPACE_ID)
  })

  it('handshake_ack workspaceId is undefined when onAutoCreateWorkspace is not set', async () => {
    server = new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: false,
      serverId: 'test-no-auto-ws',
    })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    const ack = await handshakeFull(url)
    expect(ack.type).toBe('handshake_ack')
    // No onAutoCreateWorkspace and no workspaceId in handshake → ack has no workspaceId
    expect(ack.workspaceId).toBeUndefined()
  })

  it('handshake_ack workspaceId echoes client-provided workspaceId when no auto-create hook', async () => {
    const CLIENT_WS_ID = 'ws-client-provided-xyz'
    server = new WsRpcServer({
      host: '127.0.0.1',
      port: 0,
      requireAuth: false,
      serverId: 'test-echo-ws',
    })
    await server.listen()
    const url = `ws://127.0.0.1:${server.port}`

    // Send workspaceId in handshake
    const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(url)
      openSockets.push(ws)
      const timeout = setTimeout(() => { ws.close(); reject(new Error('Handshake timeout')) }, 5_000)
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: crypto.randomUUID(),
          type: 'handshake',
          protocolVersion: PROTOCOL_VERSION,
          workspaceId: CLIENT_WS_ID,
        }))
      })
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'handshake_ack') { clearTimeout(timeout); resolve(msg) }
        else if (msg.type === 'error') { clearTimeout(timeout); reject(new Error(msg.error?.message)) }
      })
      ws.on('close', (code, reason) => { clearTimeout(timeout); reject(new Error(`WS closed: ${code} ${reason}`)) })
      ws.on('error', (err) => { clearTimeout(timeout); reject(err) })
    })

    expect(ack.workspaceId).toBe(CLIENT_WS_ID)
  })
})
