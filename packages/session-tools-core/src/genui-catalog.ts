/**
 * GenUI component catalog seam (POO-104, proposal §5.7).
 *
 * Two-layer index, model side: the render_ui tool description carries ONLY a
 * type + one-line description per enabled component — never the full schema
 * documents (token control). The schema documents themselves live in
 * tool-defs.ts / genui-schema.ts; the per-component one-liners live here.
 *
 * This module is deliberately dependency-free (no zod, no fs): tool-defs.ts
 * imports it for the dynamic description while genui-schema.ts imports both,
 * which keeps the import graph acyclic (tool-defs → genui-catalog ← genui-schema).
 *
 * Expectation management (task card item 5): third-party (catalog) components
 * are READ-ONLY in this phase. Their interactive loops depend on the
 * poloai:// v2 bridge, so their descriptions must never promise clicks.
 */

/**
 * Replay-snapshot version for the render_ui component union. Cards persist
 * the version that was active when they were generated (POO-104); replay
 * validation must use the card's persisted snapshot, never the current
 * registry — old sessions = old schema snapshot + current theme (§5.7).
 * Only additive, optional-field changes may bump this within a major line.
 */
export const GENUI_RENDER_UI_SCHEMA_VERSION = 1;

/** One model-facing catalog entry: the type discriminator + a one-liner. */
export interface GenUiComponentDescriptor {
  /** The render_ui component "type" discriminator value. */
  type: string;
  /** Single-line description. Newlines are stripped at assembly time. */
  description: string;
  /**
   * False = read-only card. Builtin components with host-mediated actions
   * (action-buttons, form) are interactive; third-party components are not,
   * until the poloai:// v2 interaction loop ships.
   */
  interactive: boolean;
}

/**
 * The builtin catalog (proposal: the P0 components ARE the builtin catalog,
 * registered through the same interface third-party bundles will use).
 * The type keys must stay in lockstep with the component schemas in
 * tool-defs.ts — genui-schema's consistency test fails the build otherwise.
 */
export const GENUI_BUILTIN_COMPONENT_DESCRIPTORS: readonly GenUiComponentDescriptor[] = [
  { type: 'stat-card', description: 'single metric with optional delta and trend', interactive: false },
  // data-table is interactive in the action-buttons/form sense: its optional
  // rowAction/detailTemplate route through the same host-mediated craft:
  // pipeline (a table without them simply has no clickable parts).
  { type: 'data-table', description: 'sortable file-backed table (rows via transform_data + "src", never inline) with optional per-row actions and source links', interactive: true },
  { type: 'alert', description: 'info/success/warning/error banner', interactive: false },
  { type: 'progress', description: 'running/success/error indicator with optional percent', interactive: false },
  { type: 'action-buttons', description: '1-6 buttons that send a follow-up message or prefill the chat input', interactive: true },
  { type: 'form', description: '1-12 fields the user fills; submit sends the values object as the next user message', interactive: true },
];

/** Hard cap on a catalog description line appended to the tool description. */
const CATALOG_DESCRIPTION_MAX_CHARS = 160;
/** Hard cap on a catalog component type label. */
const CATALOG_TYPE_MAX_CHARS = 64;

/**
 * Sanitize a catalog-provided string for injection into the tool description.
 * Catalog descriptors may originate from third-party bundles, so this is a
 * trust boundary: newlines/tabs/control characters are collapsed to spaces
 * (a description cannot forge list entries or headings), lengths are capped,
 * and backticks are stripped (a description cannot close a code span early
 * and start emitting fake markup).
 */
export function sanitizeCatalogText(input: string, maxChars: number): string {
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f`]+/g, ' ')
    .trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

/**
 * Build the model-side index section: one `type — description` line per
 * enabled component, plus the read-only expectation note for the third-party
 * entries. Returns an empty string for an empty catalog.
 */
export function buildRenderUiCatalogSection(descriptors: readonly GenUiComponentDescriptor[]): string {
  if (descriptors.length === 0) return '';
  const lines = descriptors.map(descriptor => {
    const type = sanitizeCatalogText(descriptor.type, CATALOG_TYPE_MAX_CHARS);
    const description = sanitizeCatalogText(descriptor.description, CATALOG_DESCRIPTION_MAX_CHARS);
    // Expectation management (task card item 5): a third-party descriptor may
    // claim interactive, but until the poloai:// v2 loop ships its clicks do
    // nothing — the line must never promise interactivity for non-builtin.
    const interactive = descriptor.interactive && isBuiltinDescriptorType(descriptor.type);
    return `- \`${type}\` — ${description}${interactive ? '' : ' (read-only)'}`;
  });
  const thirdParty = descriptors.some(descriptor => !isBuiltinDescriptorType(descriptor.type));
  const notes = thirdParty
    ? [
        '',
        'Components not marked builtin ship from the component catalog and are READ-ONLY in this host release: they render data but their buttons/inputs do nothing until the poloai:// v2 interaction loop ships. Do not promise interactivity for them.',
      ]
    : [];
  return ['**Component catalog** (valid "type" values):', ...lines, ...notes].join('\n');
}

function isBuiltinDescriptorType(type: string): boolean {
  return GENUI_BUILTIN_COMPONENT_DESCRIPTORS.some(descriptor => descriptor.type === type);
}

/**
 * Assemble the effective render_ui tool description: the canonical base
 * description plus the dynamic catalog section (two-layer index, model side).
 */
export function buildRenderUiToolDescription(
  baseDescription: string,
  descriptors: readonly GenUiComponentDescriptor[],
): string {
  const section = buildRenderUiCatalogSection(descriptors);
  return section ? `${baseDescription}\n\n${section}` : baseDescription;
}
