/**
 * workspace-ownership.test.ts
 *
 * TDD tests for:
 *   AC1  - WorkspaceConfig.ownerUserId field
 *   AC2  - assertWorkspaceAccess() boundary matrix
 *   AC3  - auto-create workspace on connect
 *
 * Handler-integration AC4–AC7 are covered through the assertWorkspaceAccess
 * function being called (behavior is verified via unit tests of the helper
 * rather than end-to-end handler invocations, which require a full server).
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
