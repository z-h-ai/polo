---
version: alpha
name: polo-ai-electron-design
description: >
  Polo AI is a desktop-native Electron application for AI-assisted work.
  Its design language centers on a three-panel floating layout with frosted-glass
  elevation, an oklch-based color system that auto-derives surfaces and opacity
  ramps from two core values (background + foreground), and a system-UI type
  stack paired with JetBrains Mono for code. The accent is a vivid violet
  (#5e17eb) used sparingly for active states, CTAs, and brand marks, set against
  warm-contrast semantic colors (amber info, teal success, warm red destructive).

colors:
  # ── Core pair (everything else derives from these two) ──
  background:       "oklch(0.98 0.008 290)"    # #faf8fd — purple-tinted white
  foreground:       "oklch(0.17 0.02 290)"     # #1a1726 — deep purple-black

  # ── Brand / Accent ──
  accent:           "oklch(0.44 0.30 285)"     # #5e17eb — vivid violet
  accent-dark:      "oklch(0.52 0.28 285)"     # #7b3ff5 — lighter for dark surfaces
  on-accent:        "#ffffff"

  # ── Semantic ──
  info:             "oklch(0.72 0.16 75)"      # #d4960c — warm amber
  info-dark:        "oklch(0.76 0.15 75)"      # #e0a830
  success:          "oklch(0.58 0.14 165)"     # #0d9465 — teal green
  success-dark:     "oklch(0.68 0.14 165)"     # #14b880
  destructive:      "oklch(0.58 0.22 25)"      # #e03e3e — warm red
  destructive-dark: "oklch(0.64 0.22 25)"      # #ef5555

  # ── Dark-mode core pair ──
  background-dark:  "oklch(0.14 0.025 290)"    # #110e1d
  foreground-dark:  "oklch(0.94 0.015 290)"    # #eeeaf5

  # ── Derived surfaces (auto-computed — do NOT hard-code) ──
  # user-bubble:    oklch(from var(--foreground) l c h / 0.05)
  # bg-elevated:    color-mix(in srgb, var(--foreground) 1.5%, var(--background))
  # border:         oklch(from var(--foreground) l c h / 0.05)
  # fg-N ramp:      color-mix(in srgb, var(--foreground) N%, var(--background))
  #                 where N = 2, 3, 5, 7, 10, 20, 30, 40, 50, 60, 70, 80

typography:
  display:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.15px"
  heading:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: 0
  body-md:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  body-sm:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: 0
  label:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: 0
  caption:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: 0
  micro:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "0.75px"
  tag:
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: 10px
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: 0
  code-md:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  code-sm:
    fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: 0

rounded:
  xs: 4px
  sm: 6px
  md: 8px
  inner: 10px
  lg: 12px
  edge: 14px
  bubble: 16px
  card: 20px
  pill: 9999px

spacing:
  xxs: 2px
  xs: 4px
  sm: 6px
  md: 8px
  lg: 12px
  xl: 16px
  2xl: 20px
  3xl: 24px
  4xl: 32px
  5xl: 40px

components:
  login-card:
    backgroundColor: "oklch(from var(--background) l c h / 0.86)"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.card}"
    padding: 40px 36px 36px
    backdrop-filter: "blur(24px) saturate(140%)"
    box-shadow: "6-layer graduated shadow (1px ring + 1/3/6/12/24px blur)"
  login-button:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 10px
    box-shadow: "0 10px 24px accent at 28%"
  login-input:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.md}"
    padding: 10px 12px
    focus: "accent border + 3px accent ring at 12%"
  ghost-button:
    backgroundColor: transparent
    textColor: "fg-50"
    rounded: "{rounded.sm}"
    dimensions: 28x28
    hover: "fg-5 background, foreground color"
  floating-panel:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.inner}"
    elevation: "shadow-minimal or shadow-panel-focused"
  user-bubble:
    backgroundColor: "foreground at 5% opacity"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.bubble}"
    padding: 14px 20px
  nav-item:
    backgroundColor: "transparent / fg-7 active"
    textColor: "fg-60 / foreground active"
    typography: "{typography.body-sm}"
    rounded: "{rounded.sm}"
    padding: 5px 8px
  session-row:
    backgroundColor: "transparent / fg-3 active"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: 12px 8px
  code-block:
    backgroundColor: "fg-3"
    textColor: "{colors.foreground}"
    typography: "{typography.code-md}"
    rounded: "{rounded.md}"
    padding: 12px 16px
  tag-chip:
    backgroundColor: "fg-5"
    textColor: "fg-60"
    typography: "{typography.tag}"
    rounded: "{rounded.xs}"
    padding: 0px 6px
    height: 18px
  status-chip:
    backgroundColor: "semantic color at 8%"
    textColor: "semantic color"
    typography: "{typography.tag}"
    rounded: "{rounded.xs}"
    padding: 1px 6px
  permission-badge:
    backgroundColor: "semantic at 5–10%"
    textColor: "semantic color"
    typography: "{typography.caption}"
    rounded: "{rounded.md}"
    height: 30px
    padding: 0px 10px
  dropdown-menu:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.inner}"
    padding: 4px
    elevation: "1px ring at 6% + 6px/20px shadow"
  input-container:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "16px 20px (textarea) + 8px toolbar"
    elevation: "shadow-minimal → shadow-middle on focus"
