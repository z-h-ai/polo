import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SessionToolContext } from '../context.ts';
import { handleRenderUi, classifyGenUiIssue, type GenUiIssueLike } from './render-ui.ts';
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

// ============================================================
// Error-code taxonomy (P2-3)
// ============================================================

describe('render_ui error-code taxonomy', () => {
  // Minimal ctx — the taxonomy paths under test never touch the filesystem
  // (no data-table components), so no temp dirs are needed.
  const taxonomyCtx: SessionToolContext = {
    sessionId: 'taxonomy',
    workspacePath: '/tmp',
    sourcesPath: '/tmp/sources',
    skillsPath: '/tmp/skills',
    plansFolderPath: '/tmp/plans',
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
    sessionPath: '/tmp/session',
    dataPath: '/tmp/session/data',
  };

  /** Run a bad payload through the handler and return the tool error text. */
  async function errorTextFor(payload: unknown): Promise<string> {
    const result = await handleRenderUi(
      taxonomyCtx,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload as any,
    );
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Invalid render_ui payload');
    expect(text).toContain('Fix hints:');
    return text;
  }

  it('classifies zod-native issue codes through the pure classifier', () => {
    expect(classifyGenUiIssue({ code: 'unrecognized_keys', path: [], message: 'Unrecognized key: "action"' })).toBe('unrecognized-key');
    expect(classifyGenUiIssue({ code: 'invalid_type', received: 'undefined', path: ['x'], message: 'Required' })).toBe('missing-required');
    expect(classifyGenUiIssue({ code: 'invalid_type', received: 'number', path: ['x'], message: 'Expected string, received number' })).toBe('invalid-type');
    expect(classifyGenUiIssue({ code: 'invalid_value', path: [], message: 'Invalid option: expected one of "a"|"b"' })).toBe('invalid-type');
    expect(classifyGenUiIssue({ code: 'invalid_union', path: ['type'], message: 'Invalid input' })).toBe('invalid-type');
    expect(classifyGenUiIssue({ code: 'invalid_union_discriminator', path: ['components', 0, 'type'], message: 'Invalid discriminator value' })).toBe('invalid-type');
    expect(classifyGenUiIssue({ code: 'too_big', type: 'array', path: ['components'], message: 'Array must contain at most 8 element(s)' })).toBe('too-many-components');
    expect(classifyGenUiIssue({ code: 'too_small', type: 'array', path: ['components'], message: 'Array must contain at least 1 element(s)' })).toBe('missing-required');
    // Nested array constraints (fields/columns/series) are per-field, not the components array
    expect(classifyGenUiIssue({ code: 'too_big', type: 'array', path: ['components', 0, 'fields'], message: 'Too big' })).toBe('invalid-type');
    expect(classifyGenUiIssue({ code: 'too_big', origin: 'string', path: ['components', 0, 'label'], message: 'Too big' })).toBe('invalid-type');
    // Unknown future zod codes fall through to the catch-all
    expect(classifyGenUiIssue({ code: 'some_future_code', path: [], message: 'whatever' })).toBe('schema-invalid');
  });

  it('prefixes payload-too-large with its code and fix hint', async () => {
    const text = await errorTextFor({
      components: [{
        id: 'big',
        type: 'alert',
        severity: 'info',
        message: 'x'.repeat(RENDER_UI_MAX_PAYLOAD_BYTES),
      }],
    });
    expect(text).toContain('[genui:payload-too-large]');
    expect(text).toContain('Move data into a file via transform_data');
  });

  it('prefixes too-many-components with its code', async () => {
    const text = await errorTextFor({
      components: Array.from({ length: 9 }, (_, i) => ({
        id: `alert-${i}`,
        type: 'alert',
        severity: 'info',
        message: `m${i}`,
      })),
    });
    expect(text).toContain('[genui:too-many-components]');
  });

  it('prefixes duplicate-component-id with its code', async () => {
    const text = await errorTextFor({
      components: [
        { id: 'dup', type: 'alert', severity: 'info', message: 'first' },
        { id: 'dup', type: 'alert', severity: 'warning', message: 'second' },
      ],
    });
    expect(text).toContain('[genui:duplicate-component-id]');
  });

  it('prefixes duplicate-form-field-key with its code', async () => {
    const text = await errorTextFor({
      components: [{
        id: 'f',
        type: 'form',
        fields: [
          { key: 'email', label: 'Email', type: 'text' },
          { key: 'email', label: 'Email again', type: 'text' },
        ],
      }],
    });
    expect(text).toContain('[genui:duplicate-form-field-key]');
  });

  it('prefixes duplicate action-button param keys as duplicate-form-field-key (same contract)', async () => {
    const text = await errorTextFor({
      components: [{
        id: 'btns',
        type: 'action-buttons',
        buttons: [{
          id: 'b1',
          label: 'Go',
          params: [
            { key: 'region', label: 'Region', type: 'select', options: ['EMEA'] },
            { key: 'region', label: 'Region again', type: 'select', options: ['APAC'] },
          ],
          action: { kind: 'send-message', promptTemplate: 'Break down {{region}}' },
        }],
      }],
    });
    expect(text).toContain('[genui:duplicate-form-field-key]');
  });

  it('prefixes select-options-mismatch with its code (select without options)', async () => {
    const text = await errorTextFor({
      components: [{
        id: 'f',
        type: 'form',
        fields: [{ key: 'tier', label: 'Tier', type: 'select' }],
      }],
    });
    expect(text).toContain('[genui:select-options-mismatch]');
  });

  it('prefixes select-options-mismatch when a non-select field carries options', async () => {
    const text = await errorTextFor({
      components: [{
        id: 'f',
        type: 'form',
        fields: [{ key: 'name', label: 'Name', type: 'text', options: ['a', 'b'] }],
      }],
    });
    expect(text).toContain('[genui:select-options-mismatch]');
  });

  it('prefixes missing-required with its code (absent required field)', async () => {
    const text = await errorTextFor({
      components: [{ id: 'rev', type: 'stat-card', value: 42 }],
    });
    expect(text).toContain('[genui:missing-required]');
  });

  it('prefixes missing-required for an empty components array', async () => {
    const text = await errorTextFor({ components: [] });
    expect(text).toContain('[genui:missing-required]');
  });

  it('prefixes invalid-type with its code (wrong value type)', async () => {
    const text = await errorTextFor({
      components: [{ id: 'a', type: 'alert', severity: 'info', message: 42 }],
    });
    expect(text).toContain('[genui:invalid-type]');
  });

  it('prefixes invalid-type for an unknown component type discriminator', async () => {
    const text = await errorTextFor({
      components: [{ id: 'x', type: 'mystery-card', label: 'y' }],
    });
    expect(text).toContain('[genui:invalid-type]');
  });

  it('prefixes unrecognized-key with its code (strict schema, unknown field)', async () => {
    const text = await errorTextFor({
      components: [{
        id: 'f',
        type: 'form',
        fields: [{ key: 'email', label: 'Email', type: 'text' }],
        action: 'send-message',
      }],
    });
    expect(text).toContain('[genui:unrecognized-key]');
  });

  it('falls back to schema-invalid for unmatched custom cross-field rules', async () => {
    // Both prompt and promptTemplate set — a custom superRefine rule with no
    // dedicated code lands on the catch-all.
    const text = await errorTextFor({
      components: [{
        id: 'btns',
        type: 'action-buttons',
        buttons: [{
          id: 'b1',
          label: 'Go',
          action: {
            kind: 'send-message',
            prompt: 'Do it',
            promptTemplate: 'Do {{x}}',
          },
        }],
      }],
    });
    expect(text).toContain('[genui:schema-invalid]');
  });

  it('falls back to schema-invalid for the chart series/categories length rule', async () => {
    const text = await errorTextFor({
      components: [{
        id: 'c',
        type: 'chart',
        chartType: 'bar',
        categories: ['Q1', 'Q2'],
        series: [{ name: 'rev', values: [1, 2, 3] }],
      }],
    });
    expect(text).toContain('[genui:schema-invalid]');
  });

  it('deduplicates fix hints per code across repeated issues', async () => {
    // Two same-code issues (both messages are numbers) — the issue prefix
    // appears on both, but the hint section states the fix exactly once.
    const text = await errorTextFor({
      components: [
        { id: 'a', type: 'alert', severity: 'info', message: 42 },
        { id: 'b', type: 'alert', severity: 'info', message: 43 },
      ],
    });
    const sections = text.split('Fix hints:');
    const issueSection = sections[0] ?? '';
    const hintSection = sections[1] ?? '';
    expect(issueSection.split('[genui:invalid-type]').length - 1).toBe(2);
    expect(hintSection.split("[genui:invalid-type] Match the field's expected type").length - 1).toBe(1);
  });
});
