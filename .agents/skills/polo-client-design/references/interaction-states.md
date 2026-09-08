# Interaction states

Every interactive control must expose the states its primitive supports. Copying only the resting appearance is incomplete.

## Required states

- Hover: use the established low-opacity foreground surface or text-strength change. Avoid layout shift.
- Keyboard focus: preserve `focus-visible` rings and outlines from the primitive. Do not remove the ring without an equivalent visible focus treatment.
- Pressed/selected/open: use Radix `data-state` or the component's selected contract. Menu triggers should retain their open styling.
- Disabled: prevent pointer action and use the component's 30–50% opacity treatment; form controls may also show a not-allowed cursor.
- Loading: keep the action label understandable, prevent duplicate submission, and use the shared spinner when the existing family does.
- Error/destructive: use semantic destructive color and an accessible message, not color alone.
- Empty/offline/reconnecting: use an existing product state component or explicit recovery action. Do not show fabricated success while data is unavailable.

## Menus, dialogs, and overlays

Use the established Radix wrappers so Escape, outside interaction, focus return, and portalling work consistently. Dropdown/popover transitions use short fade/zoom/slide utilities. Dialog content uses a 200ms fade/zoom transition. Tooltips sit above dropdowns in the semantic z-index registry.

Dialog close controls require an accessible name. Destructive confirmation must distinguish cancel from the irreversible action. Fullscreen preview overlays own their own close and keyboard behavior; do not layer a second page modal on top without checking the dismissal stack.

## Motion

Use motion to explain navigation, panel change, disclosure, or feedback. Existing panel headers use a spring (`stiffness: 300`, `damping: 30`); simple color changes use short CSS transitions. Do not add ambient motion as decoration. Preserve reduced-motion behavior provided by the underlying library or browser.

## Review checklist

For a changed control, verify mouse and keyboard activation, visible focus, open/selected persistence, disabled behavior, error/loading recovery, dark mode, and compact layout. For a renamed or replaced component, verify that the old behavioral contract did not disappear with the old filename.

Sources: renderer `button.tsx`, `input.tsx`, `select.tsx`, `switch.tsx`, `dialog.tsx`, `HeaderIconButton.tsx`; shared `StyledDropdown.tsx`, overlays, and tooltip components at the pinned commit.
