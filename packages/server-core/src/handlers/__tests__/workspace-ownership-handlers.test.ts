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