---

## Overview

Polo AI's design language is a **desktop-native Electron application** for AI-assisted work. The visual system centers on a three-panel floating layout — left sidebar (220px), navigator panel (300px), and main content (flex) — with each panel rendered as an independent floating surface with rounded corners (`--radius-inner: 10px`) separated by a 6px gap.

The color system is built on **oklch** with just two core values: `--background` and `--foreground`. Every other surface, border, and text-opacity tint is derived automatically via `color-mix()` and oklch relative-color syntax. This means the entire palette — 13 levels of foreground opacity (fg-2 through fg-80), elevated surfaces, borders, and user bubbles — adapts instantly when the two core values change for dark mode.

The brand accent is **vivid violet** (`#5e17eb`, oklch 0.44 0.30 285), paired with a **warm-contrast semantic palette**: amber info, teal-green success, and warm red destructive. This complementary warmth creates visual energy against the cool purple anchor — the classic SaaS approach where the action color (cool) and the warning/status colors (warm) occupy different perceptual channels for maximum disambiguation.

**Key Characteristics:**
- oklch-native color system with auto-deriving surfaces from two core tokens
- Three-panel floating layout with frosted-glass elevation (backdrop-filter blur + saturate)
- System-UI sans-serif + JetBrains Mono for code — no custom brand font
- Vivid violet accent (`#5e17eb`) used sparingly as a functional color, never decorative
- Warm-contrast semantic palette: amber `#d4960c` / teal `#0d9465` / red `#e03e3e`
- 6px panel gap + 6px panel inset creates the distinctive floating-panel aesthetic
- Dark mode is a pure token swap — the entire derived palette auto-adapts

## Colors

### Color Architecture

The system uses **oklch** as its native color space, with `color-mix(in srgb, ...)` for derived surfaces. The two anchors:

- **Background** (`oklch(0.98 0.008 290)` ≈ `#faf8fd`) — near-white with a subtle purple tint. This purple warmth unifies the canvas with the violet accent.
- **Foreground** (`oklch(0.17 0.02 290)` ≈ `#1a1726`) — deep purple-black ink. Every text opacity, surface tint, and border derives from this.

### Brand & Accent
- **Accent** (`oklch(0.44 0.30 285)` — `#5e17eb`): Vivid violet. Used for: active states, CTAs (send button, login button), brand logo mark, focus rings, active session indicator.
- **Accent Dark** (`oklch(0.52 0.28 285)` — `#7b3ff5`): Lighter violet for legibility on dark surfaces. The +0.08 lightness shift keeps the accent visible against dark backgrounds.

### Semantic Colors (Warm Contrast)
- **Info** (`oklch(0.72 0.16 75)` — `#d4960c`): Warm amber. Complementary to the violet accent (hue 75 vs 285 ≈ 210° apart). Used for: warnings, quota alerts, flagged items, the "Ask" permission badge.
- **Success** (`oklch(0.58 0.14 165)` — `#0d9465`): Teal green. Sits between the warm and cool ends of the palette. Used for: completed status chips, connection success, positive indicators.
- **Destructive** (`oklch(0.58 0.22 25)` — `#e03e3e`): Warm red. High chroma for unmistakable urgency. Used for: error states, account disabled alerts, logout action, delete buttons.

