---
name: polo-client-design
description: Apply or manually refresh the versioned Polo desktop-client design specification for Electron UI implementation, prototypes, settings screens, component changes, and UI review.
---

# Polo Client Design

This skill directory is the single source of truth (SOT) for Polo desktop-client design. Its references define the rules and its bundled `assets/design-context/` contains the canonical editable prototype source, self-contained HTML, component gallery, scene catalog, and evidence. Ordinary use is offline: do not query GitHub, inspect a `design-demos` copy, or re-derive rules from the current worktree unless the user explicitly asks to update the SOT.

## Use the saved specification

1. Read [references/foundations.md](references/foundations.md) for theme, type, spacing, radius, and elevation rules.
2. Read only the task-relevant detail:
   - Shells, panels, page structure, or responsive behavior: [references/layout.md](references/layout.md)
   - Controls, settings, menus, dialogs, and reuse choices: [references/components.md](references/components.md)
   - Hover, focus, open, disabled, loading, errors, and motion: [references/interaction-states.md](references/interaction-states.md)
3. For prototypes or visual review, read [references/html-context.md](references/html-context.md), then reuse the bundled scene or component HTML.
4. When exact values or upstream provenance matter, consult [references/source.md](references/source.md) and the generated [references/tokens.json](references/tokens.json).

For design and prototype decisions, the bundled context wins; production source paths recorded there are provenance, not runtime dependencies. During implementation, locate and reuse the named production component when it exists: prefer an exported component from `@polo-ai/ui`, then an Electron renderer primitive, then an established feature component. Create a new primitive only when none expresses the required behavior.

Treat rules marked **observed** as implementation evidence, not a universal product decision. Treat **unproven** notes as context only. Within the SOT, normative references override prototype fixtures, and prototype fixtures override screenshots. Upstream source is consulted only during an explicit refresh. Report an internal mismatch instead of silently choosing a value.

## Update the saved specification

Enter update mode only for an explicit request such as:

```text
$polo-client-design 更新到最新已发布版本
$polo-client-design 更新到已发布版本 vX.Y.Z
```

Read and follow [references/update-workflow.md](references/update-workflow.md). An update must pin a real non-draft, non-prerelease GitHub Release to its full commit, compare the complete covered UI source set from a temporary checkout, review semantic changes, update the affected normative references and bundled design-context source, regenerate HTML/tokens, and pass validation. Merely changing release metadata or file hashes is not success.

On any release lookup, source, or semantic-review failure, leave the last valid specification intact and list the unfinished items. Never commit, push, publish, or modify product UI as part of a specification refresh unless separately requested.
