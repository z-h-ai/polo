import { describe, it, expect } from 'bun:test';
import {
  GENUI_COMPONENT_SCHEMAS,
  assertBuiltinCatalogConsistency,
  buildRenderUiJsonSchemaForComponentTypes,
  buildRenderUiSchemaForComponentTypes,
  GenUiSnapshotValidationError,
  getGenUiComponentJsonSchemas,
  getGenUiComponentSchemasForSnapshot,
  validateGenUiComponentsForSnapshot,
} from './genui-schema.ts';
import {
  GENUI_BUILTIN_COMPONENT_DESCRIPTORS,
  GENUI_RENDER_UI_SCHEMA_VERSION,
} from './genui-catalog.ts';
import { getToolDefsAsJsonSchema, RenderUiSchema, RENDER_UI_MAX_COMPONENTS } from './tool-defs.ts';

const STAT_CARD = { id: 's1', type: 'stat-card', label: 'CPU', value: 42 };
const ALERT = { id: 'a1', type: 'alert', severity: 'info', message: 'hello' };
const FORM = {
  id: 'f1',
  type: 'form',
  fields: [{ key: 'env', label: 'Env', type: 'select', options: ['a', 'b'] }],
};

describe('builtin catalog consistency', () => {
  it('descriptor list and schema map cover the same six types', () => {
    expect(() => assertBuiltinCatalogConsistency()).not.toThrow();
    expect(Object.keys(GENUI_COMPONENT_SCHEMAS).sort()).toEqual(
      GENUI_BUILTIN_COMPONENT_DESCRIPTORS.map(d => d.type).sort(),
    );
  });
});

