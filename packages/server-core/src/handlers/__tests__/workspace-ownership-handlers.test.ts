/**
 * workspace-ownership-handlers.test.ts
 *
 * AC4-AC7 handler integration tests.
 *
 * Verifies that workspace-scoped handlers call assertWorkspaceAccess before
 * proceeding, so unauthorized users get ForbiddenError.
 *
 * Uses subprocess isolation (like server-file-isolation.test.ts) to avoid
 * static CONFIG_DIR module-level baking issues.
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORKSPACE_ID = 'ws-test-ownership'
const OWNER_USER_ID = 'owner-user-1'
const OTHER_USER_ID = 'other-user-2'

interface OwnershipTestResult {
  ownerResult: 'pass' | 'forbidden' | 'error'
  otherResult: 'pass' | 'forbidden' | 'error'
  serverTokenResult: 'pass' | 'forbidden' | 'error'
  ownerError?: string
  otherError?: string
  serverTokenError?: string
}

/**
 * Run handler ownership test in a subprocess with a clean config dir.
 * Returns whether each identity (owner, other-user, server-token) passed or got FORBIDDEN.
 */
function runHandlerOwnershipTest(handlerModule: string, handlerFn: string, handlerChannel: string, args: string): OwnershipTestResult {
  const configDir = mkdtempSync(join(tmpdir(), 'polo-handler-ownership-config-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'polo-handler-ownership-home-'))
  const workspaceRootPath = join(homeDir, '.polo-ai', 'workspaces', 'test-ws')

  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `
      const configDir = ${JSON.stringify(configDir)};
      const homeDir = ${JSON.stringify(homeDir)};
      const workspaceRootPath = ${JSON.stringify(workspaceRootPath)};
      const WORKSPACE_ID = ${JSON.stringify(WORKSPACE_ID)};
      const OWNER_USER_ID = ${JSON.stringify(OWNER_USER_ID)};
      const OTHER_USER_ID = ${JSON.stringify(OTHER_USER_ID)};
      const HANDLER_CHANNEL = ${JSON.stringify(handlerChannel)};
      const ARGS = ${args};

      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');

      // Set up workspace filesystem
      mkdirSync(workspaceRootPath, { recursive: true });
      mkdirSync(join(workspaceRootPath, 'sources'), { recursive: true });
      mkdirSync(join(workspaceRootPath, 'sessions'), { recursive: true });
      mkdirSync(join(workspaceRootPath, 'skills'), { recursive: true });

      // Write workspace config with ownerUserId
      writeFileSync(join(workspaceRootPath, 'config.json'), JSON.stringify({
        id: WORKSPACE_ID,
        name: 'Test Workspace',
        slug: 'test-ws',
        ownerUserId: OWNER_USER_ID,
        defaults: { permissionMode: 'ask', cyclablePermissionModes: ['safe', 'ask', 'allow-all'], enabledSourceSlugs: [] },
        createdAt: 1000,
        updatedAt: 1000,
      }, null, 2), 'utf-8');

      // Write global config
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        workspaces: [{ id: WORKSPACE_ID, name: 'Test Workspace', slug: 'test-ws', rootPath: workspaceRootPath, createdAt: 1000 }],
        activeWorkspaceId: WORKSPACE_ID,
        activeSessionId: null,
      }, null, 2), 'utf-8');
      writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
        version: 'test', description: 'test defaults',
        defaults: { notificationsEnabled: true, colorTheme: 'default', autoCapitalisation: true, sendMessageKey: 'enter', spellCheck: false, keepAwakeWhileRunning: false, richToolDescriptions: true },
        workspaceDefaults: { permissionMode: 'ask', cyclablePermissionModes: ['safe', 'ask', 'allow-all'], localMcpServers: { enabled: true } },
      }, null, 2), 'utf-8');

      const handlers = new Map();
      const server = {
        handle(channel, handler) { handlers.set(channel, handler); },
        push() {},
        async invokeClient() { return undefined; },
        hasClientCapability() { return false; },
        findClientsWithCapability() { return []; },
      };

      const deps = {
        sessionManager: {
          waitForInit: async () => {},
          getSessions: () => [],
          getSession: async () => null,
          sendMessage: async () => {},
          getSession: async () => null,
          getWorkspaces: () => [],
          getWorkspacesInfo: () => [],
          getActiveSessionCount: () => 0,
          updateSessionModel: async () => {},
        },
        platform: { logger: { info() {}, warn() {}, error() {}, debug() {} }, appVersion: 'test', imageProcessor: { process: async () => Buffer.alloc(0), getMetadata: async () => null } },
        windowManager: undefined,
      };

      const handlerModule = await import(${JSON.stringify(handlerModule)});
      handlerModule.${handlerFn}(server, deps);

      const handler = handlers.get(HANDLER_CHANNEL);
      if (!handler) throw new Error('Handler not registered: ' + HANDLER_CHANNEL);

      function makeCtx(userId) {
        return { clientId: 'c1', workspaceId: WORKSPACE_ID, webContentsId: null, userId, username: userId, userRole: userId ? 'user' : null, userJwt: null };
      }

      async function test(userId) {
        try {
          await handler(makeCtx(userId), ...ARGS);
          return 'pass';
        } catch (err) {
          if (err && err.code === 'FORBIDDEN') return 'forbidden';
          return 'error:' + (err && err.message ? err.message : String(err));
        }
      }

      const ownerResult = await test(OWNER_USER_ID);
      const otherResult = await test(OTHER_USER_ID);
      const serverTokenResult = await test(null);

      console.log(JSON.stringify({ ownerResult, otherResult, serverTokenResult }));
    `,
  ], {
    env: {
      ...process.env,
      HOME: homeDir,
      POLO_AI_CONFIG_DIR: configDir,
      PLATFORM_ANTHROPIC_API_KEY: undefined,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  try {
    if (run.exitCode !== 0) {
      throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
    }
    return JSON.parse(run.stdout.toString())
  } finally {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// AC5: workspace:settings calls assertWorkspaceAccess
// ---------------------------------------------------------------------------

describe('AC5: workspace:settings handler calls assertWorkspaceAccess', () => {
  it('settings:get → owner passes, other user gets FORBIDDEN, server-token passes', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/settings.ts',
      'registerSettingsHandlers',
      RPC_CHANNELS.workspace.SETTINGS_GET,
      `[${JSON.stringify(WORKSPACE_ID)}]`
    )
    // Owner should pass (or return null/data, not FORBIDDEN)
    expect(result.ownerResult).not.toBe('forbidden')
    // Other user should be FORBIDDEN
    expect(result.otherResult).toBe('forbidden')
    // Server-token (userId=null) should pass
    expect(result.serverTokenResult).not.toBe('forbidden')
  })

  it('settings:update → owner passes, other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/settings.ts',
      'registerSettingsHandlers',
      RPC_CHANNELS.workspace.SETTINGS_UPDATE,
      `[${JSON.stringify(WORKSPACE_ID)}, 'name', 'New Name']`
    )
    expect(result.ownerResult).not.toBe('forbidden')
    expect(result.otherResult).toBe('forbidden')
    expect(result.serverTokenResult).not.toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------
// AC4: sessions:sendMessage calls assertWorkspaceAccess
// ---------------------------------------------------------------------------

describe('AC4: sessions:sendMessage calls assertWorkspaceAccess', () => {
  it('sessions:getMessages → owner passes, other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/sessions.ts',
      'registerSessionsHandlers',
      RPC_CHANNELS.sessions.GET_MESSAGES,
      `['session-1']`
    )
    expect(result.ownerResult).not.toBe('forbidden')
    expect(result.otherResult).toBe('forbidden')
    expect(result.serverTokenResult).not.toBe('forbidden')
  })

  it('sessions:sendMessage → owner passes, other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/sessions.ts',
      'registerSessionsHandlers',
      RPC_CHANNELS.sessions.SEND_MESSAGE,
      `['session-1', 'hello']`
    )
    expect(result.ownerResult).not.toBe('forbidden')
    expect(result.otherResult).toBe('forbidden')
    expect(result.serverTokenResult).not.toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------
// AC6: files:read calls assertWorkspaceAccess
// ---------------------------------------------------------------------------

describe('AC6: files:read calls assertWorkspaceAccess', () => {
  it('file:read → owner passes (may fail on path), other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/files.ts',
      'registerFilesHandlers',
      RPC_CHANNELS.file.READ,
      `['/nonexistent/path']`
    )
    // Owner should not get FORBIDDEN (will get path error)
    expect(result.ownerResult).not.toBe('forbidden')
    // Other user should be FORBIDDEN
    expect(result.otherResult).toBe('forbidden')
    // Server-token (userId=null) should not get FORBIDDEN
    expect(result.serverTokenResult).not.toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------
// AC7: workspace:sources calls assertWorkspaceAccess
// ---------------------------------------------------------------------------

describe('AC7: workspace:sources calls assertWorkspaceAccess', () => {
  it('sources:get → owner passes, other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/sources.ts',
      'registerSourcesHandlers',
      RPC_CHANNELS.sources.GET,
      `[${JSON.stringify(WORKSPACE_ID)}]`
    )
    expect(result.ownerResult).not.toBe('forbidden')
    expect(result.otherResult).toBe('forbidden')
    expect(result.serverTokenResult).not.toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------
// AC4: sessions:listSessions only returns sessions for ctx.userId's workspaces
// ---------------------------------------------------------------------------

describe('AC4: sessions:listSessions only returns sessions for ctx.userId workspaces', () => {
  it('sessions:get filters sessions by owning user', () => {
    const configDir = require('node:os').tmpdir() + '/polo-session-filter-config-' + Date.now()
    const homeDir = require('node:os').tmpdir() + '/polo-session-filter-home-' + Date.now()

    const run = Bun.spawnSync([
      process.execPath,
      '--eval',
      `
        const configDir = ${JSON.stringify(configDir)};
        const homeDir = ${JSON.stringify(homeDir)};
        const OWNER_A = 'user-a-sessions';
        const OWNER_B = 'user-b-sessions';
        const WS_A = 'ws-for-user-a';
        const WS_B = 'ws-for-user-b';

        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');

        const wsARootPath = join(homeDir, '.polo-ai', 'workspaces', 'ws-a');
        const wsBRootPath = join(homeDir, '.polo-ai', 'workspaces', 'ws-b');

        // Set up workspace filesystems
        for (const [rootPath, id, ownerUserId] of [[wsARootPath, WS_A, OWNER_A], [wsBRootPath, WS_B, OWNER_B]]) {
          mkdirSync(join(rootPath, 'sessions'), { recursive: true });
          writeFileSync(join(rootPath, 'config.json'), JSON.stringify({
            id, name: 'Workspace ' + id, slug: id, ownerUserId,
            defaults: { permissionMode: 'ask', cyclablePermissionModes: ['safe', 'ask', 'allow-all'], enabledSourceSlugs: [] },
            createdAt: 1000, updatedAt: 1000,
          }, null, 2), 'utf-8');
        }

        mkdirSync(configDir, { recursive: true });
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
          workspaces: [
            { id: WS_A, name: 'WS A', slug: 'ws-a', rootPath: wsARootPath, createdAt: 1000 },
            { id: WS_B, name: 'WS B', slug: 'ws-b', rootPath: wsBRootPath, createdAt: 1000 },
          ],
          activeWorkspaceId: WS_A, activeSessionId: null,
        }, null, 2), 'utf-8');
        writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
          version: 'test', description: 'test',
          defaults: { notificationsEnabled: true, colorTheme: 'default', autoCapitalisation: true, sendMessageKey: 'enter', spellCheck: false, keepAwakeWhileRunning: false, richToolDescriptions: true },
          workspaceDefaults: { permissionMode: 'ask', cyclablePermissionModes: ['safe', 'ask', 'allow-all'], localMcpServers: { enabled: true } },
        }, null, 2), 'utf-8');

        // Mock session data: one session per workspace
        const sessionA = { id: 'session-in-ws-a', workspaceId: WS_A, title: 'Session A' };
        const sessionB = { id: 'session-in-ws-b', workspaceId: WS_B, title: 'Session B' };

        const handlers = new Map();
        const server = {
          handle(channel, handler) { handlers.set(channel, handler); },
          push() {},
          async invokeClient() { return undefined; },
          hasClientCapability() { return false; },
          findClientsWithCapability() { return []; },
        };

        const deps = {
          sessionManager: {
            waitForInit: async () => {},
            getSessions: (wsId) => wsId ? (wsId === WS_A ? [sessionA] : wsId === WS_B ? [sessionB] : []) : [sessionA, sessionB],
            getWorkspaces: () => [],
          },
          platform: { logger: { info() {}, warn() {}, error() {}, debug() {} }, appVersion: 'test' },
          windowManager: undefined,
        };

        const { registerSessionsHandlers } = await import('./packages/server-core/src/handlers/rpc/sessions.ts');
        registerSessionsHandlers(server, deps);
        const handler = handlers.get('sessions:get');
        if (!handler) throw new Error('sessions:get handler not registered');

        function makeCtx(userId, wsId) {
          return { clientId: 'c1', workspaceId: wsId ?? null, webContentsId: null, userId, username: userId, userRole: userId ? 'user' : null, userJwt: null };
        }

        // Owner A should only see sessions from WS_A (filtered by ownership)
        const sessionsForA = await handler(makeCtx(OWNER_A, null));
        const sessionAInResult = sessionsForA.some(s => s.id === 'session-in-ws-a');
        const sessionBInResultForA = sessionsForA.some(s => s.id === 'session-in-ws-b');

        // Owner B should only see sessions from WS_B
        const sessionsForB = await handler(makeCtx(OWNER_B, null));
        const sessionBInResultForB = sessionsForB.some(s => s.id === 'session-in-ws-b');
        const sessionAInResultForB = sessionsForB.some(s => s.id === 'session-in-ws-a');

        // Server token (userId=null) should see all sessions
        const sessionsForServer = await handler(makeCtx(null, null));
        const allVisible = sessionsForServer.length >= 2 ||
          (sessionsForServer.some(s => s.id === 'session-in-ws-a') && sessionsForServer.some(s => s.id === 'session-in-ws-b'));

        console.log(JSON.stringify({
          sessionAVisibleToA: sessionAInResult,
          sessionBVisibleToA: sessionBInResultForA,
          sessionBVisibleToB: sessionBInResultForB,
          sessionAVisibleToB: sessionAInResultForB,
          serverTokenSeesAll: allVisible,
        }));
      `,
    ], {
      env: {
        ...process.env,
        HOME: homeDir,
        POLO_AI_CONFIG_DIR: configDir,
        PLATFORM_ANTHROPIC_API_KEY: undefined,
      },
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    try {
      if (run.exitCode !== 0) {
        throw new Error('subprocess failed:\n' + run.stderr.toString())
      }
      const result = JSON.parse(run.stdout.toString())
      // Owner A should see session A
      expect(result.sessionAVisibleToA).toBe(true)
      // Owner A should NOT see session B (different workspace, different owner)
      expect(result.sessionBVisibleToA).toBe(false)
      // Owner B should see session B
      expect(result.sessionBVisibleToB).toBe(true)
      // Owner B should NOT see session A
      expect(result.sessionAVisibleToB).toBe(false)
      // Server token should see all sessions
      expect(result.serverTokenSeesAll).toBe(true)
    } finally {
      require('node:fs').rmSync(configDir, { recursive: true, force: true })
      require('node:fs').rmSync(homeDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// AC5: workspace:getWorkspace and workspace:listWorkspaces ownership
// ---------------------------------------------------------------------------

describe('AC5: workspace:getWorkspace calls assertWorkspaceAccess', () => {
  it('window:getWorkspace → owner passes, other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/workspace.ts',
      'registerWorkspaceCoreHandlers',
      RPC_CHANNELS.window.GET_WORKSPACE,
      `[]`
    )
    // Owner should pass (or return workspace ID)
    expect(result.ownerResult).not.toBe('forbidden')
    // Other user should be FORBIDDEN
    expect(result.otherResult).toBe('forbidden')
    // Server-token (userId=null) should pass
    expect(result.serverTokenResult).not.toBe('forbidden')
  })
})

describe('AC5: workspace:updateWorkspace calls assertWorkspaceAccess', () => {
  it('workspaces:updateRemote → owner passes, other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/workspace.ts',
      'registerWorkspaceCoreHandlers',
      RPC_CHANNELS.workspaces.UPDATE_REMOTE,
      `[${JSON.stringify(WORKSPACE_ID)}, { url: 'https://example.com', token: 'tok', remoteWorkspaceId: 'rws' }]`
    )
    expect(result.ownerResult).not.toBe('forbidden')
    expect(result.otherResult).toBe('forbidden')
    expect(result.serverTokenResult).not.toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------
// AC6: files:write does not exist (no write channel in protocol)
// ---------------------------------------------------------------------------

describe('AC6: files:write channel absence', () => {
  it('RPC_CHANNELS has no file:write channel — write operations go through session tools not RPC', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    // The protocol deliberately has no file:write channel.
    // File mutations are handled by the agent (Claude/Pi) via session tools,
    // not exposed as direct RPC endpoints. This test documents that contract.
    expect((RPC_CHANNELS.file as Record<string, string>).WRITE).toBeUndefined()
    // Only read channels exist
    expect(RPC_CHANNELS.file.READ).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC7: sessions:export/import call assertWorkspaceAccess
// ---------------------------------------------------------------------------

describe('AC7: sessions:export calls assertWorkspaceAccess', () => {
  it('sessions:export → owner passes (or export error), other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/sessions.ts',
      'registerSessionsHandlers',
      RPC_CHANNELS.sessions.EXPORT,
      `['session-1']`
    )
    expect(result.ownerResult).not.toBe('forbidden')
    expect(result.otherResult).toBe('forbidden')
    expect(result.serverTokenResult).not.toBe('forbidden')
  })

  it('sessions:import → owner passes, other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/sessions.ts',
      'registerSessionsHandlers',
      RPC_CHANNELS.sessions.IMPORT,
      `[${JSON.stringify(WORKSPACE_ID)}, {}, 'fork']`
    )
    expect(result.ownerResult).not.toBe('forbidden')
    expect(result.otherResult).toBe('forbidden')
    expect(result.serverTokenResult).not.toBe('forbidden')
  })
})

describe('AC7: skills:get calls assertWorkspaceAccess', () => {
  it('skills:get → owner passes, other user gets FORBIDDEN', () => {
    const { RPC_CHANNELS } = require('@polo-ai/shared/protocol')
    const result = runHandlerOwnershipTest(
      './packages/server-core/src/handlers/rpc/skills.ts',
      'registerSkillsHandlers',
      RPC_CHANNELS.skills.GET,
      `[${JSON.stringify(WORKSPACE_ID)}]`
    )
    expect(result.ownerResult).not.toBe('forbidden')
    expect(result.otherResult).toBe('forbidden')
    expect(result.serverTokenResult).not.toBe('forbidden')
  })
})
