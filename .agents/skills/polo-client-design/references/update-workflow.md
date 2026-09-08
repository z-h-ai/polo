# Manual update workflow

Run this workflow only after an explicit SOT-update request. It updates the skill's normative references and bundled HTML context, not product UI.

## 1. Resolve a published source

From the repository root, verify the project identity before querying releases:

```bash
direnv exec . gh api user --jq .login
```

Use `compare_source.py --target latest` for the newest stable Release or `--target vX.Y.Z` for an explicit stable Release. The tool rejects drafts and prereleases. It is read-only and prints JSON.

Use a temporary clone so the current worktree and branch are never switched and unpublished local changes cannot enter the specification:

```bash
tmp_dir="$(mktemp -d)"
git clone --filter=blob:none --no-checkout "$(git remote get-url origin)" "$tmp_dir/source"
python3 .agents/skills/polo-client-design/scripts/compare_source.py \
  --repo "$tmp_dir/source" \
  --target latest
```

Keep the temporary directory only while reviewing the diff. Remove it afterward using its exact resolved path.

## 2. Review the complete change boundary

The comparison output covers all prefixes in `source.json` and reports added, deleted, modified, and renamed paths. Use its section hints to read affected theme, layout, component, interaction, asset, and web-consumer files from the temporary clone.

Examples:

- A light/dark token change requires regenerating tokens and reviewing [foundations.md](foundations.md).
- `OldButton.tsx -> Button.tsx` is a rename, not both deletion and addition; review exports and behavior before changing reuse guidance.
- A newly exported shared component may change [components.md](components.md) even if tokens are unchanged.
- A release with only server code changes produces no covered UI changes; keep prose and token snapshots unchanged, but update source metadata only after confirming the covered tree digest is identical.

Do not treat filenames or hashes as semantic analysis. Read affected components and update only the normative sections and `assets/design-context/src/` modules whose released behavior changed. Do not import or update a `design-demos` copy. Include a concise before/after example in the local review summary.

## 3. Regenerate the skill-owned artifacts

After updating `source.json` to the candidate release and focal hashes, generate tokens from the candidate repository:

```bash
python3 .agents/skills/polo-client-design/scripts/extract_tokens.py \
  --repo "$tmp_dir/source" \
  --ref <full-commit> \
  --output .agents/skills/polo-client-design/references/tokens.json
```

Do not add timestamps. Repeating extraction for the same commit must be byte-identical.

Rebuild the HTML from the source inside the skill. The scripts resolve the repository root dynamically and may be overridden with `POLO_REPO_ROOT` or `VITE_BIN` when dependencies are installed elsewhere:

```bash
node .agents/skills/polo-client-design/assets/design-context/tools/export-single-file.mjs
node .agents/skills/polo-client-design/assets/design-context/tools/export-component-gallery.mjs
node .agents/skills/polo-client-design/assets/design-context/tools/validate-prototype.mjs
```

Update `source.json.design_context` with the new SOT version and deterministic asset inventory. Generated `prototype.html` and component pages must have matching modular-source changes; never hand-edit them as the only change.

## 4. Validate before keeping the update

Run:

```bash
python3 .agents/skills/polo-client-design/scripts/validate_skill.py
python3 .agents/skills/polo-client-design/scripts/test_tools.py
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" \
  .agents/skills/polo-client-design
git diff -- .agents/skills/polo-client-design docs/DESIGN.md
```

Validation must use a repository containing the pinned commit. If validation or semantic review fails, restore only the attempted skill/doc changes to the last valid content and report the exact missing evidence. Never overwrite the last valid specification with partial metadata.

## Failure guarantees

Release lookup, authentication, invalid tags, drafts, prereleases, missing commits, and source-read errors stop before any SOT write. The comparison tool never edits the skill. Token output uses an atomic replacement only after complete extraction. No script commits, pushes, publishes, edits `design-demos`, or changes product UI.
