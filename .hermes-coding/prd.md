# PRD: 用户账号登录 + Admin 下发 LLM 配置

> **Version**: 2.0 | **Date**: 2026-06-06
> **Spec**: `docs/prd-and-spec/docs/spec-user-auth-and-admin-llm-config.md`
> **Scope**: Polo AI 客户端改造（Electron + Web UI），Admin 是独立项目

---

## Context Index (CRITICAL - Read These First After Compression)

> **Recovery Instructions**: If context was compressed, read these files in order:

| Priority | File | Contains |
|----------|------|----------|
| 1 | `docs/prd-and-spec/docs/spec-user-auth-and-admin-llm-config.md` | Complete technical spec (source of truth) |
| 2 | `.hermes-coding/context/user-intent.md` | User's requirements and scope |
| 3 | `.hermes-coding/context/api-spec.md` | Admin API contract (endpoints, JWT, encryption) |
| 4 | `.hermes-coding/context/data-model.md` | User, UserGroup, LLM config models |
| 5 | `.hermes-coding/context/ui-design.md` | UI additions, removals, modifications |
| 6 | `.hermes-coding/context/files-referenced.md` | All file paths to modify/create/remove |
| 7 | `.hermes-coding/context/decisions.md` | Testing, CI, architecture decisions |

---

## 1. Project Overview

### Problem
Polo AI currently operates in two problematic modes:
- **Web UI**: All users share a single password (`CRAFT_WEBUI_PASSWORD`), no individual accounts
- **Electron**: No login required, uses local embedded server
- **LLM Config**: Users manually configure providers, API keys, and OAuth on each device

### Goals
1. **User account system**: Both Web UI and Electron use username+password login; accounts managed by Polo Admin (Academy)
2. **Admin-managed LLM config**: Admins configure LLM providers, API keys, and model lists per user/group; users cannot self-configure
3. **Remove self-service config**: Remove Onboarding wizard, AI Settings page, OAuth flows, local model support

### Scope
- **In scope**: Client-side auth implementation, LLM config consumption, encrypted credential handling, Electron IPC auth, legacy code removal
- **Out of scope**: Admin backend implementation (separate project), CLI login, user self-password-change, offline mode, SSO/LDAP, admin UI

### Constraints
- Must be online at startup (no offline-first)
- JWT has no expiration (product decision); compensated by jti revocation + mandatory startup validation
- Admin API URL via env var (`POLO_ADMIN_API_URL`), not user-configurable

---

## 2. Technical Stack

- **Runtime**: Bun (server), Electron (desktop), browser (Web UI)
- **Language**: TypeScript
- **UI Framework**: React (Jotai atoms for state)
- **Build**: Bun workspace monorepo
- **Test**: Bun test (unit), Playwright (visual/E2E)
- **Crypto**: Node/Web Crypto API (AES-256-GCM, HKDF-SHA256)

---

## 3. Architecture

```
Polo Admin (Academy) ←─ HTTPS + Bearer JWT ─→ Polo AI Client (Electron / Web UI)
```

- Admin signs JWT on login (no exp, jti for revocation)
- Client stores JWT securely (safeStorage / HttpOnly Cookie)
- Client calls Admin API for: login, logout, validate, LLM config
- LLM API calls go directly to providers (not through Admin)
- Quota checks and usage reports use the same JWT

---

## 4. User Flows

### 4.1 App Startup
```
Start → Check cached JWT
  ├─ No JWT → Login page
  └─ Has JWT → POST /api/auth/validate (10s timeout)
        ├─ 200 + configVersion match → Use cached LLM config → Enter app
        ├─ 200 + configVersion mismatch → Fetch LLM config → Enter app
        ├─ 401 → Clear cache → Login page
        └─ Network error → Server error page (retry button)
```

### 4.2 Login
1. User enters username + password
2. POST /api/auth/login
3. Success → Store JWT → Fetch LLM config → Decrypt credentials → Write to local storage → Enter app
4. Failure → Show error (invalid_credentials / account_disabled / rate_limited / network)
5. Partial failure (login OK, config fetch fails) → Config error page (retry button)

### 4.3 Logout
1. POST /api/auth/logout
2. Clear JWT, user info, LLM config, decrypted API keys
3. Redirect to login page

### 4.4 Token Revocation (forced)
1. Any Admin API call returns 401
2. Cancel in-progress LLM requests
3. Clear all cached data + credentials (CredentialManager llm:: prefix)
4. Save unsent user input as local draft
5. Show "Session expired" dialog → Login page

