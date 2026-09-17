# Home POO-43 aligned visual reference — binding contract (v1)

Reference artifact:
[`space-home-poo43-aligned-light-zh-Hans-desktop.html`](./space-home-poo43-aligned-light-zh-Hans-desktop.html)

Repository-owned, versioned, portable (inlined CSS) POO-43 Home visual
reference. It is the ACTIVE Home parity authority for POO-43. The historical
frozen POO-41 artifact
(`.pipeline/acceptance-repair-poo43/frozen-sources/poo41/space-home-light-zh-Hans-desktop.html`,
SHA-256 `875404db3e03ffccb4aafa8a6d3dae3c9512022a7936365eab410495319ac887`)
stays byte-for-byte immutable as HISTORICAL PROVENANCE and is no longer the
active POO-43 binding. The `0.02` region threshold is unchanged and every
in-region difference counts.

## Decision provenance

User decision `preserve-oracle-add-aligned-reference`, deterministically
mapped to `home-add-versioned-aligned-reference`
(`.pipeline/runs/c6aefca9/decision-resume.json`, request
`2c7ac5d8-r57-d1`).

## Required current behavior (must be present)

- Hero `早上好` with lead `在 我的空间 继续今天的工作。Apps、文件和运行状态始终跟随当前空间。`
  and the circles quiet-link `我的圈子 · 3 个`.
- Section head `常用 Apps` with BOTH `管理首页 Apps` and `全部 Apps`
  quiet-link controls.
- Exactly three quick-entry cards: `Polo 助手` (accent `✦` tile, source
  `Polo 内置`, primary `打开助手`), `客户访谈整理` (`▣` tile, source
  `认证创作者 · 北极星共创社`, ghost `打开`), `素材清洗器` (`▦` tile,
  source `认证创作者 · 北极星共创社`, ghost `打开`).
- The home management dialog entry (`管理首页 Apps`) is shortcut-only.

## Excluded historical controls (must be absent)

- `管理 Skills` (any Skills-management control).
- `2 个 Skill 已启用` (Skills-count source tail).
- `运行中` (runtime-state badge).

## Acceptance binding — all fields REQUIRED

| dimension | required value |
|---|---|
| navigation | `__e2e_view=home&__e2e_scenario=visual_home` MUST be present and the harness MUST fail closed unless the home hub resolves |
| region pair | **homologous**: production `[data-testid=home-app-hub]` ↔ reference `.main` — content-sized crops of the same homologous content; every in-region difference counts; exclusions are not permitted |
| viewports | `1440×900` desktop AND `1024×768` tablet — both REQUIRED |
| locale / theme | `zh-Hans`, light |
| threshold | region `0.02` — unchanged |
| fixture semantics | POO-42 ProductSpace isolation fences, POO-53 external/legacy sideload removal, retained withdrawn tombstones, and the POO-47 Skills/runtime exclusion are preserved |

## Source-faithfulness rules (no invented facts)

- Every visible string is derived from the production visual_home render
  (`早上好` greeting without persona, authoritative sources
  `北极星共创社`, built-in source `Polo 内置`).
- Geometry, spacing, typography, tile treatment, and shadows mirror the
  production source-derived values (card min-height 222 desktop / 210
  tablet, padding 20/18, `--shadow` two-layer elevation, gated accent/
  success/muted tokens).
- No Skills/runtime semantics are invented or restored; the assistant card
  keeps its frozen description text but loses the Skills tail and the
  `管理 Skills` action.
