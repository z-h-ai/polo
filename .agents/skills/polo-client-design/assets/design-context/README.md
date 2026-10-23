# Polo client canonical design context

This directory is the editable and runnable HTML design context owned by the `polo-client-design` skill. It is the canonical copy; ordinary design work must not depend on a worktree-specific `design-demos` directory.

## Use

Open the self-contained `prototype.html` directly, optionally with:

```text
?scene=home&state=normal&theme=light&lang=zh-Hans
```

Open `components/index.html` for grouped, self-contained component pages. Consult `scene-catalog.json`, `SCENE-TRACEABILITY.md`, and `SOURCE-EVIDENCE.md` before treating fixture content as product behavior.

For modular development, run from the repository root after installing its dependencies:

```bash
node_modules/.bin/vite --config .agents/skills/polo-client-design/assets/design-context/vite.config.mjs
```

Then open `http://localhost:4183/`.

## Ownership

- `src/`: canonical editable prototype source.
- `prototype.html`: generated self-contained full-client review artifact; do not edit directly.
- `components/`: generated self-contained component gallery; do not edit directly.
- `scene-catalog.json`: stable scene/state contract.
- `SCENE-TRACEABILITY.md` and `SOURCE-EVIDENCE.md`: fidelity and limitation evidence.
- `prototype-manifest.json`: SOT version, upstream provenance, coverage, and validation state.
- `tools/`: regeneration and validation utilities.

The package was initially imported from a static Renderer reconstruction at Polo commit `01f4447cf77612ca2c62d9c7155601a51bdb7b5b`. That commit is provenance, not a live filesystem dependency. Account, organization, app-catalog, conversation, and permission values that cannot be derived uniquely remain named deterministic fixtures.

## Update

Edit `src/` and the evidence/catalog files, then regenerate:

```bash
node .agents/skills/polo-client-design/assets/design-context/tools/export-single-file.mjs
node .agents/skills/polo-client-design/assets/design-context/tools/export-component-gallery.mjs
node .agents/skills/polo-client-design/assets/design-context/tools/validate-prototype.mjs
```

An SOT update is complete only when the generated artifacts, manifest, source traceability, and outer skill validation all agree. Electron Main, Preload, BrowserView, OS dialogs, and live IPC remain explicit standalone-HTML boundaries.
