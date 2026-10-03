# r15 copy cleanup — 2026-10-03

Revision: `poo70-workbench-r15-copy-cleanup`.

This is an incremental revision authorized by the user after the circle-copy audit. Product authority is `docs/client-journey-review/spec.md` §13.13; the current prototype is the object being edited. b82fa1e5 colors and the existing assistant implementation boundary (§13.11) remain applicable. MVP is authored in `prototype.html`; the assistant is authored in `design-demos/polo-client-source-baseline/src/` and both outputs are rebuilt with `tools/build_review.py`.

Changes:

- Skill detail uses one name and purpose; uninstall retains its operation heading. Built-in and circle skills remain distinct.
- Circle content headings are “应用 / 技能”; installation guidance appears once per relevant skill.
- Subscription headers show identity/status. Monthly/free/annual terms, price and expiry are shown once in the detail area. Next-year entitlement and renewal-limit facts remain.
- Generic settings subtitles are removed; scope and logout consequences remain.
- Stop progress count, progress bar and task rows advance together only after a real confirmation; review entry starts at 0/3. Cancellation/reset invalidate old callbacks.
- Five legacy catalog scenes reuse the full current catalog, retain source withdrawal and local hide/restore, and remove manual favorites/5-item limits. Existing scene IDs remain available. Enterprise empty-state header now reuses the current enterprise header structure, correcting an inherited nesting defect found in independent review.

Validation evidence is revision/hash bound in `quality-report.json`. `copy-cleanup.json` covers the changed semantics and new feedback; the full shared browser suite and existing workbench, closure, invariants, continuity, navigation and style checks cover consumers. The style comparison preserves the already accepted homepage-colored assistant canvas exception. The independent reviewer records raw observations and resolved findings separately under `independent/`.

A narrow-screen test initially tried to count a hidden detail heading and later to click a list hidden by an open detail panel. The test now follows the real return-to-list/drilldown path. A closure run timed out during scene selection while multiple suites were running; the cause was not established, and a fresh rerun passed. The successful rerun is retained as the current evidence. These were not waived as passes.

The upstream single-surface validator still rejects this repository's existing two-surface schema (actual output retained in `upstream-validator.json`). Use the repository `validate_unified.py --quality-report ...` contract. This is a static prototype review, not real Electron/API/payment/install acceptance or proof of existing-assistant pixel fidelity.

Final results: 2190 scene/viewport/protocol observations, 5008 assistant-action observations (552 disabled fixture observations), 180 closure actions, 208 focused checks; no page errors or external requests. Five generated outputs reproduce byte-for-byte. Independent semantic review passed with the header finding resolved.
