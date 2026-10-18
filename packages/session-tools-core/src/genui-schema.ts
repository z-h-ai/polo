/**
 * GenUI dynamic tool schema assembly (POO-104, proposal §5.7).
 *
 * The "已启用组件集" engineering seam: render_ui's component union can be
 * assembled per enabled-component set instead of only the static canonical
 * union. Today the enabled set is the builtin catalog; when catalog
 * (third-party) components register, the same assembly produces their union.
 *
 * Replay contract: every card carries the GENUI_RENDER_UI_SCHEMA_VERSION
 * snapshot that was active at generation time. Replay validation must go
 * through getGenUiComponentSchemasForSnapshot (the card's persisted version),
 * never the current registry — old sessions = old schema snapshot + current
 * theme. An unknown snapshot version fails closed (null): the renderer's
 * tolerant JSON fallback view (§5.7 必备件) renders instead.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  GenUIActionButtonsWithIdSchema,
  GenUIAlertSchema,
  GenUIDataTableSchema,
  GenUIFormSchema,
  GenUIProgressSchema,
  GenUIStatCardSchema,
  buildGenUiComponentsArraySchema,
  RENDER_UI_MAX_COMPONENTS,
} from './tool-defs.ts';
import { GENUI_BUILTIN_COMPONENT_DESCRIPTORS, GENUI_RENDER_UI_SCHEMA_VERSION } from './genui-catalog.ts';

/**
 * Canonical component-schema map, keyed by the discriminated-union "type".
 * The canonical order here is the assembly order for every dynamic subset,
 * so two sets with the same members always produce the identical schema.
 */
export const GENUI_COMPONENT_SCHEMAS: Record<string, z.ZodObject<z.ZodRawShape>> = {
  'stat-card': GenUIStatCardSchema,
  'data-table': GenUIDataTableSchema,
  'alert': GenUIAlertSchema,
  'progress': GenUIProgressSchema,
  'action-buttons': GenUIActionButtonsWithIdSchema,
  'form': GenUIFormSchema,
};

/** Component types of a snapshot version, in canonical order. */
function orderedTypesOf(schemas: Record<string, z.ZodObject<z.ZodRawShape>>): string[] {
  return Object.keys(GENUI_COMPONENT_SCHEMAS).filter(type => schemas[type] !== undefined)
    .concat(Object.keys(schemas).filter(type => GENUI_COMPONENT_SCHEMAS[type] === undefined));
}

/**
 * Build the render_ui input schema for an enabled component subset: a
 * discriminated union over the selected types plus the shared cross-field
 * rules (payload cap, unique ids, form select⇔options — union-independent).
 *
 * Returns null when the selection names no known component (empty set or all
 * unknown types) — callers fail closed to the canonical schema / tolerant
 * fallback rather than shipping an unvalidatable tool. Unknown type names are
 * skipped, not errors: a partially-known catalog still constrains what it knows.
 */
export function buildRenderUiSchemaForComponentTypes(
  types: readonly string[],
): z.ZodObject<{ components: z.ZodTypeAny }> | null {
  const requested = new Set(types);
  const selected = orderedTypesOf(GENUI_COMPONENT_SCHEMAS).filter(type => requested.has(type));
  if (selected.length === 0) return null;
  // Every schema here is a ZodObject with a literal "type" field; the tuple
  // cast bridges Zod's ZodDiscriminatedUnionOption variance (same escape the
  // static union's generic chains need elsewhere in this package).
  const union = z.discriminatedUnion(
    'type',
    selected.map(type => GENUI_COMPONENT_SCHEMAS[type]!) as unknown as [z.ZodDiscriminatedUnionOption<'type'>, ...Array<z.ZodDiscriminatedUnionOption<'type'>>],
  );
  return z.object({ components: buildGenUiComponentsArraySchema(union) });
}

