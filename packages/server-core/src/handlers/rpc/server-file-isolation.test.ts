import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
function runServerIsolationScenario(): { listedUserId: string | null; createdRootPath: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'polo-server-config-isolation-'))
  const homeDir = mkdtempSync(join(tmpdir(), 'polo-server-home-isolation-'))

  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `
      const configDir = ${JSON.stringify(configDir)};
      const homeDir = ${JSON.stringify(homeDir)};
      const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { RPC_CHANNELS } = await import('@polo-ai/shared/protocol');
      const { registerServerHandlers } = await import('./packages/server-core/src/handlers/rpc/server.ts');
      const { getWorkspaces } = await import('@polo-ai/shared/config');

      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        workspaces: [],
        activeWorkspaceId: null,
        activeSessionId: null,
        llmConnections: [],
      }, null, 2), 'utf-8');
      writeFileSync(join(configDir, 'config-defaults.json'), JSON.stringify({
        version: 'test',
        description: 'test defaults',
        defaults: {
          notificationsEnabled: true,
          colorTheme: 'default',
          autoCapitalisation: true,
          sendMessageKey: 'enter',
          spellCheck: false,
          keepAwakeWhileRunning: false,
          richToolDescriptions: true,
        },
        workspaceDefaults: {
          permissionMode: 'ask',
          cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
          localMcpServers: { enabled: true },
        },
      }, null, 2), 'utf-8');

      let listedUserId = null;
      const handlers = new Map();
      const server = {
        handle(channel, handler) { handlers.set(channel, handler); },
        push() {},
        async invokeClient() { return undefined; },
        hasClientCapability() { return false; },
        findClientsWithCapability() { return []; },
      };
      const sessionManager = {
        getWorkspacesInfo(userId) {
          listedUserId = userId;
          return getWorkspaces(userId).map(({ rootPath: _rootPath, createdAt: _createdAt, ...info }) => info);
        },
        getWorkspaceAutomationSummary() { return { automationCount: 0, schedulerRunning: false }; },
        getActiveSessionCount() { return 0; },
        getActiveSessionsInfo() { return []; },
        getWorkspaces() { return getWorkspaces(); },
      };

      registerServerHandlers(
        server,
        { sessionManager, platform: { logger: { info() {}, warn() {}, error() {}, debug() {} }, appVersion: 'test' } },
        {
          serverId: 'server-1',
          startedAt: Date.now(),
          getConnectedClientCount: () => 1,
          headlessOptions: {},
          serverRuntime: null,
        },
      );

      const ctx = {
        clientId: 'client-1',
        workspaceId: null,
        webContentsId: null,
        userId: 'abc',
        username: 'alice',
        userRole: 'admin',
        userJwt: 'jwt',
      };

      await handlers.get(RPC_CHANNELS.server.GET_WORKSPACES)(ctx);
      await handlers.get(RPC_CHANNELS.server.CREATE_WORKSPACE)(ctx, 'Workspace One');

      const config = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf-8'));
      const createdRootPath = config.workspaces[0].rootPath.replace('~', homeDir);
      console.log(JSON.stringify({ listedUserId, createdRootPath }));
    `,
  ], {
    env: {
      ...process.env,
      HOME: homeDir,
      POLO_AI_CONFIG_DIR: configDir,
      PLATFORM_ANTHROPIC_API_KEY: 'test-platform-key',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  try {
    if (run.exitCode !== 0) {
      throw new Error(`server isolation subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
    }

    return JSON.parse(run.stdout.toString())
  } finally {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  }
}

describe('server workspace RPC file isolation', () => {
  it('uses request userId for platform workspace listing and creation', () => {
    const result = runServerIsolationScenario()

    expect(result.listedUserId).toBe('abc')
    expect(result.createdRootPath).toBe(join(result.createdRootPath.split('/.polo-ai/')[0], '.polo-ai', 'users', 'abc', 'workspaces', 'workspace-one'))
  })
})
