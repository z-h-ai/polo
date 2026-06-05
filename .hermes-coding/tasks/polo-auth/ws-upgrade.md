---
id: polo-auth.ws-upgrade
title: "Move WebSocket auth to HTTP upgrade phase (cookie-based)"
module: polo-auth
priority: 3
estimatedMinutes: 25
depends: ["polo-auth.session-endpoint"]
status: pending
spec_ref: "spec-polo-ai.md §3.2 (WebSocket 认证改造)"
---
# Move WebSocket auth to HTTP upgrade phase (cookie-based)


## Objective

Move WebSocket authentication from the handshake message to the HTTP upgrade phase. The server uses Node `ws` library (WebSocketServer), which receives the cookie header via `wss.on('connection', (ws, req) => { ... req.headers.cookie ... })`. Modify `onConnection()` to extract and verify JWT from the `polo_ai_session` cookie, storing the auth context on the connection object. Maintain backward compatibility with `POLO_AI_SERVER_TOKEN` handshake token.

## Acceptance Criteria

### AC1: Cookie-based auth at upgrade
- TEST: WS upgrade request with valid `polo_ai_session` cookie → connection accepted
- TEST: Connection data contains `{ userId, username, role, jwt }` extracted from JWT
- TEST: handshake_ack includes `userId` and `username` from connection context

### AC2: Server-token fallback
- TEST: WS upgrade with `x-server-token: <POLO_AI_SERVER_TOKEN>` header → accepted
- TEST: Fallback connection data: `{ userId: null, username: 'system', role: 'admin', jwt: null }`

### AC3: Rejection
- TEST: WS upgrade with no cookie and no server-token header → 401 rejection
- TEST: WS upgrade with expired JWT cookie → 401 rejection
- TEST: WS upgrade with JWT signed by wrong secret → 401 rejection

### AC4: Simplified handshake message
- TEST: Handshake `{ type: 'handshake', protocolVersion: '1.1', workspaceId: 'ws-1' }` accepted (no token field)
- TEST: handshake_ack response includes `clientId`, `userId`, `username`
- TEST: Old-format handshake with `token` field still accepted (backward compat during transition)

### AC5: Cookie parsing edge cases
- TEST: Parses `polo_ai_session` from Cookie header with multiple cookies: `"other=x; polo_ai_session=eyJ...; foo=bar"`
- TEST: Missing Cookie header → falls through to server-token check
- TEST: Cookie header present but no `polo_ai_session` → falls through to server-token check

### AC6: Reconnect identity consistency
- TEST: Reconnecting WebSocket with a different user's cookie than the original connection → reject or establish as new connection (not reuse old connection state)
- TEST: Reconnection with same userId → may reuse event buffer for replay

## Boundary Matrix

| Cookie | x-server-token | Result |
|--------|---------------|--------|
| valid JWT | absent | accept, user context |
| expired JWT | absent | 401 reject |
| absent | valid token | accept, system context |
| absent | invalid token | 401 reject |
| absent | absent | 401 reject |
| valid JWT | valid token | accept, user context (cookie takes priority) |

## Environment Context

- **Runtime**: Node ws library (NOT Bun native WebSocket)
- **File to modify**: `packages/server-core/src/transport/server.ts`
- **Current behavior**: `onConnection(ws, upgradeRequestCookie)` already receives cookie header; `validateSessionCookie` callback returns boolean
- **Change needed**: `validateSessionCookie` must return auth context `{ userId, username, role, jwt }` instead of just `boolean`
- **Reuse**: `verifyJwt()` from `packages/server-core/src/webui/auth.ts`
- **Env vars**: `JWT_SECRET`, `POLO_AI_SERVER_TOKEN`
- **Test file**: `packages/server-core/src/transport/__tests__/ws-auth-upgrade.test.ts` (new)
- **Test runner**: `bun test`

## Implementation Notes

- In Node ws library, use `wss.on('connection', (ws, req) => { ... req.headers.cookie ... })` to access headers
- Store auth context on the connection object (ClientConnection)
- Parse cookies with simple string split (no external library needed)
- Keep POLO_AI_SERVER_TOKEN path for CLI/Electron/service communication
- Update handshake_ack to include user identity fields
- Use shared helper `isPlatformMode()` (checks `!!process.env.PLATFORM_ANTHROPIC_API_KEY`) — define once, import everywhere
