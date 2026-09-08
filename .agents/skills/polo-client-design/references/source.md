# Source manifest

The skill itself is the design SOT. The following stable GitHub Release is its current upstream comparison baseline, not a runtime dependency:

- Product version: `v0.16.3`
- Release name: `v0.16.3`
- Published: `2026-08-10T16:29:28Z`
- Tag: `v0.16.3`
- Full commit: `18e7914c0d432e6d10dad2473c04d6221fa088d9`
- Repository: `z-h-ai/polo`
- Release status: published, non-draft, non-prerelease

Machine-verifiable upstream metadata, focal-file hashes, and the covered-tree digest are in [source.json](source.json). Generated token evidence is in [tokens.json](tokens.json). The bundled HTML context has its own canonical version, inventory digest, and import provenance in the same manifest.

## Coverage

The comparison boundary covers the full released trees for:

- `apps/electron/src/renderer`: desktop shell, feature UI, primitives, styles, state, and assets.
- `packages/ui/src`: shared components, styles, layouts, icons, overlays, and interaction helpers.
- `packages/shared/src/config/theme.ts`: theme types, resolution, defaults, and CSS conversion.
- `apps/electron/resources/themes`: bundled preset theme resources.
- `apps/webui/src`: web consumer styles and composition that may reveal shared-component constraints.

The initial inventory contains 793 blobs. Focal files in `source.json` carry summaries and content hashes, but the inventory digest covers the complete boundary so additions, removals, and renames are not hidden by a hand-picked file list.

## Evidence policy

Released source is authoritative for observable UI. Comments that describe intent are supporting context, not proof of a product rule. If behavior cannot be demonstrated by the covered source, it must be labeled unproven and cannot become a mandatory rule.

The old `docs/DESIGN.md` claimed a vivid `#5e17eb` / `oklch(0.44 0.30 285)` accent and other exact values not present in this release. Those claims were not carried forward. The released Electron and shared-package accent divergence is recorded in [foundations.md](foundations.md) rather than collapsed into an invented value.

## Bundled design-context provenance

The canonical HTML package is `assets/design-context`, version `1.0.0`. It was imported from the prior static Renderer reconstruction at commit `01f4447cf77612ca2c62d9c7155601a51bdb7b5b`, then made path-independent and placed under skill ownership. That commit remains provenance; ordinary design work reads only the skill-owned copy.

The bundled package contains editable source, a self-contained full prototype, self-contained component HTML, exact assets, deterministic fixtures, source traceability, and screenshots. Known Electron/native and runtime-data limitations remain explicit in its manifest and evidence documents rather than being promoted to verified behavior.

There is one explicit provenance split: the normative upstream comparison baseline is Release `v0.16.3` at `18e7914…`, while the initially imported HTML reconstruction records `01f4447…`. For example, ordinary settings-page design follows the skill references and bundled settings scene, not whichever checkout happens to contain either commit. The recommended next manual refresh is to align both records against one stable Release; until then, the SOT precedence in [html-context.md](html-context.md) resolves conflicts and the two revisions must not be presented as identical.
