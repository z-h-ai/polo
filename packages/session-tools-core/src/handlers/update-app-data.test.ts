import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { handleUpdateAppData, resolveAppDataWriteTarget } from './update-app-data.ts';
import { UpdateAppDataSchema, UPDATE_APP_DATA_MAX_BYTES } from '../tool-defs.ts';

// ============================================================
// Schema
// ============================================================

describe('UpdateAppDataSchema', () => {
  it('accepts an object-shaped update', () => {
    const parsed = UpdateAppDataSchema.safeParse({ appId: 'app-1a2b', dataSrc: 'state.json', data: { rows: [1, 2] } });
    expect(parsed.success).toBe(true);
  });

  it('rejects app ids that are not generate_app ids', () => {
    expect(UpdateAppDataSchema.safeParse({ appId: '../escape', dataSrc: 'a.json', data: {} }).success).toBe(false);
    expect(UpdateAppDataSchema.safeParse({ appId: '', dataSrc: 'a.json', data: {} }).success).toBe(false);
    expect(UpdateAppDataSchema.safeParse({ appId: 'has space', dataSrc: 'a.json', data: {} }).success).toBe(false);
  });

  it('rejects missing/oversized dataSrc', () => {
    expect(UpdateAppDataSchema.safeParse({ appId: 'app-1', dataSrc: '', data: {} }).success).toBe(false);
    expect(UpdateAppDataSchema.safeParse({ appId: 'app-1', dataSrc: `${'x'.repeat(2000)}.json`, data: {} }).success).toBe(false);
  });
});

// ============================================================
// resolveAppDataWriteTarget — the data/ write fence
// ============================================================

describe('resolveAppDataWriteTarget', () => {
  let rootDir: string;
  let dataDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'update-app-data-fence-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('resolves a simple relative path inside data/', () => {
    const verdict = resolveAppDataWriteTarget(dataDir, 'state.json');
    expect(verdict).toEqual({ ok: true, target: join(dataDir, 'state.json') });
  });

  it('resolves a nested relative path inside data/', () => {
    const verdict = resolveAppDataWriteTarget(dataDir, 'nested/state.json');
    expect(verdict).toEqual({ ok: true, target: join(dataDir, 'nested', 'state.json') });
  });

  it('accepts an absolute path that is already inside data/', () => {
    const verdict = resolveAppDataWriteTarget(dataDir, join(dataDir, 'state.json'));
    expect(verdict.ok).toBe(true);
  });

  it('rejects `..` escapes', () => {
    expect(resolveAppDataWriteTarget(dataDir, '../outside.json').ok).toBe(false);
    expect(resolveAppDataWriteTarget(dataDir, 'nested/../../outside.json').ok).toBe(false);
  });

  it('rejects absolute paths outside data/', () => {
    expect(resolveAppDataWriteTarget(dataDir, join(rootDir, 'outside.json')).ok).toBe(false);
  });

  it('rejects a symlink inside data/ pointing outside (target exists)', () => {
    writeFileSync(join(rootDir, 'secret.json'), '{}', 'utf-8');
    symlinkSync(join(rootDir, 'secret.json'), join(dataDir, 'state.json'));
    expect(resolveAppDataWriteTarget(dataDir, 'state.json').ok).toBe(false);
  });

  it('rejects a symlinked intermediate directory pointing outside', () => {
    const realDir = join(rootDir, 'elsewhere');
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(dataDir, 'link'));
    expect(resolveAppDataWriteTarget(dataDir, 'link/state.json').ok).toBe(false);
  });

  it('rejects NUL-carrying paths', () => {
    expect(resolveAppDataWriteTarget(dataDir, 'state\0.json').ok).toBe(false);
  });
});

// ============================================================
// handleUpdateAppData
// ============================================================

