---
id: auth.startup-flow
module: auth
type: domain
priority: 3
status: completed
estimatedMinutes: 30
dependencies: [auth.admin-api-client]
startedAt: 2026-06-07T08:13:50.287Z
completedAt: 2026-06-07T08:22:31.433Z
---
# App Startup Auth Check Logic

## Description
Implement the startup authentication flow that runs when the app launches (shared between WebUI and Electron). On startup:
1. Check for cached JWT
2. If none → route to LoginPage
3. If present → call `validateToken()` (10s timeout)
4. If valid + same configVersion → use cached config → enter app
5. If valid + different configVersion → re-fetch LLM config → enter app
6. If 401 → clear cache → route to LoginPage
7. If network error/timeout → route to ServerErrorPage

This task implements the orchestration logic and the **atomic transaction** requirement: auth + config fetch + decrypt + local write must succeed as a unit. If any step fails after login, clear all partial data and show error page — do NOT enter the app.

It does NOT implement the LoginPage, ServerErrorPage, or config decryption (those are separate tasks).

## Environment Context
- Runtime: Node.js + Browser + Electron
- Package manager: Bun
- Test strategy: Mock AdminApiClient methods
- Key deps: existing StoredConfig, token cache

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| No cached JWT | First launch or after logout | Route to LoginPage |
| Valid JWT + matching configVersion | Normal restart | Use cached config, enter app |
| Valid JWT + different configVersion | Admin changed config | Re-fetch config, enter app |
| Revoked JWT (401) | Admin revoked session | Clear cache, route to LoginPage |
| Network error | Admin unreachable | Route to ServerErrorPage |
| Timeout (>10s) | Admin slow/down | Route to ServerErrorPage |

## Input/Output Types
```typescript
// Input
interface StartupContext {
  cachedToken: string | null;
  cachedConfigVersion: string | null;
}

// Output
type StartupResult =
  | { action: 'enter-app'; config: LlmConfig }
  | { action: 'login-page' }
  | { action: 'server-error'; error: Error }
  | { action: 'fetch-config'; token: string; user: User }
```

## Acceptance Criteria
1. No cached token → immediately returns `login-page` action
2. Cached token → calls validateToken() with 10s timeout
3. Valid token + same configVersion → returns `enter-app` with cached config
4. Valid token + different configVersion → triggers config re-fetch
5. 401 response → clears all cached auth data (incl. CredentialManager `llm_api_key::*`) → returns `login-page`
6. 5xx response → returns `server-error` with error details
7. Network error or timeout → returns `server-error` with error details
8. Cache clearing removes: JWT, user info, LLM config, configVersion, CredentialManager `llm_api_key::*` entries
9. Atomic transaction: config fetch/decrypt/write failure after validate → clear partial data → return `config-error`

## Test Cases (Red Phase)

### No Token
- TEST: startupAuth({ cachedToken: null }) → returns `{ action: "login-page" }`, does NOT call validateToken()

### Valid Token, Same Config
- TEST: startupAuth({ cachedToken: "jwt", cachedConfigVersion: "cv_001" }) when validateToken returns configVersion="cv_001" → returns `{ action: "enter-app" }` with cached config
- TEST: validateToken() is called exactly once with the cached token

### Valid Token, Different Config
- TEST: startupAuth({ cachedToken: "jwt", cachedConfigVersion: "cv_001" }) when validateToken returns configVersion="cv_002" → returns `{ action: "fetch-config", token: "jwt", user: {...} }`
- TEST: startupAuth({ cachedToken: "jwt", cachedConfigVersion: null }) when validateToken returns configVersion="cv_001" → returns `{ action: "fetch-config" }` (no cached version = always fetch)

### Token Revoked
- TEST: startupAuth({ cachedToken: "jwt" }) when validateToken throws TokenRevokedError → clears cached JWT, user, config → returns `{ action: "login-page" }`
- TEST: After token revocation, cachedToken getter returns null

### Network Error
- TEST: startupAuth({ cachedToken: "jwt" }) when validateToken throws NetworkError → returns `{ action: "server-error", error: NetworkError }`
- TEST: startupAuth({ cachedToken: "jwt" }) when validateToken times out after 10s → returns `{ action: "server-error" }`

### 5xx Error
- TEST: startupAuth({ cachedToken: "jwt" }) when validateToken returns 5xx → returns `{ action: "server-error" }`

### Atomic Transaction (config fetch failure after validate)
- TEST: startupAuth where validate succeeds but config fetch fails → clears JWT, user, config → returns `{ action: "config-error" }`
- TEST: startupAuth where validate + fetch succeed but decrypt fails on ALL connections → clears partial data → returns `{ action: "config-error" }`
- TEST: After atomic rollback, cachedToken returns null, CredentialManager has no `llm_api_key::*` entries

### Credential Cleanup on 401
- TEST: After token revocation cleanup, CredentialManager entries with type `llm_api_key` are deleted

### Edge Cases
- TEST: startupAuth with empty string token ("") → treated as no token → returns `{ action: "login-page" }`

## Fixtures Required
- Mock AdminApiClient.validateToken() with success/failure variants
- Mock token cache (get/set/clear)
- Mock config cache (get configVersion)
