import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { handleRenderUi } from './render-ui.ts';
import {
  RenderUiSchema,
  RENDER_UI_MAX_PAYLOAD_BYTES,
} from '../tool-defs.ts';

// ============================================================
// Schema validation
// ============================================================

describe('render_ui schema validation', () => {
  it('accepts a valid stat-card payload', () => {
    const result = RenderUiSchema.safeParse({
      components: [{
        id: 'rev',
        type: 'stat-card',
        title: 'Q3 Revenue',
        label: 'Total revenue',
        value: 4200000,
        unit: 'USD',
        delta: 0.152,
        trend: 'up',
      }],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a valid data-table payload with src file reference', () => {
    const result = RenderUiSchema.safeParse({
      components: [{
        id: 'sales',
        type: 'data-table',
        title: 'Sales by Region',
        columns: [
          { key: 'region', label: 'Region', type: 'text' },
          { key: 'revenue', label: 'Revenue', type: 'currency' },
          { key: 'growth', label: 'YoY Growth', type: 'percent' },
        ],
        src: '/abs/path/sales_by_region.json',
        pageSize: 20,
      }],
    });

    expect(result.success).toBe(true);
  });

  it('accepts a valid action-buttons payload with both action kinds', () => {
    const result = RenderUiSchema.safeParse({
      components: [{
        id: 'next',
        type: 'action-buttons',
        title: 'Next steps',
        buttons: [
          {
            id: 'drill',
            label: 'Drill into EMEA',
            style: 'primary',
            action: { kind: 'send-message', prompt: 'Break down EMEA revenue by country for Q3' },
          },
          {
            id: 'export',
            label: 'Export as CSV',
            action: { kind: 'fill-input', text: 'Export the sales table as CSV to data/' },
          },
        ],
      }],
    });

    expect(result.success).toBe(true);
  });

  it('rejects payloads over the 4KB hard threshold', () => {
    const payload = {
      components: [{
        id: 'big',
        type: 'alert',
        severity: 'info',
        message: 'x'.repeat(RENDER_UI_MAX_PAYLOAD_BYTES),
      }],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    expect(bytes).toBeGreaterThan(RENDER_UI_MAX_PAYLOAD_BYTES);

    const result = RenderUiSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('exceeds'))).toBe(true);
    }
  });

  it('rejects duplicate component ids within one call', () => {
    const result = RenderUiSchema.safeParse({
      components: [
        { id: 'dup', type: 'alert', severity: 'info', message: 'first' },
        { id: 'dup', type: 'alert', severity: 'warning', message: 'second' },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('Duplicate component id'))).toBe(true);
    }
  });

  it('rejects a data-table component with inline rows', () => {
    const result = RenderUiSchema.safeParse({
      components: [{
        id: 'inline',
        type: 'data-table',
        columns: [{ key: 'name', label: 'Name' }],
        src: 'out.json',
        rows: [{ name: 'Alice' }],
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('rows'))).toBe(true);
    }
  });

  it('rejects unknown component types', () => {
    const result = RenderUiSchema.safeParse({
      components: [{ id: 'x', type: 'chart', data: [1, 2, 3] }],
    });

    expect(result.success).toBe(false);
  });
});

// ============================================================
// Handler fail-closed paths
// ============================================================

describe('render_ui handler', () => {
  let rootDir: string;
  let sessionDir: string;
  let dataDir: string;
  let siblingDir: string;

  function ctx(overrides: Partial<SessionToolContext> = {}): SessionToolContext {
    return {
      sessionId: 'test-session',
      workspacePath: rootDir,
      sourcesPath: join(rootDir, 'sources'),
      skillsPath: join(rootDir, 'skills'),
      plansFolderPath: join(sessionDir, 'plans'),
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
      sessionPath: sessionDir,
      dataPath: dataDir,
      ...overrides,
    };
  }

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'render-ui-boundary-'));
    sessionDir = join(rootDir, 'session');
    dataDir = join(sessionDir, 'data');
    siblingDir = join(rootDir, 'session-evil');

    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });

    writeFileSync(join(dataDir, 'sales.json'), JSON.stringify({ rows: [] }));
    writeFileSync(join(siblingDir, 'outside.json'), '{"evil":true}');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('accepts a stat-card payload without a data directory', async () => {
    const result = await handleRenderUi(ctx({ dataPath: undefined }), {
      components: [{ id: 'rev', type: 'stat-card', label: 'Total', value: 42 }],
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('stat-card "rev"');
  });

  it('accepts a data-table whose src resolves inside the session data dir', async () => {
    const result = await handleRenderUi(ctx(), {
      components: [{
        id: 'sales',
        type: 'data-table',
        columns: [{ key: 'region', label: 'Region', type: 'text' as const }],
        src: join(dataDir, 'sales.json'),
      }],
    });

    expect(result.isError).toBe(false);
  });

  it('rejects a data-table src that escapes the data dir via traversal', async () => {
    const result = await handleRenderUi(ctx(), {
      components: [{
        id: 'evil',
        type: 'data-table',
        columns: [{ key: 'a', label: 'A', type: 'text' as const }],
        src: join(siblingDir, 'outside.json'),
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('src" must be within the session data directory');
  });

  it('rejects a data-table src with a ../ traversal sequence', async () => {
    const result = await handleRenderUi(ctx(), {
      components: [{
        id: 'evil-rel',
        type: 'data-table',
        columns: [{ key: 'a', label: 'A', type: 'text' as const }],
        src: '../../session-evil/outside.json',
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('src" must be within the session data directory');
  });

  it('gives out-of-boundary paths the containment error whether or not they exist (no existence oracle)', async () => {
    // Containment is decided BEFORE existence, so a missing outside path must
    // be indistinguishable from a present one — existence only ever decides
    // the not-found retry hint for paths already inside the data dir.
    const missingOutside = join(siblingDir, 'never-written.json');
    expect(existsSync(missingOutside)).toBe(false);

    const result = await handleRenderUi(ctx(), {
      components: [{
        id: 'probe',
        type: 'data-table',
        columns: [{ key: 'a', label: 'A', type: 'text' as const }],
        src: missingOutside,
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('src" must be within the session data directory');
    expect(result.content[0]?.text).not.toContain('file not found');
  });

  it('rejects a data-table src that escapes via symlink', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const outsideDir = join(rootDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    symlinkSync(outsideDir, join(dataDir, 'escape-link'), 'dir');
    writeFileSync(join(outsideDir, 'rows.json'), '[]');

    const result = await handleRenderUi(ctx(), {
      components: [{
        id: 'symlink',
        type: 'data-table',
        columns: [{ key: 'a', label: 'A', type: 'text' as const }],
        src: join(dataDir, 'escape-link', 'rows.json'),
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('src" must be within the session data directory');
  });

  it('rejects a data-table src pointing at a missing file with a retry hint', async () => {
    const result = await handleRenderUi(ctx(), {
      components: [{
        id: 'missing',
        type: 'data-table',
        columns: [{ key: 'a', label: 'A', type: 'text' as const }],
        src: join(dataDir, 'not-written-yet.json'),
      }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('file not found');
    expect(result.content[0]?.text).toContain('transform_data');
  });

  it('feeds Zod issues back as a tool error for model retry', async () => {
    const result = await handleRenderUi(ctx(), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      components: [{ id: '', type: 'alert', severity: 'nope', message: 42 } as any],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('Invalid render_ui payload');
    expect(result.content[0]?.text).toContain('fix the issues and retry');
  });

  it('blocks execution when the call-time toggle re-check fails', async () => {
    const result = await handleRenderUi(ctx({ isRenderUiEnabled: () => false }), {
      components: [{ id: 'rev', type: 'stat-card', label: 'Total', value: 42 }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('disabled by the Generative UI feature toggle');
  });

  it('proceeds when the call-time toggle re-check passes', async () => {
    const result = await handleRenderUi(ctx({ isRenderUiEnabled: () => true }), {
      components: [{ id: 'rev', type: 'stat-card', label: 'Total', value: 42 }],
    });

    expect(result.isError).toBe(false);
  });
});
