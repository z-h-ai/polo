# Layout

## Desktop shell

The released shell is a floating, resizable panel system:

- Sidebar default width: 220px.
- Navigator/session-list default width: 300px, persisted and constrained by its implementation.
- Content panel minimum width: 440px.
- Adjacent panel gap: 6px.
- Window-edge inset: 6px on non-compact layouts.
- Inner panel radius: 10px.
- Native outer radius: 14px on macOS and 8px elsewhere.
- Resize target: 8px hit width with a 2px visible line.

Keep shell geometry sourced from `panel-constants.ts`; never duplicate these numbers in a new panel. Panel corner ownership stays with shell containers, not the base `Panel`, so nested backgrounds do not create clipping seams.

The top bar is app chrome. Below it, the sidebar, navigator, content panels, and optional peer panels share one stack. Use `Panel`, `PanelSlot`, `PanelStackContainer`, `PanelHeader`, and existing resize mechanics before creating a page-specific shell.

## Compact behavior

At a measured shell width below 768px, the renderer enters auto-compact mode. It hides the desktop sidebar/navigator arrangement, removes outer right/bottom inset, and presents one panel at a time with compact navigation and a contextual new-chat action.

This is behavior evidence, not permission to reinterpret every desktop page as a phone layout. A new settings page should use the existing compact route/shell behavior and verify it at both sides of 768px.

## Content layouts

Shared chat content uses an 840px maximum width, centered with 20px horizontal padding and 32px vertical padding. Message groups use 10px vertical rhythm; user turns receive extra top/bottom separation. Shared overlays are currently forced to fullscreen because the modal breakpoint is intentionally unreachable (`99999`), although modal size constants remain in the package.

Settings should compose the existing settings page, section, card, row, and control components. Preserve label/control alignment and card padding rather than rebuilding a generic form grid.

## Prototype rule

For a prototype, reproduce the product shell and component states with the same semantic tokens. It may use static data, but it must not invent a second navigation model, mobile breakpoint, or component library and then present that as Polo behavior.

Sources: `apps/electron/src/renderer/components/app-shell/panel-constants.ts`, `AppShell.tsx`, `Panel.tsx`, `PanelSlot.tsx`, `PanelStackContainer.tsx`, `packages/ui/src/lib/layout.ts`, and renderer settings components at the pinned commit.
