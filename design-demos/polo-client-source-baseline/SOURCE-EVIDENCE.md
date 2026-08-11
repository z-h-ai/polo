# Renderer source evidence

This file is the fidelity contract for the replacement baseline. A static
region may be implemented only after its source and a corresponding renderer
or Playground reference have been recorded here. It deliberately does not
promote the previous generic mock to a source-faithful result.

## Captured renderer state

| State | Renderer evidence | Reference artifact | Status |
| --- | --- | --- | --- |
| `onboarding/admin-login/password/zh-Hans` | `src/renderer/App.tsx` routes `appState === 'onboarding'` to `OnboardingWizard`; `components/onboarding/OnboardingWizard.tsx` centres the step; `components/onboarding/AdminLoginStep.tsx` renders the password form | `screenshots/reference-renderer-login-1440x900.png` | captured from the real Electron Renderer at 1440 x 900 |
| `playground/index/light/1440x900` | `src/renderer/playground.tsx` mounts the production component registry under mocked Electron APIs | `screenshots/reference-playground-index-1440x900.png` | captured from the actual Renderer Playground; it proves its chrome/theme, not whole-AppShell composition |
| `playground/browser-empty-state/light/1440x900` | Renderer Playground registry component `browser-empty-state-playground` renders `BrowserEmptyStateCard` with the production Browser empty-state prompts | `screenshots/reference-playground-browser-empty-1440x900.png` | captured from the actual Renderer Playground; it proves the visible Browser empty-state component, not BrowserView/native process composition |
| `playground/entity-sources/light/1440x900` | Renderer Playground registry `entity-list-sources` renders production entity list primitives | `screenshots/reference-playground-entity-sources-1440x900.png` | captured from the actual Renderer Playground; it proves the source-row/list primitives, not IPC dataset state |
| `playground/entity-skills/light/1440x900` | Renderer Playground registry `entity-list-skills` renders production entity list primitives | `screenshots/reference-playground-entity-skills-1440x900.png` | captured from the actual Renderer Playground; it proves the skill-row/list primitives, not IPC dataset state |
| `playground/automations-list/light/1440x900` | Renderer Playground registry `automations-list-panel` renders production AutomationsListPanel | `screenshots/reference-playground-automations-list-1440x900.png` | captured from the actual Renderer Playground; it proves production automation-list composition, not AppShell or live automation data |
| `playground/chat-empty-hint/light/1440x900` | Renderer Playground registry `empty-state-hint` renders production EmptyStateHint | `screenshots/reference-playground-chat-empty-hint-1440x900.png` | captured from the actual Renderer Playground; it proves the empty-chat suggestion component, not whole ChatDisplay composition |
| `playground/chat-input/light/1440x900` | Renderer Playground registry `input-container` renders production InputContainer | `screenshots/reference-playground-chat-input-1440x900.png` | captured from the actual Renderer Playground; it proves the chat composer component, not session data or AppShell composition |
| `playground/browser-tab-strip/light/1440x900` | Renderer Playground registry `browser-tab-strip-playground` renders production BrowserTabStrip | `screenshots/reference-playground-browser-tab-strip-1440x900.png` | captured from the actual Renderer Playground; it proves the top-bar browser-tab component, not BrowserView/native process composition |
| `playground/onboarding-welcome/light/1440x900` | Renderer Playground registry `welcome-step` renders production WelcomeStep | `screenshots/reference-playground-onboarding-welcome-1440x900.png` | captured from the actual Renderer Playground; it proves the Welcome step, not the full lifecycle state machine |
| `playground/onboarding-wizard/light/1440x900` | Renderer Playground registry `onboarding-wizard` renders production OnboardingWizard | `screenshots/reference-playground-onboarding-wizard-1440x900.png` | captured from the actual Renderer Playground; it proves the wizard composition for its fixed preview fixture |

The capture was made from the real Electron process with its production
preload. The process was stopped afterwards. The available local account state
is unauthenticated, so it cannot presently yield an honest Home, AppShell, or
Chat reference capture.