/** JSON Schema form of buildRenderUiSchemaForComponentTypes (Pi/MCP consumers). */
export function buildRenderUiJsonSchemaForComponentTypes(
  types: readonly string[],
): Record<string, unknown> | null {
  const schema = buildRenderUiSchemaForComponentTypes(types);
  if (!schema) return null;
  // Same `as any` rationale as tool-defs.getToolDefsAsJsonSchema: deep generic
  // chains from union schemas blow up TS instantiation depth.
  const jsonSchema = zodToJsonSchema(schema as never, { $refStrategy: 'none' }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  delete jsonSchema.additionalProperties;
  return jsonSchema;
}

/** Per-component JSON Schema documents (catalog schemaHash + schema.json source). */
export function getGenUiComponentJsonSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [type, schema] of Object.entries(GENUI_COMPONENT_SCHEMAS)) {
    const jsonSchema = zodToJsonSchema(schema as never, { $refStrategy: 'none' }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    delete jsonSchema.additionalProperties;
    out[type] = jsonSchema;
  }
  return out;
}

/**
 * Replay-snapshot registry: schema version → the component schemas that were
 * current. Version 1 is the POO-101..103 builtin set. Future schema work
 * bumps GENUI_RENDER_UI_SCHEMA_VERSION and ADDS an entry here — never edits a
 * historical one (persisted cards validate against it forever).
 */
const GENUI_COMPONENT_SCHEMA_SNAPSHOTS: Record<number, Record<string, z.ZodObject<z.ZodRawShape>>> = {
  [GENUI_RENDER_UI_SCHEMA_VERSION]: GENUI_COMPONENT_SCHEMAS,
};

/** The snapshot for a persisted card's schemaVersion, or null when unknown. */
export function getGenUiComponentSchemasForSnapshot(
  version: number,
): Record<string, z.ZodObject<z.ZodRawShape>> | null {
  return GENUI_COMPONENT_SCHEMA_SNAPSHOTS[version] ?? null;
}

export type GenUiSnapshotValidationResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Replay validation of persisted card components against their persisted
 * schemaVersion snapshot. Each component validates individually against the
 * snapshot's union so one bad card reports its own error. Fails closed on an
 * unknown snapshot version — the caller falls back to the read-only JSON view.
 */
export function validateGenUiComponentsForSnapshot(
  components: readonly unknown[],
  version: number,
): GenUiSnapshotValidationResult {
  const snapshot = getGenUiComponentSchemasForSnapshot(version);
  if (!snapshot) {
    return { ok: false, error: `Unknown render_ui schema snapshot version: ${version}` };
  }
  const union = z.discriminatedUnion(
    'type',
    orderedTypesOf(snapshot).map(type => snapshot[type]!) as unknown as [z.ZodDiscriminatedUnionOption<'type'>, ...Array<z.ZodDiscriminatedUnionOption<'type'>>],
  );
  if (components.length < 1 || components.length > RENDER_UI_MAX_COMPONENTS) {
    return { ok: false, error: `Component count must be between 1 and ${RENDER_UI_MAX_COMPONENTS}.` };
  }
  components.forEach((component, index) => {
    const parsed = union.safeParse(component);
    if (!parsed.success) {
      // Throwing out of forEach is the cleanest shape here: the first invalid
      // card decides the result, matching "fix the payload and retry" replay.
      const issue = parsed.error.issues[0];
      const path = issue && issue.path.length > 0 ? ` (at ${issue.path.map(String).join('.')})` : '';
      throw new GenUiSnapshotValidationError(`Component ${index} fails schema snapshot v${version}${path}: ${issue?.message ?? 'invalid'}`);
    }
  });
  return { ok: true };
}

export class GenUiSnapshotValidationError extends Error {}

/**
 * Consistency guard between the builtin catalog descriptors (genui-catalog,
 * plain strings) and the actual component schemas: every descriptor type must
 * have a schema and vice versa. Deliberately an explicit check (invoked by the
 * tests, and cheap enough for startups that want it) rather than an import-time
 * side effect — a drifted builtin list must be caught, but module evaluation
 * should stay side-effect-free.
 */
export function assertBuiltinCatalogConsistency(): void {
  const descriptorTypes = new Set<string>();
  for (const descriptor of GENUI_BUILTIN_COMPONENT_DESCRIPTORS) {
    descriptorTypes.add(descriptor.type);
    if (!GENUI_COMPONENT_SCHEMAS[descriptor.type]) {
      throw new Error(`GenUI builtin descriptor "${descriptor.type}" has no component schema`);
    }
  }
  for (const type of Object.keys(GENUI_COMPONENT_SCHEMAS)) {
    if (!descriptorTypes.has(type)) {
      throw new Error(`GenUI component schema "${type}" has no builtin descriptor`);
    }
  }
}
