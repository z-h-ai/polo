# Technical Decisions

## Source
- Carried forward from: MVP-1 session (2026-06-05) — same project, same test infrastructure
- Updated for: User Auth + Admin LLM Config scope
- Timestamp: 2026-06-06

## Architecture
- Admin (Polo Academy) is an independent project/repo
- Polo AI clients call Admin REST APIs per the spec contract
- JWT issued by Admin, no expiration, jti-based revocation
- API Key encryption: AES-256-GCM with HKDF-derived key from JWT

## Testing & CI Decisions (Confirmed in MVP-1 Session)

### Test Strategy
- **Approach**: Mixed — unit tests mock Admin API (fetch); LLM calls always mocked
- **Admin API mocking**: Mock fetch responses for all Admin API calls in tests
- **Crypto tests**: Test AES-256-GCM decryption with known test vectors

### Test DB Isolation
- N/A (Polo AI does not directly connect to PostgreSQL; Admin API is external)

### Visual Testing
- **Tool**: Playwright screenshots for LoginPage, error pages, and session expired dialog

### CI/CD Constraints
- **Environment**: CI can run Docker; no external API calls in tests
- **Admin API**: Always mocked in test environments

## Implementation Order (from spec §12)
- Phase 1: Basic auth (AdminApiClient extensions, LoginPage, startup auth check, 401 global intercept, logout)
- Phase 2: LLM config (pull + decrypt, write to StoredConfig/CredentialManager, model selector read-only)
- Phase 3: Cleanup (remove Onboarding, AI Settings, OAuth, local models, legacy auth, LLM write RPCs)
- Phase 4: Electron (main process auth, safeStorage JWT, IPC, startup flow)

## Previous Session Learnings (Applicable)
- AdminApiClient already exists at packages/shared/src/admin-api/client.ts (extend it)
- PendingUsageStore exists at packages/shared/src/admin-api/pending-usage.ts
- isPlatformMode() in packages/shared/src/auth/platform.ts
- login-logic.ts pattern works well for testable auth logic
- Bun test subprocess isolation needed for CONFIG_DIR-dependent tests
- @types/ws VerifyClientCallbackAsync instead of WebSocketServerOptions
