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
| `onboarding` | `src/source/AdminLogin.jsx`, `src/source/LifecycleRegion.jsx` | `components/onboarding/{OnboardingWizard,AdminLoginStep,WelcomeStep,AdminKickedStep,CompletionStep}.tsx` | `reference-renderer-login-1440x900.png`; `reference-playground-onboarding-{welcome,wizard}-1440x900.png` | partial: admin-login (invalid-credentials fixture)/Welcome/AdminKicked/Completion covered; wizard-only steps (git-bash, provider-select, local-model, credentials) need capture |
| `reauth` | `src/source/LifecycleRegion.jsx` | `components/onboarding/ReauthScreen.tsx` | none | static source-derived |
| `workspace-picker` | `src/source/WorkspacePicker.jsx` | `components/workspace/{WorkspacePicker,WorkspaceCreationScreen,AddWorkspaceStep_Choice}.tsx` | none | static source-derived, empty/loading fixture |
| `home` | `src/source/HomeLauncher.jsx`, `src/source/HomeTabFrame.jsx` | `components/tab-browser/{HomePage,TabBar,TabContent,AppIcon,OrganizationAppCard}.tsx` | none | static source-derived; fresh-profile fixture (runtime catalog is data-dependent) |
| `enterprise-home` | `src/source/HomeLauncher.jsx`, `src/source/HomeTabFrame.jsx` | `components/tab-browser/{HomePage,OrganizationAppCard}.tsx` | none | static source-derived; catalog fixture (runtime organization data is data-dependent) |
| `chat` | `src/source/EmptyChat.jsx`, `src/source/PoloShell.jsx` | `pages/ChatPage.tsx`, `components/{chat/ChatDisplay,chat/EmptyStateHint,app-shell/input/ChatInputZone,app-shell/input/InputContainer}.tsx` | `reference-playground-chat-{empty-hint,input}-1440x900.png` | static source-derived; key production components independently referenced |
| `chat-permission` | `src/source/EmptyChat.jsx`, `src/source/PoloShell.jsx` | `pages/ChatPage.tsx`, `shared/agent/mode-types.ts` | `reference-playground-chat-input-1440x900.png` | static source-derived; permission data is fixture-bound |
| `sources` | `src/source/ResourceEmptyPanels.jsx`, `src/source/PoloShell.jsx` | `components/app-shell/SourcesListPanel.tsx`, `components/app-shell/MainContentPanel.tsx`, `components/ui/{entity-list-empty,empty}.tsx` | `reference-playground-entity-sources-1440x900.png` | static source-derived; empty fixture with Learn-more + add CTA pair and muted unselected detail |
| `skills` | `src/source/ResourceEmptyPanels.jsx`, `src/source/PoloShell.jsx` | `components/app-shell/SkillsListPanel.tsx`, `components/app-shell/MainContentPanel.tsx`, `components/ui/{entity-list-empty,empty}.tsx` | `reference-playground-entity-skills-1440x900.png` | static source-derived; empty fixture with Learn-more + add CTA pair and muted unselected detail |
| `automations` | `src/source/ResourceEmptyPanels.jsx`, `src/source/PoloShell.jsx` | `components/automations/AutomationsListPanel.tsx`, `components/app-shell/MainContentPanel.tsx`, `components/ui/{entity-list-empty,empty}.tsx` | `reference-playground-automations-list-1440x900.png` | static source-derived; empty fixture with Learn-more + add CTA pair and muted unselected detail |
| `browser` | `src/source/BrowserEmptyState.jsx` | `browser-empty-state.tsx`, `components/browser/empty-state-prompts.ts`, `packages/ui/src/components/ui/BrowserEmptyStateCard.tsx` | `reference-playground-browser-empty-1440x900.png`; `reference-playground-browser-tab-strip-1440x900.png` | partial: empty card/tab strip covered (zh-Hans title/description/safety-hint, English sample prompts as in source); BrowserView is approximate |
| `app-menu` | `src/source/AppMenu.jsx` | `components/{AppMenu,app-menu/DesktopAppMenu}.tsx`, `packages/ui/src/components/ui/StyledDropdown.tsx`, `shared/menu-schema.ts` | none | static source-derived; StyledDropdown item/shortcut/separator metrics; action handlers are IPC boundaries |
| `settings` | `src/source/SettingsRegion.jsx`, `src/source/PoloShell.jsx` | `pages/settings/{SettingsNavigator,AppSettingsPage}.tsx`, `components/settings/*`, `components/icons/SettingsIcons.tsx`, `components/app-shell/PanelHeader.tsx`, `shared/settings-registry.ts` | none | static source-derived; fresh-profile item set (account-security/server gated out), App page IPC defaults |
| `organization` | `src/source/OrganizationOnboarding.jsx` | `components/organization/OrganizationOnboarding.tsx` | none | static source-derived; loading/create fixture; join/select render card frames with the IPC-preview slot (spinner body) |
| `shortcuts` | `src/source/KeyboardShortcutsDialog.jsx` | `components/KeyboardShortcutsDialog.tsx`, `renderer/actions/definitions.ts` | none | static source-derived; registry + component-specific sections, Mac hotkey display |
| `reset` | `src/source/ResetDialog.jsx` | `components/ResetConfirmationDialog.tsx` | none | static source-derived; source challenge regenerated on open |

## Boundary rule

Only Electron IPC, BrowserView/native browser process, and OS-native UI are
classified as approximate. Runtime screenshots are optional validation evidence
in this mode; their absence does not downgrade a statically derived scene. Data
that the source cannot uniquely determine (account, organization, catalog,
conversation and permission state) is represented only by an explicitly named,
deterministic source-compatible fixture.
