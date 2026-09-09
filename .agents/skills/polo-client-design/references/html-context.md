# Bundled HTML design context

The canonical design context is stored inside this skill at `../assets/design-context/`. Do not read or copy a sibling `design-demos` directory during ordinary use.

## Entrypoints

- `assets/design-context/prototype.html`: self-contained, interactive full-client HTML. Open it directly with `file://`; it has no external script, stylesheet, or network dependency.
- `assets/design-context/components/index.html`: index of self-contained component examples grouped by lifecycle, workbench, assistant, resources, apps, settings, organization, and system.
- `assets/design-context/scene-catalog.json`: available scenes, states, themes, languages, and source-provenance mappings.
- `assets/design-context/src/`: editable modular source for the canonical HTML.
- `assets/design-context/SCENE-TRACEABILITY.md` and `SOURCE-EVIDENCE.md`: fidelity boundary and evidence per scene.

The full prototype query contract is:

```text
prototype.html?scene=<id>&state=<state>&theme=light|dark&lang=<locale>
```

Start from an existing scene/state. For example, a settings-page design should inspect the `settings` scene and relevant `components/settings/*.html`; a button adjustment should compare its resting, hover/focus, disabled, and open/selected patterns in the closest component family; a new shell prototype should reuse `src/source/PoloShell.jsx` and the scene router.

## SOT precedence

1. Normative rules in `references/`.
2. Editable prototype source under `assets/design-context/src/`.
3. Generated `prototype.html` and `components/` output, which must match that source.
4. Screenshots, which are evidence snapshots and may have explicit gaps.
5. Upstream source paths and commits, used only as provenance or during a requested refresh.

Fixture account, workspace, organization, catalog, conversation, and permission data demonstrates states; it is not a product-data contract. Electron Main, Preload, BrowserView, OS dialogs, and real IPC remain native boundaries that standalone HTML cannot implement.

## Editing

Edit modular source and styles, not generated HTML. Regenerate `prototype.html` with `tools/export-single-file.mjs` and component pages with `tools/export-component-gallery.mjs`, then run `tools/validate-prototype.mjs` and the skill validator. Any change to generated HTML without the matching source change fails the SOT model.


After export run `python3 .agents/skills/polo-client-design/scripts/sync_asset_metadata.py` from the repository root. It updates only artifact sizes, counts and digests, without changing version, approvals, delivery or release evidence. Static validation is read-only.

For common-rule changes follow [design-iteration.md](design-iteration.md). Source fidelity needs a scoped source comparison, browser verification needs actual browser evidence, and product acceptance needs product-level evidence. Bind each new evidence record to its exact artifact hash/design commit and scope. Old screenshots and imported verification labels describe historical observations only; they do not verify a regenerated candidate.
