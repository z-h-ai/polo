# UI Design

## Source
- Extracted from: spec §5 (UI 变更清单)
- Timestamp: 2026-06-06

## New Components

| Component | Location | Purpose |
|-----------|----------|---------|
| LoginPage | renderer/pages/ | Username + password form, replaces existing password page |
| ServerErrorPage | renderer/pages/ | "Cannot connect to server" with retry button + server address hint |
| ConfigErrorPage | renderer/pages/ | "Config load failed" with retry button |
| NoLlmConfigBanner | renderer/components/ | "No LLM config available, contact admin" banner |
| SessionExpiredDialog | renderer/components/ | "Session expired, please re-login" modal dialog |
| Logout button | Settings menu | User-initiated logout |
| User info display | Sidebar/titlebar | Current username and role |
| Connection status indicator | Status bar | Grey icon when Admin API unreachable |

## Components to Remove

| Component | Current Location | Reason |
|-----------|-----------------|--------|
| OnboardingWizard | renderer/components/onboarding/ | LLM config managed by Admin |
| ProviderSelectStep | renderer/components/onboarding/ | Same |
| CredentialsStep | renderer/components/onboarding/ | Same |
| AiSettingsPage | renderer/pages/ | Same |
| ApiKeyInput | renderer/components/apisetup/ | Same |
| OAuthConnect | renderer/components/apisetup/ | Same |
| SetupAuthBanner | renderer/components/app-shell/ | No longer needed |
| All OAuth flow code | packages/shared/src/auth/ | claude-oauth.ts, chatgpt-oauth.ts, google-oauth.ts, microsoft-oauth.ts, oauth.ts, oauth-flow-store.ts etc. |
| Local model support | Multiple locations | Ollama etc. removed |
| CRAFT_WEBUI_PASSWORD auth | packages/server-core/src/webui/auth.ts | Replaced by Admin JWT |
| CRAFT_SERVER_TOKEN auth | packages/server/src/index.ts | Replaced by Admin JWT |
| LLM connection write RPC handlers | packages/server-core/src/handlers/rpc/llm-connections.ts | SAVE, DELETE, SET_DEFAULT removed; LIST/GET read-only kept |

## Components to Modify

| Component | Change |
|-----------|--------|
| Model selector | Data source → Admin config (read-only, no add/delete) |
| AdminApiClient | Add login(), logout(), validateToken(), getLlmConnections(); global 401 interceptor |
| WebSocket auth | Admin JWT replaces CRAFT_SERVER_TOKEN |
| Electron main process startup | Add Admin auth check step |
| App routing | Auth guard for unauthenticated → login page redirect |
