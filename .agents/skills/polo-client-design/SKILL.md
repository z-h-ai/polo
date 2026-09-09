---
name: polo-client-design
description: Apply and iterate the Polo desktop-client design specification and bundled prototypes, or reconcile confirmed designs with a published release. Use for client UI design, implementation and review.
---

# Polo Client Design

This repository-owned skill is the design SOT. Its normative references and editable `assets/design-context/` define target behavior; `references/source.json.release`, source hashes and `tokens.json` describe published evidence. Approved designs may become the public specification on `main` before product implementation or release.

## Choose the mode

- **Use the specification** (including new pages reusing existing components): follow the saved rules below. Keep page-specific content in its task. Do not create a public design change unless common rules change.
- **Iterate design**, e.g. “迭代设置页布局” or “确认当前设计并集成”: read [design-iteration.md](references/design-iteration.md). Work from `main` in an independent worktree, edit candidate rules and bundled prototype source, show before/after states, obtain confirmation of the exact design, validate, then integrate a standalone commit under repository rules. Design confirmation and Git publication authorization are separate; reuse authorization already given.
- **Refresh release evidence**, e.g. “更新到最新已发布版本” or “核对新版本是否实现已确认设计”: read [update-workflow.md](references/update-workflow.md). Pin a stable Release and reconcile each confirmed target. Preserve pending and partially implemented targets; show conflicts with a repair recommendation.

Ordinary use is offline. Do not query GitHub, inspect a `design-demos` copy, or re-derive rules from the current product checkout. Read [source.md](references/source.md) only when exact provenance or delivery status matters.

## Use the saved specification

1. Read [foundations.md](references/foundations.md) for theme, type, spacing, radius and elevation.
2. Read task-relevant [layout.md](references/layout.md), [components.md](references/components.md), or [interaction-states.md](references/interaction-states.md).
3. For prototypes and visual review, read [html-context.md](references/html-context.md), then reuse bundled scenes and component HTML.
4. Record the adopted public design commit in implementation tasks. Existing tasks keep their pinned version; compare changes explicitly before upgrading. New tasks use current `main`.

Normative targets override editable prototype source, which overrides generated HTML, then screenshots. Report internal mismatches. **Observed** released behavior and **unproven** notes are evidence labels, not implicit product decisions. Explicitly approved targets may differ from released values; preserve those values' source labels.

Reuse an exported `@polo-ai/ui` component, then a renderer primitive, then an established feature component when one expresses the behavior. Upstream paths are provenance, not prototype runtime dependencies.

## Checks

From the repository root:

```bash
python3 .agents/skills/polo-client-design/scripts/validate_skill.py
python3 .agents/skills/polo-client-design/scripts/validate_skill.py --for-promotion
```

The default checks permit structured drafts. Promotion rejects drafts and stale confirmations, but permits approved designs with `pending` delivery. Static checks do not prove source fidelity, browser behavior, or product acceptance. This skill does not authorize product UI changes, automatic approvals, production releases, or task orchestration.
