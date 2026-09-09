# Catalog two-source visual reference — binding contract

Reference artifact: [`app-catalog-two-source-light-zh-Hans-desktop.html`](./app-catalog-two-source-light-zh-Hans-desktop.html)

Versioned, repository-owned, portable (self-contained CSS) Catalog visual
reference aligned with the **authoritative human Catalog oracle**:

- Query `商务写作` in 搜索当前空间的 App.
- Exactly TWO independent rows — same App name, distinct artifact instances
  and sources:
  1. 商务写作 · 来自 桥见圈子 · 桥见创作室 · v1.6.0 · highlighted · 显示在首页 + 打开
  2. 商务写作 · 来自 北极星共创社 · 北极星创作室 · v2.0.0 · 打开
- Exact visible count: `显示 2 / 7 个 Apps`.

The historical frozen reference
(`.pipeline/acceptance-repair-poo43/frozen-sources/poo41/app-catalog-light-zh-Hans-desktop.html`,
one row / `显示 1 / 7 个 Apps`) stays byte-for-byte immutable; this reference
supersedes it ONLY as the visual baseline for the two-source Catalog state.
The `0.02` region threshold is unchanged.

## Acceptance binding (next Acceptance plan)

| dimension | required value |
|---|---|
| navigation | `?scene=app-catalog` MUST be present; fail closed unless the resolved scene is `app-catalog` |
| query state | search input value `商务写作` applied before the region screenshot |
| locale | `zh-Hans` |
| theme / viewport | light, 1440x900 (desktop), 1024x768 (tablet optional) |
| persona / fixture | visual fixture data — two `商务写作` catalog entries from 桥见圈子 and 北极星共创社 (distinct `artifactInstanceId`), plus the space's other entries for the total count of 7 |
| region pair | production `[data-testid=all-apps-view]` vs reference `.section` |
| threshold | region `0.02` (unchanged) |

## Known non-comparabilities (disclosed)

- The production All Apps view renders the authoritative Catalog: every
  accessible App plus withdrawn tombstones with their reason lines
  (REQ-002/REQ-009/REQ-010 semantics). The frozen demo shows a 3-card
  subset; row-count differences are requirement-mandated, not product
  regressions.
- Production `AppIcon` letter tiles vs frozen soft glyph boxes are a design
  divergence tracked separately; do not force-match inside the region diff.
