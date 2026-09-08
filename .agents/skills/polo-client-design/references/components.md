# Components and reuse

## Reuse order

1. Use an exported shared component from `@polo-ai/ui` when the behavior is platform-neutral.
2. Use renderer primitives in `apps/electron/src/renderer/components/ui` for Electron-specific controls.
3. Use an established feature family such as `components/settings` or `components/app-shell` when building within that surface.
4. Create a new component only when the required semantics are absent; build it from existing tokens and primitives and keep its scope explicit.

Search `packages/ui/src/index.ts` and nearby feature indexes before copying markup. Reuse behavior as well as appearance: Radix state attributes, keyboard handling, focus management, portalling, and disabled semantics are part of the component contract.

## Standard controls

### Buttons

Use renderer `Button` variants:

- `default`: foreground fill with background text for the primary committed action.
- `destructive`: destructive fill for irreversible actions.
- `outline`: bordered background control.
- `secondary`: low-emphasis foreground tint.
- `ghost`: toolbar, navigation, or low-emphasis action.
- `link`: inline navigation/action text.

Default height is 36px; small is 32px; large is 40px; icon is 36px square. Header actions should use `HeaderIconButton` (28px square, 4px radius) so tooltip, focus, open, hover, and disabled states remain consistent.

### Inputs and settings

Use `Input`, `Textarea`, `Select`, `Switch`, and the settings wrappers rather than styling raw fields. Standard inputs are 36px high, 8px radius, 15% foreground border, 12px horizontal padding, and a one-pixel focus ring. `SettingsInput`, `SettingsToggle`, `SettingsSelect`, `SettingsSegmentedControl`, `SettingsRow`, `SettingsCard`, and `SettingsSection` preserve the label/description/control relationship.

Example: a new API endpoint setting should be a `SettingsInput` inside the established settings section/card structure. Do not combine a raw `<input>`, a bespoke 40px height, and a custom purple focus border.

### Menus and popovers

Use `StyledDropdownMenuContent` and `StyledDropdownMenuItem` for application menus. Content uses `popover-styled`, one-unit padding, compact type, and semantic dropdown stacking. Items use 4px radius, 8px horizontal/6px vertical padding, 14px icons, and a subtle foreground hover/focus surface. Trigger hover styling is mirrored into the open state so the anchor does not visually reset while its menu is open.

Use `Popover`, `Tooltip`, or the corresponding established wrappers for anchored information. Do not hand-position a floating `<div>` where dismissal, collision, portal, or keyboard behavior matters.

### Dialogs and overlays

Renderer dialogs use the Radix wrapper, a 50% black backdrop, `popover-styled` content, 24px padding, 16px content gap, and a 512px (`sm:max-w-lg`) desktop maximum. Use shared preview/fullscreen overlays for files, code, documents, images, PDFs, activity, and diffs. Their close, navigation, copy, error, and theme behavior is already centralized.

### Shell and chat

Use the app-shell panel family for sidebar/navigator/chat/detail composition. Use shared `SessionViewer`, turn/message components, Markdown, code viewers, and overlays for transcript content. Do not reimplement Markdown rendering, code highlighting, file classification, or overlay selection in a feature page.

## Exceptions

Released source contains feature-local colors and literal sizes for domain-specific badges and dense layouts. These are observed exceptions, not tokens. Reuse them only within that feature family or after a product decision makes them general.

Sources: `packages/ui/src/index.ts`, `packages/ui/src/components/ui/StyledDropdown.tsx`, renderer UI primitives, settings components, and app-shell components at the pinned commit.
