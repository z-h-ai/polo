/**
 * GenUI component catalog — host runtime registry (POO-104, proposal §5.7).
 *
 * Two-layer index, host side: `type → {来源, 版本, schemaHash, 加载器, 权限}`.
 * The builtin components ARE the initial catalog, registered through the same
 * interface a third-party component bundle (Creator Skill bundle of type
 * `genui-component`) will use — no separate builtin fast path.
 *
 * SECURITY BOUNDARY (底线): a catalog component's renderer is CODE and never
 * enters the Electron renderer process (the trust core of the app). Third-party
 * renderers execute inside the Track 2 webview sandbox only, or are
 * builtin-ized after admin review (泄压阀). The loader interface below exists
 * to pin that contract; POO-104 intentionally does NOT ship the third-party
 * distribution/install flow — only the format, the interface, and this doc.
 *
 * Expectation management: third-party components are read-only in this phase
 * (`interactive: false`); their interaction loops require the poloai:// v2
 * bridge, so the model-side index (render_ui description) renders their
 * entries with an explicit read-only note.
 *
 * Replay-wiring scope (明示口径, POO-104): the schema-snapshot registry replay
 * validation needs ships as library code (session-tools-core genui-schema:
 * getGenUiComponentSchemasForSnapshot / validateGenUiComponentsForSnapshot),
 * but the card persistence/replay path that CALLS it is deferred to the
 * change that introduces a second schema version. Lossless today: with a
 * builtin-only catalog the dynamic schema is identical to the static union,
 * so every persisted card was built under the schema its descriptor's
 * schemaVersion still names.
 */

import { createHash } from 'node:crypto'
import {
  GENUI_BUILTIN_COMPONENT_DESCRIPTORS,
  GENUI_RENDER_UI_SCHEMA_VERSION,
} from '@polo-ai/session-tools-core'
import { getGenUiComponentJsonSchemas } from '@polo-ai/session-tools-core'

/** Where a registered component came from. */
export type GenUiComponentSource = 'builtin' | 'catalog'

/** How the host obtains a renderer for the component. */
export type GenUiComponentLoaderKind =
  /** In-process React component shipped with the host (packages/ui registry). */
  | 'builtin-react'
  /** HTML/JS bundle executed inside a sandboxed <webview> — never the renderer process. */
  | 'webview-sandbox'

export interface GenUiComponentRegistration {
  /** render_ui discriminator value (e.g. "stat-card"). */
  type: string
  /** Human name shown in catalog/admin surfaces. */
  name: string
  /** One-line model-facing description (sanitized downstream; no newlines). */
  description: string
  source: GenUiComponentSource
  /** Bundle semver; builtins are versioned with the host release ('0.0.0'). */
  version: string
  /** Replay snapshot key — cards persist this and replay validates against it. */
  schemaVersion: number
  /** sha256 over the canonical JSON of the component's JSON Schema document. */
  schemaHash: string
  loader: GenUiComponentLoaderKind
  /** Host bridge capabilities the renderer needs (polo-bridge-capabilities names). */
  capabilities: readonly string[]
  /** False = read-only card (P3 expectation for third-party components). */
  interactive: boolean
}

/** Stable insertion-ordered, duplicate-rejecting component registry. */
export class GenUiComponentCatalog {
  private readonly components = new Map<string, GenUiComponentRegistration>()

  register(registration: GenUiComponentRegistration): { ok: true } | { ok: false; error: string } {
    const type = registration.type
    if (!type || type.length > 64 || !/^[a-z][a-z0-9-]*$/.test(type)) {
      return { ok: false, error: `Invalid component type: "${type}"` }
    }
    if (this.components.has(type)) {
      return { ok: false, error: `Component type already registered: "${type}"` }
    }
    this.components.set(type, { ...registration, capabilities: [...registration.capabilities] })
    return { ok: true }
  }

  get(type: string): GenUiComponentRegistration | undefined {
    return this.components.get(type)
  }

  has(type: string): boolean {
    return this.components.has(type)
  }

  /** Registered components in registration order (builtins first). */
  list(): GenUiComponentRegistration[] {
    return [...this.components.values()]
  }