describe('handleUpdateAppData', () => {
  let rootDir: string;
  let dataDir: string;

  function ctx(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
    return {
      sessionId: 'test-session',
      workspacePath: rootDir,
      sourcesPath: join(rootDir, 'sources'),
      skillsPath: join(rootDir, 'skills'),
      plansFolderPath: join(rootDir, 'session', 'plans'),
      callbacks: {
        onPlanSubmitted: () => {},
        onAuthRequest: () => {},
      },
      fs: {
        exists: () => false,
        readFile: () => '',
        readFileBuffer: () => Buffer.from(''),
        writeFile: () => {},
        isDirectory: () => false,
        readdir: () => [],
        stat: () => ({ size: 0, isDirectory: () => false }),
      },
      loadSourceConfig: () => null,
      dataPath: dataDir,
      ...overrides,
    };
  }

  function createApp(appId = 'app-1a2b3c4d'): string {
    const appDir = join(dataDir, 'genui-apps', appId);
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'index.html'), '<html><body>app</body></html>', 'utf-8');
    return appDir;
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'update-app-data-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('writes the JSON atomically and reports the update', async () => {
    createApp();
    const result = await handleUpdateAppData(ctx(), { appId: 'app-1a2b3c4d', dataSrc: 'state.json', data: { rows: [1, 2] } });
    expect(result.isError).toBeFalsy();
    const raw = readFileSync(join(dataDir, 'state.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({ rows: [1, 2] });
    // No temp leftovers: the atomic swap completed.
    expect(readdirSync(dataDir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('creates nested destination directories inside data/', async () => {
    createApp();
    const result = await handleUpdateAppData(ctx(), { appId: 'app-1a2b3c4d', dataSrc: 'nested/deep/state.json', data: { ok: true } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(readFileSync(join(dataDir, 'nested', 'deep', 'state.json'), 'utf-8'))).toEqual({ ok: true });
  });

  it('notifies the host with the app id and the absolute written path', async () => {
    createApp();
    const notified: Array<{ appId: string; dataPath: string }> = [];
    const result = await handleUpdateAppData(ctx({
      notifyCanvasAppDataUpdated: (appId, dataPath) => notified.push({ appId, dataPath }),
    }), { appId: 'app-1a2b3c4d', dataSrc: 'state.json', data: { v: 2 } });
    expect(result.isError).toBeFalsy();
    expect(notified).toEqual([{ appId: 'app-1a2b3c4d', dataPath: join(dataDir, 'state.json') }]);
    expect(result.content[0]?.text).toContain('pushed to the mounted app card');
  });

  it('reports a declared-path push as delivered', async () => {
    createApp();
    const result = await handleUpdateAppData(ctx({
      notifyCanvasAppDataUpdated: () => 2,
    }), { appId: 'app-1a2b3c4d', dataSrc: 'state.json', data: { v: 3 } });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('pushed to the mounted app card');
  });

  it('reports an undeclared-path update as storage-only (review P1-1)', async () => {
    createApp();
    const result = await handleUpdateAppData(ctx({
      notifyCanvasAppDataUpdated: () => 0,
    }), { appId: 'app-1a2b3c4d', dataSrc: 'scratch.json', data: { v: 4 } });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain('polo-app-data');
    expect(result.content[0]?.text).toContain('session-storage only');
  });

  it('writes to disk only when no canvas surface is wired (unmounted / non-desktop)', async () => {
    createApp();
    const result = await handleUpdateAppData(ctx(), { appId: 'app-1a2b3c4d', dataSrc: 'state.json', data: { v: 1 } });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf-8'))).toEqual({ v: 1 });
    expect(result.content[0]?.text).toContain('injected when the card next attaches');
  });

  it('rejects an unknown appId and creates nothing', async () => {
    const result = await handleUpdateAppData(ctx(), { appId: 'app-does-not-exist', dataSrc: 'state.json', data: {} });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('App not found');
    expect(existsSync(join(dataDir, 'state.json'))).toBe(false);
  });

  it('rejects dataSrc escapes and writes nothing', async () => {
    createApp();
    const result = await handleUpdateAppData(ctx(), { appId: 'app-1a2b3c4d', dataSrc: '../outside.json', data: { evil: true } });
    expect(result.isError).toBe(true);
    expect(existsSync(join(rootDir, 'outside.json'))).toBe(false);
  });

  it('rejects updates above the 1MB cap', async () => {
    createApp();
    const big = { blob: 'x'.repeat(UPDATE_APP_DATA_MAX_BYTES) };
    const result = await handleUpdateAppData(ctx(), { appId: 'app-1a2b3c4d', dataSrc: 'big.json', data: big });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('hard limit');
    expect(existsSync(join(dataDir, 'big.json'))).toBe(false);
  });

  it('refuses to run when the canvas toggle is off at call time', async () => {
    createApp();
    const result = await handleUpdateAppData(ctx({ isGenerateAppEnabled: () => false }), { appId: 'app-1a2b3c4d', dataSrc: 'state.json', data: {} });
    expect(result.isError).toBe(true);
    expect(existsSync(join(dataDir, 'state.json'))).toBe(false);
  });

  it('refuses to run without a session data directory', async () => {
    const result = await handleUpdateAppData(ctx({ dataPath: undefined }), { appId: 'app-1', dataSrc: 'state.json', data: {} });
    expect(result.isError).toBe(true);
  });
});
