import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href;

function setupConfig() {
  const configDir = mkdtempSync(join(tmpdir(), 'polo-config-workspace-isolation-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'polo-home-workspace-isolation-'));
  const legacyRoot = join(homeDir, '.polo-ai', 'workspaces', 'ws1');
  const abcRoot = join(homeDir, '.polo-ai', 'users', 'abc', 'workspaces', 'ws1');
  const defRoot = join(homeDir, '.polo-ai', 'users', 'def', 'workspaces', 'ws1');

  for (const [rootPath, id, name] of [
    [legacyRoot, 'legacy', 'Legacy Workspace'],
    [abcRoot, 'abc-ws', 'ABC Workspace'],
    [defRoot, 'def-ws', 'DEF Workspace'],
  ] as const) {
    mkdirSync(rootPath, { recursive: true });
    writeFileSync(
      join(rootPath, 'config.json'),
      JSON.stringify({ id, name, slug: 'ws1', defaults: {}, createdAt: 1, updatedAt: 1 }, null, 2),
      'utf-8',
    );
  }

  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.json'),
    JSON.stringify({
      workspaces: [
        { id: 'legacy', name: 'Legacy Workspace', rootPath: legacyRoot, createdAt: 1 },
        { id: 'abc-ws', name: 'ABC Workspace', rootPath: abcRoot, createdAt: 1 },
        { id: 'def-ws', name: 'DEF Workspace', rootPath: defRoot, createdAt: 1 },
      ],
      activeWorkspaceId: 'abc-ws',
      activeSessionId: null,
      llmConnections: [],
    }, null, 2),
    'utf-8',
  );

  return { configDir, homeDir };
}

function runGetWorkspaces(configDir: string, homeDir: string, platform: boolean, userId: string | null): string[] {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getWorkspaces } from '${STORAGE_MODULE_PATH}'; console.log(JSON.stringify(getWorkspaces(${JSON.stringify(userId)}).map(w => w.id)));`,
  ], {
    env: {
      ...process.env,
      HOME: homeDir,
      POLO_AI_CONFIG_DIR: configDir,
      PLATFORM_ANTHROPIC_API_KEY: platform ? 'test-platform-key' : '',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  if (run.exitCode !== 0) {
    throw new Error(`getWorkspaces subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`);
  }

  return JSON.parse(run.stdout.toString());
}

describe('workspace registry: platform user isolation', () => {
  it('filters global workspace registry entries to the current platform userId', () => {
    const { configDir, homeDir } = setupConfig();
    try {
      expect(runGetWorkspaces(configDir, homeDir, true, 'abc')).toEqual(['abc-ws']);
      expect(runGetWorkspaces(configDir, homeDir, true, 'def')).toEqual(['def-ws']);
      expect(runGetWorkspaces(configDir, homeDir, true, null)).toEqual(['legacy']);
      expect(runGetWorkspaces(configDir, homeDir, false, 'abc')).toEqual(['legacy', 'abc-ws', 'def-ws']);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
