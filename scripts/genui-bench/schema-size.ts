/**
 * GenUI schema-size baseline bench (P2-2a / P1-1's ruler).
 *
 * Quantifies the model-visible cost of the `render_ui` and `generate_app`
 * tool definitions on both backend tool surfaces:
 *
 *   a) Pi/MCP path   — the JSON Schema entries `getToolDefsAsJsonSchema()`
 *                      ships to the model (what tool-defs.ts actually emits).
 *   b) Claude path   — the same zod→JSON Schema conversion library that
 *                      getToolDefsAsJsonSchema uses internally (zod-to-json-
 *                      schema, $refStrategy 'none', $schema/additionalProperties
 *                      stripped) applied straight to RenderUiSchema /
 *                      GenerateAppSchema. This mirrors what the Claude SDK
 *                      serializes from the zod `.shape` tools.
 *   c) Description strings — the base tool descriptions (TOOL_DESCRIPTIONS,
 *                      aliased BASE_DESCRIPTIONS in session-scoped-tools.ts)
 *                      and the dynamic catalog section appended to render_ui
 *                      (buildRenderUiCatalogSection output).
 *
 * Token figures are ESTIMATES at chars/4 — no tokenizer in the dependency
 * tree, and the exact tokenizer differs per model. Bytes are UTF-8
 * (TextEncoder), chars are JS string length.
 *
 * Run: bun scripts/genui-bench/schema-size.ts
 * Writes the same table (plus date + commit sha) to
 * docs/reports/schema-size-baseline.md so P1-1 slimming has a reproducible
 * baseline to diff against.
 */
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zodToJsonSchema } from 'zod-to-json-schema'
import {
  GenerateAppSchema,
  RenderUiSchema,
  TOOL_DESCRIPTIONS,
  getToolDefsAsJsonSchema,
} from '../../packages/session-tools-core/src/tool-defs.ts'
import {
  GENUI_BUILTIN_COMPONENT_DESCRIPTORS,
  buildRenderUiCatalogSection,
  buildRenderUiToolDescription,
} from '../../packages/session-tools-core/src/genui-catalog.ts'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const REPORT_PATH = resolve(REPO_ROOT, 'docs/reports/schema-size-baseline.md')

interface Measurement {
  label: string
  chars: number
  bytes: number
  /** ESTIMATE: chars / 4 */
  estTokens: number
}

function measure(label: string, text: string): Measurement {
  const bytes = new TextEncoder().encode(text).length
  return { label, chars: text.length, bytes, estTokens: Math.ceil(text.length / 4) }
}

/** Mirror of getToolDefsAsJsonSchema's internal zod→JSON Schema serialization. */
function claudePathJsonSchema(schema: unknown): string {
  // Same `as any` + options as tool-defs.getToolDefsAsJsonSchema — deep
  // generic chains from union schemas trip TS2589 otherwise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jsonSchema = zodToJsonSchema(schema as any, { $refStrategy: 'none' }) as Record<string, unknown>
  delete jsonSchema.$schema
  delete jsonSchema.additionalProperties
  return JSON.stringify(jsonSchema)
}

function getCommitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return '(unknown — not a git worktree?)'
  }
}

// ── Collect measurements ─────────────────────────────────────────────────────

const piToolDefs = getToolDefsAsJsonSchema({
  allowRenderUi: true,
  allowGenerateApp: true,
})
const piRenderUi = piToolDefs.find(def => def.name === 'render_ui')
const piGenerateApp = piToolDefs.find(def => def.name === 'generate_app')
if (!piRenderUi || !piGenerateApp) {
  console.error('render_ui / generate_app missing from getToolDefsAsJsonSchema output — aborting')
  process.exit(1)
}

const claudeRenderUiSchema = claudePathJsonSchema(RenderUiSchema)
const claudeGenerateAppSchema = claudePathJsonSchema(GenerateAppSchema)

const catalogSection = buildRenderUiCatalogSection(GENUI_BUILTIN_COMPONENT_DESCRIPTORS)
const renderUiFullDescription = buildRenderUiToolDescription(TOOL_DESCRIPTIONS.render_ui, GENUI_BUILTIN_COMPONENT_DESCRIPTORS)

const rows: Measurement[] = [
  measure('Pi/MCP path: render_ui inputSchema (JSON.stringify)', JSON.stringify(piRenderUi.inputSchema)),
  measure('Pi/MCP path: generate_app inputSchema (JSON.stringify)', JSON.stringify(piGenerateApp.inputSchema)),
  measure('Claude path: RenderUiSchema → JSON Schema', claudeRenderUiSchema),
  measure('Claude path: GenerateAppSchema → JSON Schema', claudeGenerateAppSchema),
  measure('Description: render_ui base (TOOL_DESCRIPTIONS.render_ui)', TOOL_DESCRIPTIONS.render_ui),
  measure('Description: generate_app base (TOOL_DESCRIPTIONS.generate_app)', TOOL_DESCRIPTIONS.generate_app),
  measure('Description: render_ui catalog section (buildRenderUiCatalogSection, builtin)', catalogSection),
  measure('Description: render_ui full (base + catalog, both paths)', renderUiFullDescription),
  measure('Model-visible total, render_ui (schema + description, Claude path)', claudeRenderUiSchema + renderUiFullDescription),
  measure('Model-visible total, render_ui (schema + description, Pi path)', JSON.stringify(piRenderUi.inputSchema) + renderUiFullDescription),
  measure('Model-visible total, generate_app (schema + description, Claude path)', claudeGenerateAppSchema + TOOL_DESCRIPTIONS.generate_app),
  measure('Model-visible total, generate_app (schema + description, Pi path)', JSON.stringify(piGenerateApp.inputSchema) + piGenerateApp.description),
]

// ── Render markdown ──────────────────────────────────────────────────────────

const date = new Date().toISOString().slice(0, 10)
const sha = getCommitSha()

const table = [
  '| Measurement | chars | UTF-8 bytes | est. tokens (chars/4) |',
  '|---|---:|---:|---:|',
  ...rows.map(r => `| ${r.label} | ${r.chars.toLocaleString('en-US')} | ${r.bytes.toLocaleString('en-US')} | ~${r.estTokens.toLocaleString('en-US')} |`),
].join('\n')

const report = `# render_ui / generate_app schema-size baseline (P2-2a)

Date: ${date} · Commit: \`${sha}\` · Produced by \`bun scripts/genui-bench/schema-size.ts\`

Token figures are **estimates at chars/4** (no tokenizer dependency; actual
counts vary by model/tokenizer). Bytes are UTF-8 via TextEncoder; chars are
JS string length. Pi/MCP numbers come from \`getToolDefsAsJsonSchema()\` output
as shipped; Claude-path numbers use the same \`zod-to-json-schema\`
(\`$refStrategy: 'none'\`, \`$schema\`/\`additionalProperties\` stripped)
conversion that function performs internally — mirroring what the Claude SDK
serializes from the zod \`.shape\` tools.

${table}

This is the pre-P1-1 baseline: the slimming pass (description dedupe,
constraint pushdown) diffs against this table and re-runs the same script.
`
process.stdout.write(`${report}\n`)

mkdirSync(dirname(REPORT_PATH), { recursive: true })
writeFileSync(REPORT_PATH, report)
process.stdout.write(`\nWritten: ${resolve(REPORT_PATH)}\n`)
