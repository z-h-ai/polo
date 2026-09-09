# Isolated example: settings two columns → one column

This is a workflow demonstration, not an approved redesign. The tests use temporary copies and synthetic confirmation/evidence explicitly named as test fixtures. Nothing changes the shipped UI or bundled canonical layout.

1. A request to build a new page with existing `SettingsInput` and `SettingsToggle` follows ordinary use; keep page content in that task, with the public design commit recorded. No `design_changes` entry is needed.
2. For “迭代设置页布局”, create a design worktree from `main`. Goal: stack labels above controls so long explanations read consistently. Scope: `settings.layout`, `settings.error-placement`. Before: label/control split across a row; after: one vertical group per setting. Preserve navigation, token colors, control behavior and unrelated scenes. Review normal, focus, disabled, error and 800×600/light/dark states.
3. Add a draft entry (shown below), edit `references/layout.md`, the relevant settings source and style, export HTML and synchronize metadata. Present both versions. Default validation passes; promotion fails with `draft cannot be promoted`.
4. After the user confirms the exact candidate, record the real statement reference and fingerprint. Change `design_status` to `approved`; advance `design_context.version` and prototype `baselineVersion` to `1.0.1`, then sync metadata. Delivery remains `pending`. Promotion can now pass; create the independent design commit and integrate with the available Git authorization. An extra gap/color edit afterward invalidates confirmation until the delta is reconfirmed.
5. A later implementation task pins that design commit. Once both scope items are proven, attach full implementation commit/reference/scope and mark `implemented`. If only layout is done, keep `pending` and record error placement as outstanding.
6. “核对新版本是否实现已确认设计”: create the per-scope review JSON in [update-workflow.md](update-workflow.md). A Release still showing two columns gets `missing` for layout; recommend implementing the vertical group. Partial error placement remains outstanding. The helper reports `target_action: preserve`; no target or token is overwritten. Only complete evidence supports `released`, with both implementation and stable Release records.

Draft entry (replace the baseline with the actual starting full commit):

```json
{
  "id": "settings-single-column",
  "goal": "Stack labels above controls for readable long descriptions",
  "scope": ["settings.layout", "settings.error-placement"],
  "changes": "Replace label/control columns with vertical groups; show errors below controls",
  "out_of_scope": "Navigation, token colors, control behavior and unrelated scenes",
  "states": ["normal", "focus", "disabled", "error", "narrow", "dark"],
  "baseline_commit": "938a1768f558e19ba5a072e7bafa7400fc804db1",
  "version": "1.0.1",
  "design_status": "draft",
  "delivery_status": "pending",
  "confirmation": null
}
```

For a separate color iteration, write `target (change ID): <new value>` in foundations and prototype CSS, retaining `observed (v0.16.3, renderer index.css): oklch(0.62 0.13 293)`. The release token snapshot stays byte-identical until a real release extraction. Do not bundle an unrequested color change into this layout proposal.

Run `scripts/test_tools.py` from the skill to exercise isolated migration, draft/approval/reconfirmation, token separation, release gaps/conflicts, missing evidence, supersession and deterministic metadata scenarios. Tests cannot supply actual user approval, browser review or product acceptance.