## Source-locked regions awaiting reference capture

| Region | Exact source composition | Required capture state | Static-export boundary |
| --- | --- | --- | --- |
| Tab shell | `components/tab-browser/TabShell.tsx`, `TabBar.tsx`, `TabContent.tsx` | authenticated Home with one Polo tab | none |
| Home launcher | `components/tab-browser/HomePage.tsx`, `AppIcon.tsx`, `OrganizationAppCard.tsx` | authenticated Home with deterministic installed/catalog apps | catalog is fixture data; its UI is not approximate |
| Persistent top bar | `components/app-shell/TopBar.tsx`, `ui/TopBarButton.tsx`, `AppMenu.tsx` | authenticated desktop shell | none |
| Panel layout / navigation | `components/app-shell/AppShell.tsx`, `PanelStackContainer.tsx`, `LeftSidebar.tsx`, `PanelSlot.tsx`, `panel-constants.ts` | authenticated desktop shell | none |
| Chat | `pages/ChatPage.tsx`, `components/chat/ChatDisplay.tsx`, `components/app-shell/input/ChatInputZone.tsx` | authenticated session with a deterministic message fixture | live agent/network operations only |
| Browser app | `components/browser/*`, `browser-empty-state.tsx` | authenticated browser empty state | BrowserView page surface is approximate; toolbar is not |

## Source-translated fixed fixtures

