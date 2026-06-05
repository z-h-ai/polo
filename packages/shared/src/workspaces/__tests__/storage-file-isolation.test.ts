import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkspacePath, loadWorkspaceConfig, saveWorkspaceConfig } from '../storage.ts';

const ORIGINAL_PLATFORM_ANTHROPIC_API_KEY = process.env.PLATFORM_ANTHROPIC_API_KEY;
const tempDirs: string[] = [];

function setPlatformMode(enabled: boolean) {
  if (enabled) process.env.PLATFORM_ANTHROPIC_API_KEY = 'test-platform-key';
  else delete process.env.PLATFORM_ANTHROPIC_API_KEY;
}

afterEach(() => {
  if (ORIGINAL_PLATFORM_ANTHROPIC_API_KEY === undefined) {
    delete process.env.PLATFORM_ANTHROPIC_API_KEY;
  } else {
    process.env.PLATFORM_ANTHROPIC_API_KEY = ORIGINAL_PLATFORM_ANTHROPIC_API_KEY;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace storage: platform user isolation', () => {
  it('resolves platform workspace paths under the userId workspace directory', () => {
    setPlatformMode(true);

    expect(getWorkspacePath('abc', 'ws1')).toBe(join(homedir(), '.polo-ai', 'users', 'abc', 'workspaces', 'ws1'));
    expect(getWorkspacePath('def', 'ws1')).toBe(join(homedir(), '.polo-ai', 'users', 'def', 'workspaces', 'ws1'));
    expect(getWorkspacePath('abc', 'ws1')).not.toBe(getWorkspacePath('def', 'ws1'));
  });

  it('falls back to the legacy workspace path without a platform userId', () => {
    setPlatformMode(true);

    expect(getWorkspacePath(null, 'ws1')).toBe(join(homedir(), '.polo-ai', 'workspaces', 'ws1'));
  });

  it('keeps non-platform workspace paths unchanged', () => {
    setPlatformMode(false);

    expect(getWorkspacePath('abc', 'ws1')).toBe(join(homedir(), '.polo-ai', 'workspaces', 'ws1'));
  });

  it('rejects path traversal in userId and slug components', () => {
    setPlatformMode(true);

    expect(() => getWorkspacePath('../etc', 'ws1')).toThrow('Invalid userId');
    expect(() => getWorkspacePath('abc', '../ws1')).toThrow('Invalid workspace slug');
    expect(() => getWorkspacePath('abc/def', 'ws1')).toThrow('Invalid userId');
    expect(() => getWorkspacePath('abc', 'ws\u00001')).toThrow('Invalid workspace slug');
  });

  it('loads workspace config regardless of legacy or user-scoped path location', () => {
    const root = mkdtempSync(join(tmpdir(), 'polo-workspace-paths-'));
    tempDirs.push(root);
    const legacyRoot = join(root, 'workspaces', 'ws1');
    const userRoot = join(root, 'users', 'abc', 'workspaces', 'ws1');
    mkdirSync(legacyRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });

    saveWorkspaceConfig(legacyRoot, {
      id: 'legacy',
      name: 'Legacy Workspace',
      slug: 'ws1',
      defaults: {},
      createdAt: 1,
      updatedAt: 1,
    });
    saveWorkspaceConfig(userRoot, {
      id: 'user-scoped',
      name: 'User Workspace',
      slug: 'ws1',
      defaults: {},
      createdAt: 1,
      updatedAt: 1,
    });

    expect(existsSync(join(legacyRoot, 'config.json'))).toBe(true);
    expect(existsSync(join(userRoot, 'config.json'))).toBe(true);
    expect(loadWorkspaceConfig(legacyRoot)?.id).toBe('legacy');
    expect(loadWorkspaceConfig(userRoot)?.id).toBe('user-scoped');
  });
});
