# Refresh published evidence

Run after an explicit release-refresh request. It updates published evidence and reconciles confirmed targets. Design iteration may proceed independently of Release; see [design-iteration.md](design-iteration.md). Work on a candidate copy/worktree and keep the last valid specification intact until review and validation pass.

## 1. Resolve a published source

From the repository root, verify the project identity before querying releases:

```bash
direnv exec . gh api user --jq .login
```

Use `compare_source.py --target latest` for the newest stable Release or `--target vX.Y.Z` for an explicit stable Release. The tool rejects drafts and prereleases. It is read-only and prints JSON.

Use a temporary clone so the current worktree and branch are never switched and unpublished local changes cannot enter the release evidence:

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

Do not treat filenames or hashes as semantic analysis. Read affected components. Before changing any target, reconcile each approved design against the release as described below. Update observed-source annotations where needed. A changed Release never implicitly replaces an approved target. Do not import or update a `design-demos` copy. Include a concise before/after example in the local review summary.

## 3. Reconcile each confirmed target

Read every active approved entry in `source.json.design_changes`, including pending designs. For each scope item report `matches / partial / missing / conflict`, a concrete `observed` behavior, and an `evidence` reference to the pinned source or actual runtime check. Nonmatching items also need `remaining` scope and a repair `recommendation`.

For example: target settings are single-column, but the new Release still uses two columns. Keep the single-column target and pending delivery; recommend implementing the approved stacking rule. If layout matches but error placement does not, retain the error placement in remaining scope. Do not call the design released based on hashes or a subset of screens.

Prepare a review JSON with `release` (the exact `compare_source.py` output `to` object) and `changes: [{id, design_fingerprint, items: [{scope, outcome, observed, evidence, remaining, recommendation}]}]`. Validate it with:

```bash
python3 .agents/skills/polo-client-design/scripts/reconcile_release.py --review /path/to/review.json
```

The helper is read-only, requires every approved change and scope exactly once, and always preserves targets. It reports complete coverage without automatically changing delivery. Inspect actual evidence before recording implementation/release status, using the [metadata contract](design-iteration.md). Missing/partial targets retain their prior delivery state and outstanding scope; conflicts get a concrete repair proposal. Superseded designs retain their history and replacement relationship.

A normative redesign discovered during release review enters design iteration for confirmation. Do not overwrite a target with product behavior. Refresh may update observed annotations while preserving the approved target; because normative files are fingerprinted conservatively, explain the annotation-only delta and renew the current confirmation if that fingerprint changes. Release metadata/token-only updates need no design revision or confirmation.

## 4. Regenerate evidence and any changed artifacts

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

Only confirmed design revisions increment the design version. After any generation, synchronize mechanical metadata:

```bash
python3 .agents/skills/polo-client-design/scripts/sync_asset_metadata.py
```

This changes sizes, counts and hashes only; confirmation, delivery, version and release baselines remain unchanged. Generated `prototype.html` and component pages must have matching modular-source changes; never hand-edit them as the only change.

## 5. Validate before keeping the update

Run:

```bash
python3 .agents/skills/polo-client-design/scripts/validate_skill.py
python3 .agents/skills/polo-client-design/scripts/validate_skill.py --for-promotion
python3 .agents/skills/polo-client-design/scripts/test_tools.py
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" \
  .agents/skills/polo-client-design
git diff -- .agents/skills/polo-client-design docs/DESIGN.md
```

Validation must use a repository containing the pinned commit. If validation or semantic review fails, discard only this attempt’s candidate edits (preserving any pre-existing user edits) and report the exact missing evidence. Never overwrite the last valid specification with partial metadata.

## Failure guarantees

Release lookup, authentication, invalid tags, drafts, prereleases, missing commits, and source-read errors stop before any SOT write. The comparison tool never edits the skill. Token output uses an atomic replacement only after complete extraction. No script commits, pushes, publishes, edits `design-demos`, or changes product UI.