| Fixture | Static implementation | Source values | Reference status |
| --- | --- | --- | --- |
| Fresh-profile Home launcher | `src/source/HomeLauncher.jsx`, `src/styles/source-home.css` | `HomePage.tsx`, `AppIcon.tsx`, `HomePage.round2.interaction.isolated.ts`, `en.json` | source translation complete; renderer/Playground screenshot still required by the original evidence gate |
| Empty Chat session | `src/source/EmptyChat.jsx` | `ChatPage.tsx`, `PanelHeader.tsx`, `ChatDisplay.tsx`, `EmptyStateHint.tsx`, `ChatInputZone.tsx`, `InputContainer.tsx`, `FreeFormInput.tsx`, `en.json` | source translation is integrated; `reference-playground-chat-empty-hint-1440x900.png` and `reference-playground-chat-input-1440x900.png` verify its key production components, while an overall Chat Renderer capture remains required |
| Desktop Polo shell | `src/source/PoloShell.jsx`, `src/styles/source-shell.css` | `TabBar.tsx`, `TopBar.tsx`, `AppShell.tsx`, `PanelStackContainer.tsx`, `LeftSidebar.tsx`, `panel-constants.ts` | source translation complete for the default empty-session fixture; renderer/Playground screenshot still required by the original evidence gate |
| Admin password login | `src/source/AdminLogin.jsx`, `src/styles/source-admin-login.css` | `OnboardingWizard.tsx`, `AdminLoginStep.tsx`, `PoloAiSymbol.tsx`, `input.tsx`, `button.tsx`, `zh-Hans.json` | source translation complete and compared against `reference-renderer-login-1440x900.png` |
| Settings App default | `src/source/SettingsRegion.jsx` | `pages/settings/SettingsNavigator.tsx`, `pages/settings/AppSettingsPage.tsx`, `components/settings/SettingsCard.tsx`, `SettingsSection.tsx`, `SettingsRow.tsx`, `SettingsToggle.tsx`, `SettingsInput.tsx`, `components/app-shell/PanelHeader.tsx` | direct source translation is integrated for the `settings/app` fixture; standalone runtime smoke passed, but a real Renderer/Playground reference screenshot is still required before it can be classified source-faithful |
| Splash, reauthentication, and available onboarding steps | `src/source/LifecycleRegion.jsx` | `SplashScreen.tsx`, `onboarding/OnboardingWizard.tsx`, `ReauthScreen.tsx`, `WelcomeStep.tsx`, `AdminKickedStep.tsx`, `CompletionStep.tsx`, `primitives.tsx`, `PoloAiSymbol.tsx`, `en.json` | source translation is integrated; Playground Welcome/Wizard references are captured, while Splash, Reauth and Admin-kicked still require individual Renderer/Playground references |
| Reset confirmation dialog | `src/source/ResetDialog.jsx` | `ResetConfirmationDialog.tsx`, `dialog.tsx`, `button.tsx`, `input.tsx`, `en.json` | direct source translation is integrated; the source's per-open random arithmetic challenge is retained, and a real Renderer screenshot is still required before it can be classified source-faithful |
| Browser first-load empty state | `src/source/BrowserEmptyState.jsx` | `browser-empty-state.tsx`, `components/browser/empty-state-prompts.ts`, `packages/ui/src/components/ui/BrowserEmptyStateCard.tsx`, `en.json` | source translation is integrated and compared against `reference-playground-browser-empty-1440x900.png`; the BrowserView/native browser process remains explicitly approximate |
| Keyboard shortcuts dialog | `src/source/KeyboardShortcutsDialog.jsx` | `KeyboardShortcutsDialog.tsx`, `renderer/actions/definitions.ts`, `dialog.tsx`, `en.json` | direct source translation is integrated for the macOS fixture; a real Renderer screenshot is still required before it can be classified source-faithful |
| Thin-client workspace picker and creation choice | `src/source/WorkspacePicker.jsx` | `workspace/WorkspacePicker.tsx`, `WorkspaceCreationScreen.tsx`, `AddWorkspaceStep_Choice.tsx`, `workspace/primitives.tsx`, `en.json` | direct source translation is integrated for loading, empty-list, and choice fixtures; remote workspace rows and create/open/remote IPC results are intentionally not invented and require a real runtime reference |
| Organization onboarding | `src/source/OrganizationOnboarding.jsx` | `organization/OrganizationOnboarding.tsx`, `button.tsx`, `input.tsx`, `label.tsx`, `en.json` | direct source translation is integrated for loading and create fixtures; organization summaries, invitations, and join previews are IPC-only runtime data and are not invented |
| Empty Sources, Skills, and Automations navigators | `src/source/ResourceEmptyPanels.jsx` | `app-shell/SourcesListPanel.tsx`, `SkillsListPanel.tsx`, `automations/AutomationsListPanel.tsx`, `ui/entity-list-empty.tsx`, `ui/empty.tsx`, `en.json` | direct source translation is integrated for the actual empty-dataset fixture; resource rows and their details are data-dependent and are not invented |
| Desktop Polo AI menu | `src/source/AppMenu.jsx` | `AppMenu.tsx`, `app-menu/DesktopAppMenu.tsx`, `shared/menu-schema.ts`, `icons/SquarePenRounded.tsx`, `en.json` | direct source translation is integrated for the root menu with all submenus closed; Electron role/action handlers are IPC boundaries and are not simulated |

## Icon and asset rules

- The launcher and Polo tab use `apps/electron/resources/icon.png`, as imported
  by `AppIcon.tsx` and `TabBar.tsx`.
- The login mark is `components/icons/PoloAiSymbol.tsx`; its SVG must be copied
  from the rendered source output, never redrawn.
- Lucide icons must be emitted from the installed `lucide-react` source used by
  the matching renderer component, with its source `strokeWidth`; hand-written
  SVG path substitutions are prohibited.
- Global token and layout rules come from `src/renderer/index.css` plus the
  exact utility classes in the owning component.

## Prohibited evidence substitutions

- A Playground component preview cannot prove the overall AppShell or Home
  composition because the Playground has no whole-AppShell/Home entry.
- A generic dashboard, invented application name, hand-drawn icon, or fixture
  sentence is not valid evidence for a Renderer region.
- A browser screenshot of `http://localhost:5173/` is not valid for the full
  application: the real shell requires Electron preload (`window.electronAPI`).
