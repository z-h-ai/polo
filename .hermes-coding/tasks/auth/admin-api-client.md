---
id: auth.admin-api-client
module: auth
type: api
priority: 1
status: completed
estimatedMinutes: 30
dependencies: []
startedAt: 2026-06-07T07:15:31.091Z
completedAt: 2026-06-07T07:29:51.824Z
---
# AdminApiClient: login, logout, validate, getLlmConnections

## Description
Extend the existing `AdminApiClient` class in `packages/shared/` with four new methods: `login(username, password)`, `logout()`, `validateToken()`, and `getLlmConnections()`. Each method calls the corresponding Polo Admin API endpoint and handles errors according to the spec error envelope. A global 401 interceptor is added separately in task `auth.global-401`.

This task focuses on the HTTP client layer only — no UI, no token storage, no decryption.

## Environment Context
- Runtime: Node.js + Electron + Browser
- Package manager: Bun
- Test strategy: Mock Admin API (MSW or similar)
- Key deps: craft-agent monorepo (TypeScript)
- Admin API URL: from env var `POLO_ADMIN_API_URL`

## Files to Create/Modify
- `packages/shared/src/auth/admin-auth.ts` — new AdminApiClient class (no existing class found in codebase)
- `packages/shared/src/auth/admin-auth.test.ts` — unit tests

## API Contract

### POST /api/auth/login
```
Headers: { Content-Type: application/json }
Request: { username: string, password: string }
Response 200: { token: string, user: { id, username, displayName, role, groupIds } }
Response 401: { error: "invalid_credentials", message: string }
Response 403: { error: "account_disabled", message: string }
Response 429: { error: "rate_limited", message: string } + Retry-After header
```

### POST /api/auth/logout
```
Headers: { Authorization: Bearer <jwt> }
Response 200: { success: true }
```

### POST /api/auth/validate
```
Headers: { Authorization: Bearer <jwt> }
Response 200: { valid: true, user: {...}, configVersion: string }
Response 401: { error: "token_revoked", message: string }
```

### GET /api/llm-connections
```
Headers: { Authorization: Bearer <jwt> }
Response 200: { configVersion: string, connections: [...], defaultConnection: string }
```

## Error Codes
| Code | HTTP Status | Condition | Response Body |
|------|-------------|-----------|---------------|
| invalid_credentials | 401 | Wrong username/password | `{ error: "invalid_credentials" }` |
| account_disabled | 403 | Account disabled by admin | `{ error: "account_disabled" }` |
| rate_limited | 429 | Too many login attempts | `{ error: "rate_limited" }` + Retry-After |
| token_revoked | 401 | Token invalidated | `{ error: "token_revoked" }` |
| network_error | N/A | Cannot reach Admin API | Thrown as NetworkError |

## Acceptance Criteria
1. `login(username, password)` returns `{ token, user }` on success and throws typed errors on failure
2. `logout()` sends POST with Bearer token and returns void
3. `validateToken()` returns `{ valid, user, configVersion }` or throws on 401
4. `getLlmConnections()` returns `{ configVersion, connections, defaultConnection }`
5. All methods use the `POLO_ADMIN_API_URL` base URL
6. Network errors (timeout, DNS failure) throw a distinct `NetworkError` type
7. Validate timeout is 10s (5s connect + 5s read)
8. All methods enforce HTTPS for Admin API URL (reject http:// in production)
9. Error responses preserve full envelope (error, message, details, requestId)
10. 429 responses on validateToken/getLlmConnections throw RateLimitedError with Retry-After

## Test Cases (Red Phase)

### login()
- TEST: login("zhangsan", "correct_password") → returns `{ token: "eyJ...", user: { id: "usr_abc123", username: "zhangsan", displayName: "张三", role: "user", groupIds: ["grp_dev"] } }`
- TEST: login("zhangsan", "wrong_password") → throws `InvalidCredentialsError` with message "用户名或密码错误"
- TEST: login("disabled_user", "any") → throws `AccountDisabledError` with message containing "禁用"
- TEST: login("any", "any") when rate limited → throws `RateLimitedError` with `retryAfterSeconds` parsed from Retry-After header
- TEST: login("any", "any") when Admin unreachable → throws `NetworkError`
- TEST: login("", "password") → request still sent (server-side validation), client does not pre-validate
- TEST: login("user", "") → request still sent (server-side validation)

### logout()
- TEST: logout() with valid token → sends POST /api/auth/logout with Authorization header, returns void
- TEST: logout() when network fails → throws `NetworkError` (best-effort, caller handles)

### validateToken()
- TEST: validateToken() with valid token → returns `{ valid: true, user: {...}, configVersion: "cv_xxx" }`
- TEST: validateToken() with revoked token → throws `TokenRevokedError`
- TEST: validateToken() when Admin unreachable → throws `NetworkError`
- TEST: validateToken() respects 10s timeout → throws `NetworkError` after 10s

### getLlmConnections()
- TEST: getLlmConnections() with valid token → returns `{ configVersion, connections: [...], defaultConnection }`
- TEST: getLlmConnections() with revoked token → throws `TokenRevokedError` (401)
- TEST: getLlmConnections() returns empty connections array → returns `{ connections: [], defaultConnection: null }`
- TEST: getLlmConnections() when Admin unreachable → throws `NetworkError`
- TEST: getLlmConnections() when rate limited (429) → throws `RateLimitedError` with retryAfterSeconds

### Rate Limiting (validate + config)
- TEST: validateToken() when rate limited (429) → throws `RateLimitedError` with retryAfterSeconds

### Error Envelope Preservation
- TEST: Error response with `{ error, message, details, requestId }` → typed error preserves all fields
- TEST: Error response without optional `details`/`requestId` → no crash, fields default to undefined

### HTTPS Enforcement
- TEST: AdminApiClient constructed with `http://` URL in production → throws ConfigError
- TEST: AdminApiClient constructed with `https://` URL → works normally

## Fixtures Required
- MSW handlers mocking all four Admin API endpoints
- Sample JWT string for Bearer token
- Sample user object matching the User interface
- Sample LLM connections response with encrypted credentials
