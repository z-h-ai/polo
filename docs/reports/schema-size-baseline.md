# render_ui / generate_app schema-size baseline (P2-2a)

Date: 2026-10-18 · Commit: `825742abbaec3a67e50db905de72d2633e7c1575` · Produced by `bun scripts/genui-bench/schema-size.ts`

Token figures are **estimates at chars/4** (no tokenizer dependency; actual
counts vary by model/tokenizer). Bytes are UTF-8 via TextEncoder; chars are
JS string length. Pi/MCP numbers come from `getToolDefsAsJsonSchema()` output
as shipped; Claude-path numbers use the same `zod-to-json-schema`
(`$refStrategy: 'none'`, `$schema`/`additionalProperties` stripped)
conversion that function performs internally — mirroring what the Claude SDK
serializes from the zod `.shape` tools.

| Measurement | chars | UTF-8 bytes | est. tokens (chars/4) |
|---|---:|---:|---:|
| Pi/MCP path: render_ui inputSchema (JSON.stringify) | 10,073 | 10,113 | ~2,519 |
| Pi/MCP path: generate_app inputSchema (JSON.stringify) | 533 | 533 | ~134 |
| Claude path: RenderUiSchema → JSON Schema | 10,073 | 10,113 | ~2,519 |
| Claude path: GenerateAppSchema → JSON Schema | 533 | 533 | ~134 |
| Description: render_ui base (TOOL_DESCRIPTIONS.render_ui) | 3,046 | 3,072 | ~762 |
| Description: generate_app base (TOOL_DESCRIPTIONS.generate_app) | 2,024 | 2,044 | ~506 |
| Description: render_ui catalog section (buildRenderUiCatalogSection, builtin) | 755 | 771 | ~189 |
| Description: render_ui full (base + catalog, both paths) | 3,803 | 3,845 | ~951 |
| Model-visible total, render_ui (schema + description, Claude path) | 13,876 | 13,958 | ~3,469 |
| Model-visible total, render_ui (schema + description, Pi path) | 13,876 | 13,958 | ~3,469 |
| Model-visible total, generate_app (schema + description, Claude path) | 2,557 | 2,577 | ~640 |
| Model-visible total, generate_app (schema + description, Pi path) | 2,557 | 2,577 | ~640 |

This is the pre-P1-1 baseline: the slimming pass (description dedupe,
constraint pushdown) diffs against this table and re-runs the same script.