describe('buildRenderUiSchemaForComponentTypes', () => {
  it('accepts a component whose type is in the enabled subset', () => {
    const schema = buildRenderUiSchemaForComponentTypes(['stat-card', 'alert']);
    expect(schema).not.toBeNull();
    expect(schema!.safeParse({ components: [STAT_CARD] }).success).toBe(true);
    expect(schema!.safeParse({ components: [ALERT] }).success).toBe(true);
  });

  it('rejects a component whose type is outside the enabled subset', () => {
    const schema = buildRenderUiSchemaForComponentTypes(['stat-card', 'alert']);
    // form is a known builtin but NOT enabled here — the union must refuse it.
    expect(schema!.safeParse({ components: [FORM] }).success).toBe(false);
  });

  it('keeps the union-independent cross-field rules on dynamic subsets', () => {
    const schema = buildRenderUiSchemaForComponentTypes(['form']);
    // select field without options violates the form cross-field contract.
    const bad = {
      id: 'f1',
      type: 'form',
      fields: [{ key: 'env', label: 'Env', type: 'select' }],
    };
    expect(schema!.safeParse({ components: [bad] }).success).toBe(false);
    // Duplicate ids are caught by the array-level rule regardless of subset.
    const dup = buildRenderUiSchemaForComponentTypes(['stat-card'])!;
    expect(dup.safeParse({ components: [STAT_CARD, { ...STAT_CARD }] }).success).toBe(false);
  });

  it('produces the canonical schema for the full builtin set', () => {
    const dynamic = buildRenderUiSchemaForComponentTypes(Object.keys(GENUI_COMPONENT_SCHEMAS))!;
    const payload = { components: [STAT_CARD, ALERT, FORM] };
    expect(dynamic.safeParse(payload).success).toBe(true);
    expect(RenderUiSchema.safeParse(payload).success).toBe(true);
    // Same members ⇒ identical shape: what the canonical union rejects, the
    // dynamic full-set assembly rejects too.
    const invalid = { components: [{ id: 'x', type: 'nope' }] };
    expect(dynamic.safeParse(invalid).success).toBe(RenderUiSchema.safeParse(invalid).success);
  });

  it('returns null for an empty or all-unknown selection (fail closed)', () => {
    expect(buildRenderUiSchemaForComponentTypes([])).toBeNull();
    expect(buildRenderUiSchemaForComponentTypes(['nope', 'nada'])).toBeNull();
  });

  it('skips unknown types but keeps the known ones (partial catalog)', () => {
    const schema = buildRenderUiSchemaForComponentTypes(['stat-card', 'nope'])!;
    expect(schema.safeParse({ components: [STAT_CARD] }).success).toBe(true);
    expect(schema.safeParse({ components: [ALERT] }).success).toBe(false);
  });

  it('assembles in canonical order regardless of selection order', () => {
    const a = buildRenderUiSchemaForComponentTypes(['alert', 'stat-card'])!;
    const b = buildRenderUiSchemaForComponentTypes(['stat-card', 'alert'])!;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('buildRenderUiJsonSchemaForComponentTypes', () => {
  it('emits a subset discriminator union as JSON Schema', () => {
    const jsonSchema = buildRenderUiJsonSchemaForComponentTypes(['stat-card'])!;
    const union = (jsonSchema.properties as Record<string, { items: { anyOf?: Array<{ properties?: { type?: { const?: string } } }> } }>).components!;
    const types = (union.items.anyOf ?? []).map(variant => variant.properties?.type?.const);
    expect(types).toEqual(['stat-card']);
    expect(jsonSchema.$schema).toBeUndefined();
  });

  it('returns null for an empty selection', () => {
    expect(buildRenderUiJsonSchemaForComponentTypes([])).toBeNull();
  });
});

describe('getGenUiComponentJsonSchemas', () => {
  it('produces one document per builtin type', () => {
    const docs = getGenUiComponentJsonSchemas();
    expect(Object.keys(docs).sort()).toEqual(
      GENUI_BUILTIN_COMPONENT_DESCRIPTORS.map(d => d.type).sort(),
    );
    for (const doc of Object.values(docs)) {
      expect(doc.$schema).toBeUndefined();
    }
  });
});

describe('replay snapshot registry', () => {
  it('serves v1 (the current builtin set) and refuses unknown versions', () => {
    expect(getGenUiComponentSchemasForSnapshot(GENUI_RENDER_UI_SCHEMA_VERSION)).toBe(GENUI_COMPONENT_SCHEMAS);
    expect(getGenUiComponentSchemasForSnapshot(0)).toBeNull();
    expect(getGenUiComponentSchemasForSnapshot(999)).toBeNull();
  });
});

describe('validateGenUiComponentsForSnapshot', () => {
  it('accepts a persisted card against its own snapshot version', () => {
    expect(validateGenUiComponentsForSnapshot([STAT_CARD, FORM], 1)).toEqual({ ok: true });
  });

  it('fails closed on an unknown snapshot version (no throw)', () => {
    const result = validateGenUiComponentsForSnapshot([STAT_CARD], 999);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('999');
    }
  });

  it('reports the offending component and path', () => {
    const invalid = { id: 'a1', type: 'alert', severity: 'not-a-severity', message: 'x' };
    expect(() => validateGenUiComponentsForSnapshot([STAT_CARD, invalid], 1))
      .toThrow(GenUiSnapshotValidationError);
    expect(() => validateGenUiComponentsForSnapshot([STAT_CARD, invalid], 1))
      .toThrow(/Component 1 fails schema snapshot v1 \(at severity\)/);
  });

  it('enforces the component-count bounds', () => {
    const tooMany = Array.from({ length: RENDER_UI_MAX_COMPONENTS + 1 }, (_, i) => ({
      ...STAT_CARD,
      id: `s${i}`,
    }));
    const result = validateGenUiComponentsForSnapshot(tooMany, 1);
    expect(result.ok).toBe(false);
    expect(validateGenUiComponentsForSnapshot([], 1).ok).toBe(false);
  });
});

describe('getToolDefsAsJsonSchema render_ui catalog', () => {
  const renderUiDef = (opts?: Parameters<typeof getToolDefsAsJsonSchema>[0]) =>
    getToolDefsAsJsonSchema({ allowRenderUi: true, ...opts }).find(d => d.name === 'render_ui');

  it('defaults to the builtin catalog in the description', () => {
    const description = renderUiDef()!.description;
    expect(description).toContain('**Component catalog**');
    expect(description).toContain('`stat-card`');
    expect(description).toContain('(read-only)');
  });

  it('honors an explicit renderUiCatalog override', () => {
    const description = renderUiDef({
      renderUiCatalog: [{ type: 'custom-gauge', description: 'my gauge', interactive: false }],
    })!.description;
    expect(description).toContain('`custom-gauge` — my gauge (read-only)');
    // The override replaces the catalog SECTION (the base description's own
    // static `type:` list always stays). Catalog lines use `—`, base lines `:`.
    expect(description).not.toContain('- `stat-card` —');
  });

  it('does not put the catalog into the input schema (description-only index)', () => {
    const inputSchema = JSON.stringify(renderUiDef()!.inputSchema);
    expect(inputSchema).not.toContain('Component catalog');
  });
});
