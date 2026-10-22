# Foundations

Status: canonical skill-owned specification, initially verified against Polo `v0.16.3`. Exact extracted values are in [tokens.json](tokens.json); provenance is in [source.md](source.md).

## Color and themes

Polo uses six semantic anchors: `background`, `foreground`, `accent`, `info`, `success`, and `destructive`. Use their CSS variables or Tailwind semantic utilities. Do not introduce a second brand palette in feature code.

The released Electron renderer defaults are:

| Role | Light | Dark | Use |
| --- | --- | --- | --- |
| Background | `oklch(0.98 0.003 265)` | `oklch(0.145 0.015 270)` | App and panel surfaces |
| Foreground | `oklch(0.185 0.01 270)` | `oklch(0.95 0.01 270)` | Text and icons |
| Accent | `oklch(0.62 0.13 293)` | `oklch(0.65 0.22 293)` | Brand emphasis and selected/execute actions |
| Info | `oklch(0.75 0.16 70)` | `oklch(0.78 0.14 70)` | Warnings and Ask semantics |
| Success | `oklch(0.55 0.17 145)` | `oklch(0.60 0.17 145)` | Success and connected states |
| Destructive | `oklch(0.58 0.24 28)` | `oklch(0.65 0.22 28)` | Errors and destructive actions |

Derived foreground steps (`foreground-1.5`, `2`, `3`, `5`, then `10` through `95`) produce solid surfaces by mixing foreground toward background. Alpha utilities such as `bg-foreground/5` remain transparent. Use the solid step for opaque separators/surfaces and alpha for overlays or hover tinting.

Electron also derives `background-elevated`, dimmed foreground, message bubbles, borders, inputs, rings, and semantic text from the anchors. Light/dark switching must happen through the theme system, not per-component hard-coded colors. Preset theme JSON may override all six anchors and surface roles; scenic themes additionally use translucent panels and a background image.

### Known released-source divergence

The desktop renderer stylesheet uses light accent `oklch(0.62 0.13 293)`, while `packages/ui/src/styles/index.css` and `DEFAULT_THEME` use `oklch(0.58 0.22 293)`; `apps/electron/resources/themes/default.json` also contains hex preset values. For example, a new Electron settings CTA must inherit `var(--accent)` from the renderer rather than paste the shared-package value. The recommended follow-up is to unify these sources in a separate product-code change; this specification records the released behavior and does not pretend they are identical.

## Typography

The default UI stack is system UI: `system-ui`, Apple/BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif. Inter is an explicit user option through `html[data-font="inter"]`. Code uses JetBrains Mono with platform monospace fallbacks.

The root size is `15px`. Released components primarily use Tailwind `text-sm` and `text-xs`, with frequent compact `13px`, `12px`, `11px`, and `10px` labels. Use existing component typography before choosing a literal size. Standard hierarchy:

- Page/dialog title: `text-lg` or the established page primitive, semibold.
- Setting and control label: `text-sm font-medium`.
- Description/helper: `text-sm text-muted-foreground`; compact descriptions use `text-xs`.
- Dense navigation: existing 13px/12px patterns.
- Code: `font-mono`; do not apply the monospace stack to ordinary UI.

## Spacing and radii

The Tailwind spacing base is `0.25rem` (4px). Favor its scale and existing component padding. Common compact sequences are 4, 6, 8, 12, 16, 24, and 32px.

Observed radii are contextual rather than one global rounded token:

- 4px: compact icon buttons, menu items, small badges.
- 6px: dense navigation rows and compact actions.
- 8px / `rounded-md` / `rounded-lg`: standard controls and popovers.
- 10px: panel inner corners and some compact cards/search fields.
- 14px on macOS, 8px elsewhere: shell edges touching the native window.
- Full: switches, avatars, and pill-shaped controls.

Reuse the component's radius. Do not turn an observed one-off 16px or 20px surface into a global requirement.

## Elevation and stacking

Use `shadow-minimal` for bordered controls and small surfaces, `shadow-modal-small`/`popover-styled` for elevated menus and dialogs, and stronger shared shadow utilities only when the existing surface class calls for them. Dark mode deliberately strengthens borders while avoiding decorative glow.

Use semantic z-index utilities from the released registry: titlebar 40, panel 50, dropdown 100, tooltip 150, modal 200, overlay 300, fullscreen 350, floating menu 400, island popover 410, and splash 600. Do not introduce a magic z-index between layers without checking the registry.

Sources: `apps/electron/src/renderer/index.css`, `packages/ui/src/styles/index.css`, `packages/shared/src/config/theme.ts`, and `apps/electron/resources/themes/*.json` at the pinned release commit.
