# Catalog two-source visual reference — binding contract (v2)

Reference artifact:
[`app-catalog-two-source-light-zh-Hans-desktop.html`](./app-catalog-two-source-light-zh-Hans-desktop.html)

Repository-owned, versioned, portable (frozen CSS inlined) Catalog visual
reference aligned with the **authoritative human Catalog oracle**. The
historical frozen reference
(`.pipeline/acceptance-repair-poo43/frozen-sources/poo41/app-catalog-light-zh-Hans-desktop.html`)
stays byte-for-byte immutable; this reference supersedes it ONLY as the
visual baseline for the two-source searched Catalog state. The `0.02` region
threshold is unchanged and every in-region difference counts.

## Authoritative oracle

- Query `商务写作` in 搜索当前空间的 App.
- Exactly TWO independent rows — same App name `商务写作`, distinct artifact
  instances and sources:
  1. 来自 桥见圈子 · 桥见圈子来源的商务写作 App。 · 桥见圈子 · v1.6.0 · 可用 ·
     actions 显示在首页 + 打开
  2. 来自 北极星共创社 · 北极星圈子来源的同名 App。 · 北极星共创社 · v2.0.0 · 可用 ·
     action 打开
- Exact visible count: `显示 2 / 7 个 Apps`.

## Acceptance binding (next Acceptance plan) — all fields REQUIRED

| dimension | required value |
|---|---|
| navigation | `?scene=app-catalog` MUST be present; the harness MUST resolve and record the scene, and FAIL CLOSED unless it resolves to `app-catalog` |
| query state | search input value `商务写作` applied before the region screenshot |
| locale | `zh-Hans` |
| theme | light |
| viewports | 1440x900 desktop AND 1024x768 tablet — both REQUIRED (tablet is not optional) |
| persona / fixture | the visual fixture set: 桥见圈子 + 北极星共创社 + 视觉创作圈子 circles; two `商务写作` entries with distinct `artifactInstanceId`; three withdrawn tombstones; the built-in Polo assistant |
| region pair | **homologous**: production `[data-testid=all-apps-view]` (subhead + search + section) ↔ reference `.catalog-view` (subhead + search + section). Both crops contain the same homologous content and are content-sized; every in-region difference (icon tiles vs glyph boxes, personas, minor copy) counts toward the ratio — exclusions are not permitted. |
| threshold | region `0.02` — every in-region difference counts; exclusions are not permitted |

## Source-faithfulness rules (no invented facts)

- Every visible string is derived from the visual fixture or the production
  render: source lines use the AUTHORITATIVE source names (`桥见圈子`,
  `北极星共创社` — exactly as the production rowTexts render:
  `桥见圈子 · v1.6.0`, `北极星共创社 · v2.0.0`); no invented creator-studio
  names.
- The section description's circle count (`3 个圈子`) mirrors the visual
  fixture's authoritative circle set (桥见圈子, 北极星共创社, 视觉创作圈子 —
  the third via the enabled Skill entry), exactly as production's
  `creatorCircles` projection renders.
- No `highlighted` row: production renders no highlight in the searched
  Catalog state.
- The greeting persona is NOT part of this Catalog region.