### Derived Surfaces (Auto-Computed)
- **User bubble**: `oklch(from var(--foreground) l c h / 0.05)` — foreground at 5% opacity
- **Elevated**: `color-mix(in srgb, var(--foreground) 1.5%, var(--background))` — barely perceptible lift
- **Border**: `oklch(from var(--foreground) l c h / 0.05)` — consistent with user bubble
- **fg-N ramp**: `color-mix(in srgb, var(--foreground) N%, var(--background))` where N = 2, 3, 5, 7, 10, 20, 30, 40, 50, 60, 70, 80

### Dark Mode

The dark theme swaps only the two core tokens plus adjusts semantic lightness:

| Token | Light | Dark |
|---|---|---|
| background | `oklch(0.98 0.008 290)` | `oklch(0.14 0.025 290)` |
| foreground | `oklch(0.17 0.02 290)` | `oklch(0.94 0.015 290)` |
| accent | `oklch(0.44 0.30 285)` | `oklch(0.52 0.28 285)` |
| info | `oklch(0.72 0.16 75)` | `oklch(0.76 0.15 75)` |
| success | `oklch(0.58 0.14 165)` | `oklch(0.68 0.14 165)` |
| destructive | `oklch(0.58 0.22 25)` | `oklch(0.64 0.22 25)` |

Shadow opacities increase in dark mode (border: 0.08→0.15, blur: 0.06→0.12) to remain visible against dark surfaces. The entire fg-N ramp, user bubble, elevated surface, and border auto-adapt — no manual overrides needed.

## Typography

### Font Stack

**Sans** (primary): `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
**Mono** (code): `'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace`

The app uses the platform's native system font at every tier — no custom brand typeface. JetBrains Mono is loaded via Google Fonts CDN specifically for code blocks and inline code.

### Type Scale

| Token | Size | Weight | Line Height | Use |
|---|---|---|---|---|
| `display` | 20px | 600 | 1.25 | Login title, empty-state headings |
| `heading` | 14px | 600 | 1.25 | Panel headers (section titles) |
| `body-md` | 14px | 400 | 1.6 | Chat messages, inputs, buttons |
| `body-sm` | 13px | 400 | 1.35 | Nav items, session previews |
| `label` | 13px | 500 | 1.25 | Form labels, session row titles |
| `caption` | 12px | 400 | 1.35 | Code headers, preview text, badges |
| `micro` | 11px | 500 | 1.25 | Section labels (uppercase), quota |
| `tag` | 10px | 500 | 1.4 | Chips, tags, status badges |
| `code-md` | 13px | 400 | 1.6 | Code blocks (JetBrains Mono) |
| `code-sm` | 12px | 400 | 1.4 | Code header labels (JetBrains Mono) |

### Principles
- **Base size is 15px** on `<html>`, but almost all UI elements use explicit px sizes (14px body, 13px compact, 12px caption).
- **Weight 400–600 only**: no light (300) or bold (700+) in the regular UI. 700 appears only in the brand logo mark.
- **Anti-aliased rendering**: `-webkit-font-smoothing: antialiased` on body. `font-optical-sizing: auto` on html.
- **Negative letter-spacing** only on the display tier (-0.15px at 20px). Body sizes use 0.
- **Section labels** use uppercase + 0.75px letter-spacing for the "overline" pattern (11px/500/uppercase).

## Layout

### Panel Architecture

The app uses a **three-panel floating layout**:

1. **Left Sidebar** (220px fixed) — navigation tree, user menu, quota widget
2. **Navigator Panel** (300px fixed) — session list with search, grouped by time
3. **Main Content** (flex: 1) — chat display + input zone

Panels float as independent surfaces with `--radius-inner: 10px` corner radius, separated by `--panel-gap: 6px`. The outer inset is also 6px (`--panel-inset`), creating the characteristic floating-panel-in-a-shell aesthetic.