### 4.5 Admin Unreachable During Runtime
- LLM calls: Continue (direct to provider)
- Quota checks: PendingUsageStore fallback (local record, retry later)
- Token validation: Skip (don't kick user out)
- UI: Show subtle connection status indicator (grey icon)

### 4.6 LLM Config Lifecycle
- Fetch on login + startup (if configVersion changed)
- No runtime polling
- Admin changes picked up on next app restart or re-login
- Partial decrypt failure: skip broken connection, others work normally

---

## 5. Data Model
> Reference: `.hermes-coding/context/data-model.md`

Key types: User, UserGroup, AdminLlmConnectionConfig, EncryptedCredential
Config resolution: User override > Single group > Multi-group union > Empty (show banner)

---

## 6. API Contracts
> Reference: `.hermes-coding/context/api-spec.md`

Client consumes: login, logout, validate, llm-connections
Admin consumes: user CRUD, group CRUD, session management, LLM config assignment
Encryption: AES-256-GCM, HKDF from JWT, per-request random IV

---

## 7. UI/UX Design
> Reference: `.hermes-coding/context/ui-design.md`

- **Add**: LoginPage, ServerErrorPage, ConfigErrorPage, NoLlmConfigBanner, SessionExpiredDialog, logout button, user info, connection indicator
- **Remove**: OnboardingWizard (all steps), AiSettingsPage, ApiKeyInput, OAuthConnect, SetupAuthBanner, OAuth flow code, local model support, legacy password/token auth
- **Modify**: Model selector (read-only from Admin config), AdminApiClient (new methods + 401 interceptor), WebSocket auth, Electron startup, app routing (auth guard)

---

## 8. Security Requirements

| Area | Requirement |
|------|-------------|
| JWT Storage (Electron) | safeStorage API, never localStorage |
| JWT Storage (Web) | HttpOnly + Secure + SameSite=Strict Cookie |
| WebSocket auth | JWT via Cookie, never URL query param |
| CSRF | Token on login form (Web UI) |
| API Key encryption | AES-256-GCM, HKDF-SHA256 from JWT |
| Local credential storage | CredentialManager AES-256-GCM |
| Logout cleanup | JWT + user info + LLM config + decrypted keys + configVersion |
| HTTPS | Required for all Admin API calls |

---

## 9. Implementation Phases (from spec §12)

### Phase 1: Basic Authentication
1. Extend AdminApiClient: login(), logout(), validateToken(), getLlmConnections()
2. New LoginPage component
3. App startup auth check logic
4. Global 401 intercept → redirect to login
5. Logout functionality

### Phase 2: LLM Config Integration
6. LLM config fetch + AES-256-GCM decryption logic
7. Write decrypted config to StoredConfig + CredentialManager
8. Model selector data source → Admin config (read-only)

### Phase 3: Cleanup
9. Remove Onboarding wizard
10. Remove AI Settings page
11. Remove client OAuth flow code
12. Remove local model support
13. Remove CRAFT_WEBUI_PASSWORD / CRAFT_SERVER_TOKEN auth
14. Remove LLM connection write RPC handlers

### Phase 4: Electron Adaptation
15. Electron main process Admin auth check
16. JWT storage + IPC passing
17. Startup flow: auth → fetch config → start local server

---

## 10. Non-Functional Requirements

### 10.1 Performance
- Login validate timeout: 10s (5s connect + 5s read)
- LLM config fetch: cached by configVersion, only re-fetched when version changes
- No runtime polling for config changes

### 10.2 Testing

| Aspect | Approach |
|--------|----------|
| Admin API calls | Mock fetch in unit tests |
| AES-256-GCM crypto | Test with known vectors |
| LLM calls | Always mocked |
| UI components | Playwright screenshots (LoginPage, error pages, SessionExpiredDialog) |
| CI environment | Docker OK, no external API calls |
| DB isolation | N/A (no direct DB access) |

### 10.3 Validation Scenarios (from spec §13)
21 test cases covering:
- Auth flow (login success/failure variants, logout)
- Token lifecycle (revocation, password reset)
- LLM config (display, update, partial decrypt failure, no config)
- Multi-device & cross-platform (Electron + Web concurrent, cold/hot start)
- Exception handling (Admin unreachable at startup/runtime, mid-session revocation)

---

## Appendix A: Referenced Files
> **Source**: `.hermes-coding/context/files-referenced.md`

Key modification targets:
- `packages/server-core/src/webui/auth.ts` — JWT validation
- `packages/server-core/src/webui/http-server.ts` — Auth routes
- `packages/server/src/index.ts` — Replace CRAFT_SERVER_TOKEN
- `packages/server-core/src/transport/server.ts` — WebSocket auth
- `packages/shared/src/admin-api/client.ts` — Extend AdminApiClient
- `packages/shared/src/config/llm-connections.ts` — Config mapping
- `packages/shared/src/config/storage.ts` — StoredConfig
- `apps/electron/src/main/index.ts` — Main process auth
- `apps/electron/src/renderer/pages/` — LoginPage
- `apps/webui/src/` — Login page, auth routing

Key removals: ~20+ OAuth/onboarding/local-model files (see files-referenced.md)

## Appendix B: Environment Variables

| Variable | Action | Purpose |
|----------|--------|---------|
| `POLO_ADMIN_API_URL` | **New** | Admin API base URL |
| `CRAFT_WEBUI_PASSWORD` | **Remove** | Replaced by Admin user accounts |
| `CRAFT_SERVER_TOKEN` | **Remove** | Replaced by Admin JWT |
| `CRAFT_WEBUI_SECURE_COOKIE` | **Remove** | Auto-detected from Admin API URL protocol |

## Appendix C: Previous Session Learnings
> Applicable patterns from MVP-1 session (2026-06-05):

- AdminApiClient uses FetchFn type alias to avoid Bun overload issues
- ConfigurationError thrown before fetch try/catch block
- login-logic.ts pattern: pure TS functions for testable auth logic
- platformModeAtom defaults to false (safe non-breaking default)
- Subprocess isolation needed for CONFIG_DIR-dependent tests
- CredentialManager stores credentials with key prefixes (e.g. `llm::`)
- 13 pre-existing test failures in server-core are unrelated — do not attempt to fix
