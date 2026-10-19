import { describe, it, expect } from 'bun:test';
import {
  GENUI_BUILTIN_COMPONENT_DESCRIPTORS,
  GENUI_RENDER_UI_SCHEMA_VERSION,
  buildRenderUiCatalogSection,
  buildRenderUiToolDescription,
  sanitizeCatalogText,
} from './genui-catalog.ts';

describe('genui builtin catalog descriptors', () => {
  it('covers the seven builtin components with unique types', () => {
    const types = GENUI_BUILTIN_COMPONENT_DESCRIPTORS.map(d => d.type);
    expect(types.sort()).toEqual([
      'action-buttons',
      'alert',
      'chart',
      'data-table',
      'form',
      'progress',
      'stat-card',
    ]);
  });

  it('marks only the host-mediated components interactive', () => {
    const interactive = GENUI_BUILTIN_COMPONENT_DESCRIPTORS
      .filter(d => d.interactive)
      .map(d => d.type);
    // action-buttons and form always carry clicks; data-table joined them when
    // rowAction/detailTemplate started routing through the craft: pipeline.
    expect(interactive.sort()).toEqual(['action-buttons', 'data-table', 'form']);
  });

  it('keeps descriptions single-line (they are injected into a tool description)', () => {
    for (const descriptor of GENUI_BUILTIN_COMPONENT_DESCRIPTORS) {
      expect(descriptor.description.includes('\n')).toBe(false);
      expect(descriptor.type).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
});

describe('sanitizeCatalogText', () => {
  it('collapses newlines, tabs, control chars and backticks to spaces', () => {
    // A description cannot forge list entries or headings: each stripped char
    // becomes one space, so structure survives only as flat text.
    expect(sanitizeCatalogText('legit\n- `evil` heading\r\nmore', 160)).toBe('legit -  evil  heading more');
    expect(sanitizeCatalogText('a\u0000b\u001fc', 160)).toBe('a b c');
  });

  it('caps length with an ellipsis', () => {
    expect(sanitizeCatalogText('x'.repeat(200), 160)).toBe(`${'x'.repeat(159)}…`);
    expect(sanitizeCatalogText('short', 160)).toBe('short');
  });
});

describe('buildRenderUiCatalogSection', () => {
  it('returns an empty string for an empty catalog', () => {
    expect(buildRenderUiCatalogSection([])).toBe('');
  });

  it('lists builtin components without the third-party read-only note', () => {
    const section = buildRenderUiCatalogSection(GENUI_BUILTIN_COMPONENT_DESCRIPTORS);
    expect(section).toContain('**Component catalog**');
    expect(section).toContain('- `stat-card` — single metric with optional delta and trend (read-only)');
    expect(section).toContain('- `form` —');
    // All builtin ⇒ no read-only expectation note.
    expect(section).not.toContain('READ-ONLY in this host release');
  });

  it('appends the read-only note when a third-party component is present', () => {
    const section = buildRenderUiCatalogSection([
      ...GENUI_BUILTIN_COMPONENT_DESCRIPTORS,
      { type: 'chart-thing', description: 'third-party chart', interactive: true },
    ]);
    // Even an interactive-flagged third-party entry stays read-only in copy…
    expect(section).toContain('- `chart-thing` — third-party chart (read-only)');
    // …and the expectation-management note is present.
    expect(section).toContain('READ-ONLY in this host release');
    expect(section).toContain('poloai:// v2');
  });
});

describe('buildRenderUiToolDescription', () => {
  it('returns the base description unchanged for an empty catalog', () => {
    expect(buildRenderUiToolDescription('base', [])).toBe('base');
  });

  it('appends the catalog section after a blank line', () => {
    const combined = buildRenderUiToolDescription('base', GENUI_BUILTIN_COMPONENT_DESCRIPTORS);
    expect(combined.startsWith(`base\n\n**Component catalog**`)).toBe(true);
  });

  it('carries the replay-snapshot version constant', () => {
    expect(GENUI_RENDER_UI_SCHEMA_VERSION).toBe(1);
  });
});