  /** The model-side index: type + one-liner per enabled component. */
  descriptors(): Array<{ type: string; description: string; interactive: boolean }> {
    return this.list().map(component => ({
      type: component.type,
      description: component.description,
      interactive: component.interactive,
    }))
  }

  get size(): number {
    return this.components.size
  }
}

/**
 * Canonical JSON: sorted keys, dropped undefined values — the hash input for
 * schema documents, so formatting churn can never rotate a schemaHash.
 */
export function canonicalGenUiJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => canonicalGenUiJson(entry)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalGenUiJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** sha256 over the canonical JSON of a component's JSON Schema document. */
export function computeGenUiSchemaHash(schemaJson: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalGenUiJson(schemaJson)).digest('hex')
}

/**
 * The builtin catalog version marker: builtins ship with the host and carry no
 * independent bundle version — their identity is (host release, schemaVersion).
 */
export const GENUI_BUILTIN_COMPONENT_VERSION = '0.0.0'

/**
 * Build the builtin catalog: the six P0–P2 components registered through the
 * same interface future catalog bundles use. Schema hashes derive from the
 * canonical per-component JSON Schemas in session-tools-core, so any schema
 * change rotates the hash (catalog/admin surfaces see it immediately).
 */
export function createBuiltinGenUiComponentCatalog(): GenUiComponentCatalog {
  const catalog = new GenUiComponentCatalog()
  const jsonSchemas = getGenUiComponentJsonSchemas()
  for (const descriptor of GENUI_BUILTIN_COMPONENT_DESCRIPTORS) {
    const schemaJson = jsonSchemas[descriptor.type]
    if (!schemaJson) {
      // session-tools-core's consistency test guards this; fail loudly here too.
      throw new Error(`GenUI builtin schema missing for "${descriptor.type}"`)
    }
    const verdict = catalog.register({
      type: descriptor.type,
      name: BUILTIN_COMPONENT_NAMES[descriptor.type] ?? descriptor.type,
      description: descriptor.description,
      source: 'builtin',
      version: GENUI_BUILTIN_COMPONENT_VERSION,
      schemaVersion: GENUI_RENDER_UI_SCHEMA_VERSION,
      schemaHash: computeGenUiSchemaHash(schemaJson),
      loader: 'builtin-react',
      // Builtins render declarative data only; the ui-event bridge is a
      // canvas-app (generate_app) capability and intentionally not listed.
      capabilities: [],
      interactive: descriptor.interactive,
    })
    if (!verdict.ok) throw new Error(verdict.error)
  }
  return catalog
}

const BUILTIN_COMPONENT_NAMES: Record<string, string> = {
  'stat-card': 'Stat card',
  'data-table': 'Data table',
  'alert': 'Alert',
  'progress': 'Progress',
  'action-buttons': 'Action buttons',
  'form': 'Form',
}

// ── Process-wide singleton ───────────────────────────────────────────────────

let catalog: GenUiComponentCatalog | null = null

/**
 * The host runtime registry. Builtin-only until the catalog install flow
 * (post-POO-104) registers third-party bundles; every consumer — the
 * model-side index plumbed into the tool descriptions, future catalog/admin
 * UI — reads the same instance.
 */
export function getGenUiComponentCatalog(): GenUiComponentCatalog {
  if (!catalog) catalog = createBuiltinGenUiComponentCatalog()
  return catalog
}

/** Test seam. */
export function __resetGenUiComponentCatalogForTests(): void {
  catalog = null
}

// ── Component bundle format (Creator Skill bundle, type `genui-component`) ──

/**
 * A component package = Creator Skill bundle (proposal §5.7):
 * manifest + schema (versioned) + renderer + token mapping. The renderer is
 * HTML/JS executed inside the webview sandbox — it is data to this process,
 * never code loaded here.
 */
export interface GenUiComponentManifest {
  /** Bundle display name. */
  name: string
  /** The render_ui component type this bundle provides. */
  type: string
  /** The schema version this bundle's renderer understands. */
  schemaVersion: number
  /** Host bridge capabilities the renderer requires (empty for read-only). */
  capabilities: readonly string[]
  /** Bundle semver. */
  version: string
}

