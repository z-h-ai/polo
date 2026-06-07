---
id: auth.global-401
module: auth
type: domain
priority: 4
status: pending
estimatedMinutes: 30
dependencies: [auth.admin-api-client, llm.credential-store]
---
# Global 401 Interceptor + Force Logout

## Description
Add a global 401 interceptor to AdminApiClient that triggers a force-logout sequence when any authenticated API call returns HTTP 401. The force-logout sequence:
1. Cancel all in-flight LLM API requests
2. Clear all cached auth data (JWT, user info, LLM config, decrypted API keys)
3. Save user's unsent input as draft (if any)
4. Emit a `session-expired` event for the UI to show SessionExpiredDialog
5. Route to LoginPage

This interceptor applies to ALL Admin API calls (quota check, usage report, etc.), not just auth-specific endpoints.

## Environment Context
- Runtime: Node.js + Browser + Electron
- Package manager: Bun
- Test strategy: Mock API responses
- Key concern: Must not trigger during login() call (401 on login is normal "wrong password", not session expiry)

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| 401 from /api/auth/validate | Token revoked | Force logout triggered |
| 401 from /api/llm-connections | Token revoked mid-session | Force logout triggered |
| 401 from quota check API | Token revoked during usage | Force logout triggered |
| 401 from /api/auth/login | Wrong password | NOT intercepted (login handles its own errors) |
| 200 from any endpoint | Normal response | No interception, response passed through |
| 500 from any endpoint | Server error | No interception, error passed through |

## Input/Output Types
```typescript
// Force logout event payload
interface SessionExpiredEvent {
  reason: 'token_revoked';
  requestUrl: string;
}

// Interceptor hook
type OnForceLogout = (event: SessionExpiredEvent) => void;
```

## Acceptance Criteria
1. Any 401 response from authenticated Admin API calls triggers force-logout
2. Login endpoint 401 is NOT intercepted (login has its own error handling)
3. Force logout cancels in-flight LLM requests via AbortController
4. Force logout clears JWT, user info, LLM config cache, CredentialManager entries
5. Force logout emits session-expired event for UI layer
6. Force logout is idempotent (multiple concurrent 401s don't cause multiple logouts)

## Test Cases (Red Phase)

### Interception
- TEST: GET /api/llm-connections returns 401 → force-logout sequence is triggered
- TEST: POST /api/auth/validate returns 401 → force-logout sequence is triggered
- TEST: Quota check API returns 401 → force-logout sequence is triggered
- TEST: POST /api/auth/login returns 401 → force-logout is NOT triggered (login error handled separately)
- TEST: Any API returns 200 → no interception, response returned normally
- TEST: Any API returns 500 → no interception, error propagated normally

### Force Logout Actions
- TEST: On 401, AbortController.abort() is called on in-flight LLM requests
- TEST: On 401, cached JWT is cleared (cache.getToken() returns null after)
- TEST: On 401, cached user info is cleared
- TEST: On 401, cached LLM config is cleared
- TEST: On 401, CredentialManager entries with type `llm_api_key` are deleted (using typed CredentialId, not string prefix)
- TEST: On 401, session-expired event is emitted with `{ reason: "token_revoked", requestUrl }`
- TEST: On 401, if user has unsent input in chat, it is saved as local draft (workspace-level, no sensitive data)

### Idempotency
- TEST: Two concurrent 401 responses → force-logout executes only once (second is no-op)
- TEST: After force-logout completes, subsequent 401 from stale requests do not re-trigger

## Fixtures Required
- Mock AdminApiClient with configurable response status codes
- Mock CredentialManager
- Mock AbortController for LLM requests
- Event listener mock for session-expired event
