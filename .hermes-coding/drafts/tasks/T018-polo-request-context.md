---
id: polo-auth.request-context
title: "Extend RequestContext with user identity fields"
module: polo-auth
priority: 4
estimatedMinutes: 15
depends: ["polo-auth.ws-upgrade"]
status: pending
spec_ref: "spec-polo-ai.md §3.3 (RequestContext 扩展)"
---
# Extend RequestContext with user identity fields


## Objective

Add `userId`, `username`, `userRole`, and `userJwt` to the `RequestContext` interface. Propagate these from the WebSocket connection context (set during upgrade in T017) to all RPC handlers.

## Acceptance Criteria

### AC1: Type extension
- TEST: `RequestContext` interface includes `userId: string | null`
- TEST: `RequestContext` interface includes `username: string | null`
- TEST: `RequestContext` interface includes `userRole: 'admin' | 'user' | null`
- TEST: `RequestContext` interface includes `userJwt: string | null`
- TEST: `bun run typecheck:all` passes after changes

### AC2: Propagation from WS connection
- TEST: RPC handler receives `ctx.userId` matching JWT `sub` claim from upgrade
- TEST: RPC handler receives `ctx.userJwt` containing the raw JWT string
- TEST: For server-token connections, `ctx.userId` is null and `ctx.userRole` is `'admin'`

### AC3: Backward compatibility
- TEST: Existing RPC handlers that do not use new fields compile and run unchanged
- TEST: All existing mock/builder helpers for RequestContext are updated to include `userId: null, username: null, userRole: null, userJwt: null`
- TEST: Fields are `string | null` (non-optional, always present) — not `string?` (optional)

### AC4: ClientConnection extension
- TEST: `ClientConnection` interface also holds `userId: string | null`, `username: string | null`, `userRole: 'admin' | 'user' | null`, `userJwt: string | null`
- TEST: Values set once during connection establishment (from validateSessionCookie result)
- TEST: RequestContext fields populated from ClientConnection on each RPC call

### AC5: onClientConnected callback payload
- TEST: `onClientConnected` event payload includes userId and username
- TEST: Downstream listeners can use userId for connection tracking

## Boundary Matrix

| Connection type | userId | username | userRole | userJwt |
|----------------|--------|----------|----------|---------|
| Cookie JWT | UUID string | "alice" | "user" | "eyJ..." |
| Server token | null | "system" | "admin" | null |
| No auth (rejected) | N/A | N/A | N/A | N/A |

## Environment Context

- **Runtime**: Bun
- **File to modify**: `packages/server-core/src/transport/types.ts` (RequestContext interface)
- **File to modify**: `packages/server-core/src/transport/server.ts` (context creation during WS connection)
- **File to verify**: `packages/server-core/src/handlers/rpc/index.ts` (context pass-through)
- **Test**: `bun run typecheck:all` + existing test suite passes
- **Test runner**: `bun test`

## Implementation Notes

- All new fields are `T | null` (non-optional, always present) — must be explicitly set to `null` in non-JWT connections
- ClientConnection (internal interface in server.ts) must also carry the user fields — RequestContext is derived from it per-RPC-call
- Update the context creation in the message handler where RequestContext is built from ClientConnection
- Update all existing test mock builders for both ClientConnection and RequestContext
- Context is created once during WebSocket upgrade and reused for all messages on that connection
- No new dependencies needed — pure type + wiring change
