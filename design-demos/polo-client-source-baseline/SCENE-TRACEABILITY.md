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
| `onboarding` | `src/source/AdminLogin.jsx`, `src/source/LifecycleRegion.jsx`, `src/source/OnboardingSteps.jsx` | `components/onboarding/{OnboardingWizard,AdminLoginStep,WelcomeStep,AdminKickedStep,CompletionStep,GitBashWarning,ProviderSelectStep,LocalModelStep,CredentialsStep}.tsx`, `components/onboarding/primitives.tsx`, `components/apisetup/ApiKeyInput.tsx` | `reference-renderer-login-1440x900.png`; `reference-playground-onboarding-{welcome,wizard}-1440x900.png` | static source-derived; admin-login (invalid-credentials fixture)/Welcome/AdminKicked/Completion plus all wizard steps (git-bash cards, provider-select cards, local-model defaults, credentials api-key/copilot-code/claude-code states); provider card icons are runtime_exact SVG assets |
| `reauth` | `src/source/LifecycleRegion.jsx` | `components/onboarding/ReauthScreen.tsx` | none | static source-derived |
| `workspace-picker` | `src/source/WorkspacePicker.jsx` | `components/workspace/{WorkspacePicker,WorkspaceCreationScreen,AddWorkspaceStep_Choice}.tsx` | none | static source-derived, empty/loading fixture |
| `home` | `src/source/HomeLauncher.jsx`, `src/source/HomeTabFrame.jsx` | `components/tab-browser/{HomePage,TabBar,TabContent,AppIcon,OrganizationAppCard}.tsx` | none | static source-derived; fresh-profile fixture (runtime catalog is data-dependent) |
| `enterprise-home` | `src/source/HomeLauncher.jsx`, `src/source/HomeTabFrame.jsx`, `src/source/HomeApps.jsx` | `components/tab-browser/{HomePage,OrganizationAppCard}.tsx` | none | static source-derived; catalog fixture (runtime organization data is data-dependent); `organization-apps` state renders the OrganizationAppCard grid (installed status, initial-letter artwork gradient) |
| `chat` | `src/source/EmptyChat.jsx`, `src/source/ChatConversation.jsx`, `src/source/PoloShell.jsx` | `pages/ChatPage.tsx`, `components/{chat/ChatDisplay,chat/EmptyStateHint,app-shell/input/ChatInputZone,app-shell/input/InputContainer}.tsx`, `packages/ui/src/components/chat/UserMessageBubble.tsx`, `packages/ui/src/lib/layout.ts` | `reference-playground-chat-{empty-hint,input}-1440x900.png` | static source-derived; key production components independently referenced; `conversation` state renders user/assistant bubbles on the CHAT_LAYOUT column with a named transcript fixture |
| `chat-permission` | `src/source/EmptyChat.jsx`, `src/source/PoloShell.jsx` | `pages/ChatPage.tsx`, `shared/agent/mode-types.ts` | `reference-playground-chat-input-1440x900.png` | static source-derived; permission data is fixture-bound |
| `sources` | `src/source/ResourceEmptyPanels.jsx`, `src/source/PoloShell.jsx` | `components/app-shell/SourcesListPanel.tsx`, `components/app-shell/MainContentPanel.tsx`, `components/ui/{entity-list-empty,empty}.tsx` | `reference-playground-entity-sources-1440x900.png` | static source-derived; empty fixture with Learn-more + add CTA pair and muted unselected detail |
| `skills` | `src/source/ResourceEmptyPanels.jsx`, `src/source/PoloShell.jsx` | `components/app-shell/SkillsListPanel.tsx`, `components/app-shell/MainContentPanel.tsx`, `components/ui/{entity-list-empty,empty}.tsx` | `reference-playground-entity-skills-1440x900.png` | static source-derived; empty fixture with Learn-more + add CTA pair and muted unselected detail |
| `automations` | `src/source/ResourceEmptyPanels.jsx`, `src/source/AutomationsRegion.jsx`, `src/source/PoloShell.jsx` | `components/automations/{AutomationsListPanel,AutomationInfoPage}.tsx`, `components/automations/types.ts`, `components/app-shell/MainContentPanel.tsx`, `components/ui/{entity-row,entity-list-empty,empty}.tsx`, `components/info/{Info_Page,Info_Section,Info_Table}.tsx` | `reference-playground-automations-list-1440x900.png` | static source-derived; empty fixture plus `list`/`detail` states on a named automation dataset (EntityRow + MicroBadge rows, Info_Section hero/当/如果/则/设置 with Info_Table rows); event/permission badge naming follows EVENT_DISPLAY_NAMES and PERMISSION_DISPLAY_NAMES |
| `browser` | `src/source/BrowserEmptyState.jsx`, `src/source/BrowserRegion.jsx` | `browser-empty-state.tsx`, `components/browser/empty-state-prompts.ts`, `packages/ui/src/components/ui/{BrowserEmptyStateCard,BrowserControls}.tsx`, `components/browser/{BrowserTabBadge,BrowserTabStrip}.tsx` | `reference-playground-browser-empty-1440x900.png`; `reference-playground-browser-tab-strip-1440x900.png` | static source-derived; empty card (zh-Hans title/description/safety-hint, English sample prompts as in source) plus `toolbar` state (nav cluster, URL field, loading-idle branch) and tab-strip badges; BrowserView is approximate |
| `app-menu` | `src/source/AppMenu.jsx` | `components/{AppMenu,app-menu/DesktopAppMenu}.tsx`, `packages/ui/src/components/ui/StyledDropdown.tsx`, `shared/menu-schema.ts` | none | static source-derived; StyledDropdown item/shortcut/separator metrics; action handlers are IPC boundaries |
| `settings` | `src/source/SettingsRegion.jsx`, `src/source/PoloShell.jsx` | `pages/settings/{SettingsNavigator,AppSettingsPage,AppearanceSettingsPage,InputSettingsPage,WorkspaceSettingsPage,PermissionsSettingsPage,LabelsSettingsPage,MessagingSettingsPage,ServerSettingsPage,PreferencesPage,ShortcutsPage,AccountSecuritySettingsPage}.tsx`, `components/settings/*`, `components/icons/SettingsIcons.tsx`, `components/app-shell/PanelHeader.tsx`, `shared/settings-registry.ts`, `renderer/actions/{definitions,registry}.tsx` | none | static source-derived; every settings page has its own scene state (fresh-profile navigator keeps account-security/server gated out; both still render behind `account-security`/`server` states), IPC defaults and empty branches; shortcuts page mirrors the action-registry hotkey table |
| `organization` | `src/source/OrganizationOnboarding.jsx`, `src/source/OrganizationManage.jsx` | `components/organization/{OrganizationOnboarding,OrganizationManagementDialog}.tsx` | none | static source-derived; loading/create fixture; join/select render card frames with the IPC-preview slot (spinner body); `members`/`invitations`/`artifacts` states render the management dialog tabs on a named member/invitation/artifact fixture |
| `shortcuts` | `src/source/KeyboardShortcutsDialog.jsx` | `components/KeyboardShortcutsDialog.tsx`, `renderer/actions/definitions.ts` | none | static source-derived; registry + component-specific sections, Mac hotkey display |
| `reset` | `src/source/ResetDialog.jsx` | `components/ResetConfirmationDialog.tsx` | none | static source-derived; source challenge regenerated on open |

## Component gallery

`components/` is the component-level counterpart of `prototype.html`, exported
by `tools/export-component-gallery.mjs`. Each `components/<group>/<component>.html`
is a self-contained static SSR translation of one `src/source/*` component
(inline tokens.css/base.css, assets as data URLs, no scripts, no network),
grouped by the catalog groups in `scene-catalog.json`: lifecycle, workbench,
assistant, resources, apps, settings, organization, system. `components/index.html`
is the classification overview. Gallery pages are review artifacts; the editable
source of truth remains `src/source/`.

## Boundary rule

Only Electron IPC, BrowserView/native browser process, and OS-native UI are
classified as approximate. Runtime screenshots are optional validation evidence
in this mode; their absence does not downgrade a statically derived scene. Data
that the source cannot uniquely determine (account, organization, catalog,
conversation and permission state) is represented only by an explicitly named,
deterministic source-compatible fixture.
