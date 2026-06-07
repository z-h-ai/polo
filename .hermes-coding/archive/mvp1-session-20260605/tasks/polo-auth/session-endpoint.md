---
id: polo-auth.session-endpoint
title: "Implement POST /auth/session endpoint (JWT → cookie)"
module: polo-auth
priority: 2
estimatedMinutes: 25
depends: []
status: completed
spec_ref: "spec-polo-ai.md §3.1 (POST /auth/session)"
startedAt: 2026-06-05T15:45:40.964Z
completedAt: 2026-06-05T15:59:56.259Z
---
# Implement POST /auth/session endpoint (JWT → cookie)


## Objective

Add an HTTP endpoint that receives an Admin-signed JWT, verifies it locally using the shared `JWT_SECRET`, and sets an HttpOnly session cookie (`polo_ai_session`). Also stores the JWT in memory for later Admin API calls.

## Acceptance Criteria

### AC1: Happy path — valid JWT
- TEST: POST /auth/session `{ token: validJwt }` → 200 with `{ user: { id, username, role } }`
- TEST: Response sets `Set-Cookie: polo_ai_session=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`
- TEST: In dev mode (localhost or `POLO_AI_WEBUI_SECURE_COOKIE=false`), `Secure` flag is omitted
- TEST: user.id matches JWT `sub` claim, user.username matches `username`, user.role matches `role`
- TEST: JWT is stored in an in-memory map keyed by userId for later Admin API calls

### AC2: Missing / malformed token
- TEST: POST with empty body → 400 `{ error: "validation_error", message: "token field required" }`
- TEST: POST with `{ token: "" }` → 400
- TEST: POST with `{ token: "not.a.jwt" }` → 401 `{ error: "invalid_token" }`

### AC3: Invalid signature
- TEST: JWT signed with a different secret → 401 `{ error: "invalid_token" }`
- TEST: JWT with tampered payload → 401

### AC4: Expired JWT
- TEST: JWT with exp in the past → 401 `{ error: "invalid_token" }`

### AC5: Cookie attributes
- TEST: Cookie has HttpOnly flag
- TEST: Cookie has Secure flag (production)
- TEST: Cookie omits Secure flag when `POLO_AI_WEBUI_SECURE_COOKIE=false` or request host is localhost
- TEST: Cookie has SameSite=Strict
- TEST: Cookie has Path=/
- TEST: Cookie Max-Age is 86400

### AC6: GET /auth/me — session check
- TEST: GET /auth/me with valid polo_ai_session cookie → 200 with `{ user: { id, username, role } }`
- TEST: GET /auth/me without cookie → 401
- TEST: GET /auth/me with expired cookie → 401
- TEST: Used by WebUI on load to check if already logged in (skip login page if valid)

### AC7: JWT_SECRET not configured
- TEST: POST /auth/session when JWT_SECRET env var is missing → 500 with `{ error: "server_configuration_error" }`
- TEST: Server logs a clear error message about missing JWT_SECRET at startup

### AC8: POST /auth/logout
- TEST: POST /auth/logout with valid cookie → 200 with `{ success: true }`
- TEST: Response clears polo_ai_session cookie (Max-Age=0)
- TEST: JWT is removed from in-memory store
- TEST: POST /auth/logout without cookie → 200 (no-op, idempotent)

## API Contract

```
POST /auth/session
Content-Type: application/json
{ "token": "eyJ..." }

Response 200:
Set-Cookie: polo_ai_session=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400
{ "user": { "id": "uuid", "username": "alice", "role": "user" } }

Response 400:
{ "error": "validation_error", "message": "token field required" }

Response 401:
{ "error": "invalid_token" }

GET /auth/me
Cookie: polo_ai_session=<jwt>

Response 200:
{ "user": { "id": "uuid", "username": "alice", "role": "user" } }

Response 401:
{ "error": "session_expired" }

POST /auth/logout
Cookie: polo_ai_session=<jwt>

Response 200:
Set-Cookie: polo_ai_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0
{ "success": true }
```

## Error Codes

| Scenario | HTTP Status | error code |
|----------|-------------|------------|
| Valid JWT | 200 | — |
| Missing token | 400 | validation_error |
| Invalid/expired JWT | 401 | invalid_token |
| Session check failed | 401 | session_expired |
| JWT_SECRET missing | 500 | server_configuration_error |

## Environment Context

- **Runtime**: Bun
- **Files to modify**: `packages/server-core/src/webui/http-server.ts` (route), `packages/server-core/src/webui/auth.ts` (JWT verify logic)
- **Existing auth infra**: `verifyJwt()` in auth.ts uses `jose` library, HS256 — reuse/extend to accept new payload shape `{ sub: userId, username, role }`
- **Env vars**: `JWT_SECRET`
- **Test file**: `packages/server-core/src/webui/__tests__/auth-session.test.ts` (new)
- **Test runner**: `bun test`

## Implementation Notes

- Reuse existing `jose` library already in the project for JWT verification
- Current JWT payload is `{ sub: 'webui', iat, exp }` — new payload is `{ sub: userId, username, role, iat, exp }` per shared-contract.md §1.2
- In-memory JWT store: `Map<string, string>` (userId → jwt) — exported for use by Admin API client
- Existing `buildSessionCookie()` helper in auth.ts already supports a `secure` param — reuse it
- Secure flag: default true in production, false when `POLO_AI_WEBUI_SECURE_COOKIE=false` or localhost (existing env var from server index.ts)
- Cookie name is `polo_ai_session` (matches existing SESSION_COOKIE_NAME constant)
- In-memory JWT store cleanup: entries should be removed on logout and when JWT expires (use a TTL map or periodic sweep)
- Use shared helper `isPlatformMode()` (checks `!!process.env.PLATFORM_ANTHROPIC_API_KEY`) — define once, import everywhere