export interface GenUiComponentBundle {
  manifest: GenUiComponentManifest
  /** JSON Schema document for the component's props (the persisted snapshot source). */
  schema: Record<string, unknown>
  renderer: {
    /** Sandbox entry document (HTML) inside the bundle. */
    entry: string
    /** Only the webview sandbox is sanctioned — never the renderer process. */
    sandbox: 'webview'
  }
  /** Design-token mapping on top of the packages/ui token system (no second system). */
  tokenMapping?: Record<string, string>
}

/**
 * Structural validation of a component bundle. Shape-only: it never executes
 * or even reads renderer code. Execution itself belongs to the (future)
 * install flow, which must load the entry into a sandboxed webview whose
 * partition follows the Track 2 rules, with capabilities extracted from the
 * attached document exactly like generate_app cards (UiCardRegistry).
 */
export function validateGenUiComponentBundle(raw: unknown): { ok: true; bundle: GenUiComponentBundle } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Bundle must be an object' }
  const bundle = raw as Partial<GenUiComponentBundle>
  const manifest = bundle.manifest as Partial<GenUiComponentManifest> | undefined
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'Bundle is missing a manifest' }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0 || manifest.name.length > 128) {
    return { ok: false, error: 'Manifest name must be 1-128 chars' }
  }
  if (typeof manifest.type !== 'string' || !/^[a-z][a-z0-9-]*$/.test(manifest.type) || manifest.type.length > 64) {
    return { ok: false, error: 'Manifest type must be a lowercase slug (≤64 chars)' }
  }
  if (!Number.isInteger(manifest.schemaVersion) || (manifest.schemaVersion ?? 0) < 1) {
    return { ok: false, error: 'Manifest schemaVersion must be a positive integer' }
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.some(c => typeof c !== 'string')) {
    return { ok: false, error: 'Manifest capabilities must be a list of strings' }
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0 || manifest.version.length > 32) {
    return { ok: false, error: 'Manifest version must be 1-32 chars' }
  }
  if (!bundle.schema || typeof bundle.schema !== 'object' || Array.isArray(bundle.schema)) {
    return { ok: false, error: 'Bundle is missing a schema object' }
  }
  const renderer = bundle.renderer as Partial<GenUiComponentBundle['renderer']> | undefined
  if (!renderer || renderer.sandbox !== 'webview' || typeof renderer.entry !== 'string' || renderer.entry.length === 0) {
    return { ok: false, error: 'Renderer must target the webview sandbox with an entry document' }
  }
  if (bundle.tokenMapping !== undefined && (typeof bundle.tokenMapping !== 'object' || bundle.tokenMapping === null || Array.isArray(bundle.tokenMapping))) {
    return { ok: false, error: 'tokenMapping must be an object when present' }
  }
  return { ok: true, bundle: raw as GenUiComponentBundle }
}

/**
 * The loader contract for catalog components. INTENTIONALLY UNIMPLEMENTED in
 * POO-104: third-party distribution is out of scope. The interface pins the
 * security contract for whoever ships the install flow:
 *
 * 1. The loader NEVER returns something the renderer process evaluates.
 *    Implementations hand the bundle entry to a sandboxed <webview> (Track 2
 *    partition, non-persist, capability extraction at attach) or the component
 *    was builtin-ized after admin review (then it registers as a builtin
 *    instead of going through this interface).
 * 2. The bundle's schema document freezes at install time; cards generated
 *    with it persist schemaVersion and replay validates against that snapshot
 *    (session-tools-core getGenUiComponentSchemasForSnapshot — the registry
 *    ships now, the replay call site is deferred; see the header scope note).
 * 3. capabilities must be a subset of what the host bridge actually supports;
 *    anything else fails closed at registration.
 */
export interface GenUiCatalogComponentLoader {
  load(bundle: GenUiComponentBundle): Promise<{ ok: true; registration: GenUiComponentRegistration } | { ok: false; error: string }>
}