### Top Bar
- Height: `--topbar-h: 48px`
- Traffic-light room: 72px left padding on macOS
- Contains: sidebar toggle, brand logo, back/forward nav, workspace selector, add/help/theme toggle

### Chat Content
- Max width: 840px, centered in the main panel
- Scroll mask: linear-gradient fade at top and bottom (32px each)
- Message padding: 20px horizontal, 32px vertical

### Spacing Scale

| Token | Value | Use |
|---|---|---|
| `xxs` | 2px | Micro gaps, active indicator width |
| `xs` | 4px | Tight inline spacing |
| `sm` | 6px | Panel gap, nav item padding, label margins |
| `md` | 8px | Button padding, input padding, sidebar padding |
| `lg` | 12px | Nav section gaps, input container padding |
| `xl` | 16px | Panel header height units, section spacing |
| `2xl` | 20px | Chat content padding, card internal |
| `3xl` | 24px | Card padding |
| `4xl` | 32px | Chat scroll padding, section gaps |
| `5xl` | 40px | Login card padding |

The scale is pragmatic rather than mathematical: 6px and 12px break the 4× pattern because the panel gap and common padding need these intermediate values.

## Elevation & Depth

### Shadow System

Four elevation levels, all using `rgba(var(--foreground-rgb), ...)` for the ring component and `rgba(0,0,0, ...)` for blur layers:

| Level | Class | Treatment | Use |
|---|---|---|---|
| 0 | (none) | Flat | Default inline elements |
| 1 | `shadow-minimal` | 1px ring at 4% + 0.5px blur at 3% | Sidebar, navigator, unfocused input |
| 2 | `shadow-middle` | 1px ring at 6% + 3-layer blur (1/3/6px) | Focused input, cards |
| 3 | `shadow-panel-focused` | Gradient border mask + 5-layer blur (1/3/6/12/24px) | Main content panel |
| T | `shadow-tinted` | `--shadow-color` variable tinted ring + subtle blur | Permission badges, context usage |

### Frosted Glass

The login card uses `backdrop-filter: blur(24px) saturate(140%)` with a semi-transparent background (`oklch(... / 0.86)`). This is the only frosted-glass surface — app panels are opaque.

### Gradient Border

The focused panel (`shadow-panel-focused`) uses a `::before` pseudo-element with a linear-gradient background and a `mask-composite: exclude` trick to create a 1px gradient border (10% foreground at top → 30% at bottom).

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `xs` | 4px | Tags, chips, status badges, inline code |
| `sm` | 6px | Nav items, ghost buttons, toolbar pills |
| `md` | 8px | Inputs, session rows, code blocks, search bar |
| `inner` | 10px | Panel surfaces (`--radius-inner`) |
| `lg` | 12px | Input container (chat textarea wrapper) |
| `edge` | 14px | Outer edge radius (`--radius-edge`) |
| `bubble` | 16px | User message bubbles |
| `card` | 20px | Login card |
| `pill` | 9999px | Avatars, pill-shaped badges |

### Shape Philosophy

The radius scale uses 2px increments from 4–14px, then jumps to 16px and 20px for conversational and card surfaces. The login card at 20px is the most rounded element; the three-panel layout uses the more moderate 10px. The visual effect is **precise and engineered** rather than bubbly.

## Components

### Login Card
A frosted-glass centered card (`max-width: 28rem`) with `backdrop-filter: blur(24px) saturate(140%)` and a 6-layer shadow. Contains the brand logo mark (violet square with "P"), title, username/password fields with show/hide toggle, and a full-width accent-colored submit button with `0 10px 24px accent at 28%` shadow.

### Three-Panel Shell
Sidebar (220px) + Navigator (300px) + Main Content (flex), each in a floating panel with `shadow-minimal` or `shadow-panel-focused`. The panels sit inside a 6px-inset container with 6px gap between them.

### Ghost Button (28×28)
A fixed-size transparent icon button that reveals `fg-5` background on hover. Used pervasively in toolbars, panel headers, and inline actions. Icon color transitions from `fg-50` to `foreground` on hover.

### Permission Mode Badge
Tinted badge with `--shadow-color` variable for a color-coordinated ring shadow. Three modes: Explore (neutral fg), Ask (amber info), Execute (violet accent). Each has a matching tinted background, text color, and SVG icon.

