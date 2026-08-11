# Scene traceability audit

This is the per-catalog-scene audit required for the reusable baseline. The
baseline acceptance mode is **static source derivation**: each scene is
translated from the listed Renderer source, its imported visual assets, CSS and
fixed strings. A `partial` reference proves only the named production component,
not an overall application page. No row below treats a prototype screenshot as
Renderer proof.

| Catalog scene | Source-backed implementation | Renderer source path(s) | Real Renderer / Playground reference | Audit status |
| --- | --- | --- | --- | --- |
| `splash` | `src/source/LifecycleRegion.jsx` | `components/SplashScreen.tsx`, `components/icons/PoloAiSymbol.tsx` | none | static source-derived |
| `onboarding` | `src/source/AdminLogin.jsx`, `src/source/LifecycleRegion.jsx` | `components/onboarding/{OnboardingWizard,AdminLoginStep,WelcomeStep,AdminKickedStep,CompletionStep}.tsx` | `reference-renderer-login-1440x900.png`; `reference-playground-onboarding-{welcome,wizard}-1440x900.png` | partial: login/Welcome/Wizard covered; other fixed states need capture |
| `reauth` | `src/source/LifecycleRegion.jsx` | `components/onboarding/ReauthScreen.tsx` | none | static source-derived |
| `workspace-picker` | `src/source/WorkspacePicker.jsx` | `components/workspace/{WorkspacePicker,WorkspaceCreationScreen,AddWorkspaceStep_Choice}.tsx` | none | static source-derived, empty/loading fixture |
| `home` | `src/source/HomeLauncher.jsx`, `src/source/HomeTabFrame.jsx` | `components/tab-browser/{HomePage,TabBar,TabContent,AppIcon,OrganizationAppCard}.tsx` | none | static source-derived; fresh-profile fixture (runtime catalog is data-dependent) |
| `enterprise-home` | `src/source/HomeLauncher.jsx`, `src/source/HomeTabFrame.jsx` | `components/tab-browser/{HomePage,OrganizationAppCard}.tsx` | none | static source-derived; catalog fixture (runtime organization data is data-dependent) |
| `chat` | `src/source/EmptyChat.jsx`, `src/source/PoloShell.jsx` | `pages/ChatPage.tsx`, `components/{chat/ChatDisplay,chat/EmptyStateHint,app-shell/input/ChatInputZone,app-shell/input/InputContainer}.tsx` | `reference-playground-chat-{empty-hint,input}-1440x900.png` | static source-derived; key production components independently referenced |
| `chat-permission` | `src/source/EmptyChat.jsx`, `src/source/PoloShell.jsx` | `pages/ChatPage.tsx`, `shared/agent/mode-types.ts` | `reference-playground-chat-input-1440x900.png` | static source-derived; permission data is fixture-bound |
| `sources` | `src/source/ResourceEmptyPanels.jsx`, `src/source/PoloShell.jsx` | `components/app-shell/SourcesListPanel.tsx`, `components/ui/{entity-list-empty,empty}.tsx` | `reference-playground-entity-sources-1440x900.png` | static source-derived; empty fixture |
| `skills` | `src/source/ResourceEmptyPanels.jsx`, `src/source/PoloShell.jsx` | `components/app-shell/SkillsListPanel.tsx`, `components/ui/{entity-list-empty,empty}.tsx` | `reference-playground-entity-skills-1440x900.png` | static source-derived; empty fixture |
| `automations` | `src/source/ResourceEmptyPanels.jsx`, `src/source/PoloShell.jsx` | `components/automations/AutomationsListPanel.tsx`, `components/ui/{entity-list-empty,empty}.tsx` | `reference-playground-automations-list-1440x900.png` | static source-derived; empty fixture |
| `browser` | `src/source/BrowserEmptyState.jsx` | `browser-empty-state.tsx`, `components/browser/empty-state-prompts.ts`, `packages/ui/src/components/ui/BrowserEmptyStateCard.tsx` | `reference-playground-browser-empty-1440x900.png`; `reference-playground-browser-tab-strip-1440x900.png` | partial: empty card/tab strip covered; BrowserView is approximate |
| `app-menu` | `src/source/AppMenu.jsx` | `components/{AppMenu,app-menu/DesktopAppMenu}.tsx`, `shared/menu-schema.ts` | none | static source-derived; action handlers are IPC boundaries |
| `settings` | `src/source/SettingsRegion.jsx`, `src/source/PoloShell.jsx` | `pages/settings/{SettingsNavigator,AppSettingsPage}.tsx`, `components/settings/*`, `components/app-shell/PanelHeader.tsx` | none | static source-derived; source defaults only |
| `organization` | `src/source/OrganizationOnboarding.jsx` | `components/organization/OrganizationOnboarding.tsx` | none | static source-derived; loading/create fixture |
| `shortcuts` | `src/source/KeyboardShortcutsDialog.jsx` | `components/KeyboardShortcutsDialog.tsx`, `renderer/actions/definitions.ts` | none | static source-derived |
| `reset` | `src/source/ResetDialog.jsx` | `components/ResetConfirmationDialog.tsx` | none | static source-derived; source challenge regenerated on open |

## Boundary rule

Only Electron IPC, BrowserView/native browser process, and OS-native UI are
classified as approximate. Runtime screenshots are optional validation evidence
in this mode; their absence does not downgrade a statically derived scene. Data
that the source cannot uniquely determine (account, organization, catalog,
conversation and permission state) is represented only by an explicitly named,
deterministic source-compatible fixture.
