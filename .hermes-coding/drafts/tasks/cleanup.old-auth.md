---
id: cleanup.old-auth
module: cleanup
type: domain
priority: 13
status: pending
estimatedMinutes: 35
dependencies: [auth.startup-flow, auth.login-page, auth.admin-api-client]
---
# Remove CRAFT_WEBUI_PASSWORD / CRAFT_SERVER_TOKEN Auth

## Description
Remove the legacy shared-password authentication mechanisms and replace with JWT-based auth using Admin-issued JWT (Bearer token header for this phase — HttpOnly cookie + CSRF is deferred to a future phase).

**Removals:**
1. `CRAFT_WEBUI_PASSWORD` — used by WebUI for shared password login
2. `CRAFT_SERVER_TOKEN` — used by server for API authentication
3. `CRAFT_WEBUI_SECURE_COOKIE` — auto-detect instead

**Replacements:**
- HTTP auth middleware: validate Admin JWT (Bearer token) instead of shared password/token
- WebSocket handshake: validate JWT from Bearer header (cookie-based auth deferred)
- WebUI login page: update to username+password form calling Admin API
- Server startup: read `POLO_ADMIN_API_URL` instead of `CRAFT_SERVER_TOKEN`

**Files to modify:**
- `packages/server-core/src/webui/auth.ts` — replace password check with JWT validation
- `packages/server-core/src/webui/http-server.ts` — update auth middleware
- `packages/server/src/index.ts` — replace CRAFT_SERVER_TOKEN with JWT, remove password auth
- `apps/webui/src/login.html` — update to username+password form
- `apps/cli/src/server-spawner.ts` — update token handling
- `apps/electron/src/preload/bootstrap.ts` — update token reference

## Environment Context
- Package manager: Bun
- Test strategy: Mock JWT validation
- Key concern: JWT has NO `exp` claim — test revoked/invalid tokens, NOT expired tokens
- Env vars to remove: CRAFT_WEBUI_PASSWORD, CRAFT_SERVER_TOKEN, CRAFT_WEBUI_SECURE_COOKIE

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| Request with valid JWT (Bearer header) | Authenticated user | Access granted |
| Request with no JWT | Unauthenticated | 401, redirect to login |
| Request with revoked JWT | Session revoked | 401 with `token_revoked` error |
| Request with old CRAFT_SERVER_TOKEN | Legacy auth | Rejected (mechanism removed) |
| WebSocket upgrade with JWT (Bearer) | Auth via header | WS connection established |
| WebSocket upgrade without JWT | No auth | WS connection rejected |
| Env var CRAFT_WEBUI_PASSWORD set | Legacy env var | Ignored (no code reads it) |

## Acceptance Criteria
1. `CRAFT_WEBUI_PASSWORD` is no longer read or used anywhere in packages/ or apps/
2. `CRAFT_SERVER_TOKEN` is no longer read or used anywhere in packages/ or apps/
3. `CRAFT_WEBUI_SECURE_COOKIE` is no longer read or used anywhere
4. HTTP requests are authenticated via JWT Bearer token header
5. WebSocket handshake validates JWT from Bearer header
6. WebUI login page is username+password form (not single password field)
7. Server startup uses `POLO_ADMIN_API_URL` for auth configuration

## Test Cases (Red Phase)

### JWT Auth (Bearer Header)
- TEST: HTTP request with valid JWT in `Authorization: Bearer` header → 200, access granted
- TEST: HTTP request without Authorization header → 401
- TEST: HTTP request with revoked JWT → 401 with `{ error: "token_revoked" }`
- TEST: HTTP request with malformed JWT (not a valid JWT format) → 401

### Legacy Auth Removed
- TEST: `grep -r "CRAFT_WEBUI_PASSWORD" packages/ apps/` returns no results (excluding test files verifying removal)
- TEST: `grep -r "CRAFT_SERVER_TOKEN" packages/ apps/` returns no results (excluding test files verifying removal)
- TEST: `grep -r "CRAFT_WEBUI_SECURE_COOKIE" packages/ apps/` returns no results
- TEST: HTTP request with `Authorization: Bearer <old-CRAFT_SERVER_TOKEN>` → rejected (not a valid JWT)
- TEST: Environment variable CRAFT_WEBUI_PASSWORD has no effect on auth behavior

### WebSocket
- TEST: WebSocket upgrade request with valid JWT in handshake headers → connection established
- TEST: WebSocket upgrade request without JWT → connection rejected

### WebUI Login
- TEST: Login page has username AND password fields (not just password)
- TEST: Login form submits to Admin API login endpoint (not old password check)

## Fixtures Required
- Mock JWT validation (valid/revoked/invalid)
- Test HTTP server for auth middleware testing
- WebSocket client for upgrade testing