### Model Selector
A compact toolbar button showing the selected model mark (colored square) + name + lock icon + chevron. Opens a dropdown with model list items (mark + name + provider) and an admin-lock footer noting models are admin-configured.

### Chat Input Zone
A `shadow-minimal` → `shadow-middle` input container at max-width 840px. Contains a growable `<textarea>` (min 88px, max 540px) and a bottom toolbar with file/sources/folder badges, model selector, context usage indicator, and send/stop button.

### User Bubble
Right-aligned message bubble with `foreground at 5%` background and 16px border radius. Max-width 80%.

### Turn Card (Assistant Response)
Collapsible activity list (tool calls with status chips) + thinking section (italic, indented with 2px left border) + response card with content blocks (paragraphs, lists, code) + footer toolbar (copy, markdown, expand).

### Session Row
Flexible list item with status icon, processing spinner, title, time/flag indicator, and preview text (2-line clamp). Active state shows left-edge accent bar (2px) and subtle `fg-3` background.

### Quota Widget
Bottom-of-sidebar widget with 3px-high progress bar, percentage text, and conditional warning/exhausted messages in info/destructive colors.

## Do's and Don'ts

### Do
- Use the **fg-N opacity ramp** for text hierarchy instead of introducing new gray values. The ramp auto-adapts to both themes.
- Apply `color-mix(in srgb, var(--accent) N%, transparent)` for accent-tinted backgrounds (focus rings, status chips, permission badges).
- Keep shadows subtle in light mode (border opacity 0.04–0.08, blur opacity 0.03–0.06). The floating-panel aesthetic depends on **barely-there** shadows.
- Use `oklch(from var(--foreground) l c h / N)` for semi-transparent foreground overlays (borders, user bubbles) — this keeps them tonal.
- Maintain the 6px panel gap and 6px inset — these create the distinctive floating-panel feel.
- Use 28×28 ghost buttons for all toolbar/inline icon actions — consistency matters more than optimizing hit targets per context.
- Keep semantic colors in their lanes: amber for warnings, teal for success, red for errors. Don't cross them.

### Don't
- Don't use accent (`#5e17eb`) as a background color for large surfaces — it's reserved for small interactive elements (buttons, badges, indicators).
- Don't add new semantic colors beyond the four (accent, info, success, destructive). The system deliberately limits the palette.
- Don't use hard-coded gray hex values (`#999`, `#ccc`). Use `var(--fg-N)` tokens so dark mode adapts automatically.
- Don't apply `backdrop-filter` to the main panels — only the login card uses frosted glass. Panels are opaque for performance.
- Don't increase shadow opacity to make panels more visible in light mode — the subtlety is intentional.
- Don't use border-radius values outside the documented scale. The 2px-increment progression is deliberate.
- Don't mix oklch and hex in the same declaration — pick oklch for the token definition, hex only in comments for reference.

## Known Gaps

### Not Covered in This Prototype

- **Responsive/Media Queries**: The prototype has no responsive breakpoints. As an Electron desktop app, responsive behavior is managed by the OS window manager rather than CSS media queries. Minimum window size constraints should be defined at the Electron BrowserWindow level.
- **Animation Timing Curves**: The prototype defines keyframe animations (splash, fade, slide, shake, spin, blink) but does not document a systematic easing/duration scale. Most transitions use 0.1s–0.15s for micro-interactions and 0.25s–0.35s for state transitions.
- **Focus Management**: Keyboard focus styles beyond input fields are not documented. The prototype uses `outline: none` on inputs and relies on accent-colored border changes for focus indication.
- **Accessibility Contrast Ratios**: The oklch-based colors have not been audited for WCAG contrast compliance. The fg-N ramp's lower values (fg-20, fg-30) may not meet AA requirements against the background.
- **Error/Empty States**: Beyond the login error, no systematic error-state styling is documented (e.g., inline validation, toast notifications, empty lists).
- **Scrollbar Behavior**: Scrollbars are 6px wide, transparent by default, and only reveal on hover — this may cause usability issues for users who rely on visible scrollbars.
