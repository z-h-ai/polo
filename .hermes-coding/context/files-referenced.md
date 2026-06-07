# Referenced Files Index

## Source
- Extracted from: spec §5 + codebase exploration
- Timestamp: 2026-06-06

## Spec Files
- `docs/prd-and-spec/docs/spec-user-auth-and-admin-llm-config.md` — Full technical spec

## Files to Modify (from spec + codebase)

### Authentication Layer
- `packages/server-core/src/webui/auth.ts` — Replace CRAFT_WEBUI_PASSWORD with Admin JWT validation
- `packages/server-core/src/webui/http-server.ts` — Login/logout/validate routes
- `packages/server/src/index.ts` — Replace CRAFT_SERVER_TOKEN with Admin JWT
- `packages/server-core/src/transport/server.ts` — WebSocket upgrade auth using JWT

### Admin API Client (extend existing or create)
- `packages/shared/src/admin-api/client.ts` — (created in MVP-1 session) Extend with login(), logout(), validateToken(), getLlmConnections()

### LLM Configuration
- `packages/shared/src/config/llm-connections.ts` — Config mapping from Admin API format
- `packages/shared/src/config/storage.ts` — StoredConfig updates for Admin-sourced LLM config

### Credential Management
- `packages/shared/src/config/llm-connections.ts` — resolveAuthEnvVars for Admin-managed credentials
- Uses CredentialManager (referenced in multiple packages) — AES-256-GCM local encrypted storage

### Electron
- `apps/electron/src/main/index.ts` — Main process auth check + IPC
- `apps/electron/src/main/platform.ts` — Platform mode / auth state
- `apps/electron/src/renderer/App.tsx` — Auth guard routing
- `apps/electron/src/renderer/pages/` — Add LoginPage
- `apps/electron/src/renderer/atoms/` — Auth state atoms
- `apps/electron/src/preload/` — IPC bridge for auth

### Web UI
- `apps/webui/src/login.html` — Replace with username+password form
- `apps/webui/src/App.tsx` — Auth routing
- `apps/webui/src/main.tsx` — Entry point

## Files to Remove
- `packages/shared/src/auth/claude-oauth.ts`
- `packages/shared/src/auth/chatgpt-oauth.ts`
- `packages/shared/src/auth/google-oauth.ts`
- `packages/shared/src/auth/microsoft-oauth.ts`
- `packages/shared/src/auth/oauth.ts`
- `packages/shared/src/auth/oauth-flow-store.ts`
- `packages/shared/src/auth/oauth-flow-types.ts`
- `packages/shared/src/auth/oauth-relay.ts`
- `packages/shared/src/auth/generic-oauth.ts`
- `packages/shared/src/auth/pkce.ts`
- `packages/shared/src/auth/slack-oauth.ts`
- `packages/shared/src/auth/callback-page.ts`
- `packages/shared/src/auth/callback-server.ts`
- `apps/electron/src/renderer/components/onboarding/OnboardingWizard.tsx`
- `apps/electron/src/renderer/components/onboarding/ProviderSelectStep.tsx`
- `apps/electron/src/renderer/components/onboarding/CredentialsStep.tsx`
- `apps/electron/src/renderer/components/onboarding/APISetupStep.tsx`
- `apps/electron/src/renderer/components/onboarding/LocalModelStep.tsx`
- `apps/electron/src/renderer/components/onboarding/CompletionStep.tsx`
- `apps/electron/src/renderer/components/onboarding/WelcomeStep.tsx`
- `apps/electron/src/renderer/components/onboarding/ReauthScreen.tsx`
- `apps/electron/src/renderer/components/apisetup/ApiKeyInput.tsx`
- `apps/electron/src/renderer/components/apisetup/OAuthConnect.tsx`
- `apps/electron/src/renderer/components/app-shell/SetupAuthBanner.tsx`
- `packages/server-core/src/handlers/rpc/llm-connections.ts` — Remove SAVE/DELETE/SET_DEFAULT handlers (keep LIST/GET)
- `packages/server-core/src/handlers/rpc/oauth.ts` — Remove OAuth RPC handlers

## Environment Variables
- **New**: `POLO_ADMIN_API_URL` — Admin API base URL
- **Remove**: `CRAFT_WEBUI_PASSWORD`, `CRAFT_SERVER_TOKEN`, `CRAFT_WEBUI_SECURE_COOKIE`
