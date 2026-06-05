---
id: polo-quota.sendmessage-quota
title: "Add quota check + ownership validation to sendMessage"
module: polo-quota
priority: 12
estimatedMinutes: 25
depends: ["polo-auth.workspace-ownership", "polo-client.admin-api", "polo-client.pending-usage"]
status: pending
spec_ref: "spec-polo-ai.md §5.1 (改造后的 sendMessage)"
---
# Add quota check + ownership validation to sendMessage


## Objective

Modify the `sendMessage` RPC handler to: (1) validate workspace ownership, (2) call Admin API quota check, (3) subtract local pending usage for effective remaining, (4) generate a requestId for usage tracking. All checks only in platform mode.

## Acceptance Criteria

### AC1: Ownership validation
- TEST: ctx.userId !== workspace.ownerUserId → ForbiddenError thrown, no LLM call
- TEST: ctx.userId === workspace.ownerUserId → proceeds to quota check
- TEST: ctx.userId is null (server-token) → skips ownership check

### AC2: Quota check
- TEST: Calls `adminApiClient.checkQuota(ctx.userJwt)` before LLM call
- TEST: Admin returns `allowed: false` → throws QuotaExceededError with `{ remaining, limit, used, period }`
- TEST: QuotaExceededError has user-friendly message about monthly reset

### AC3: Effective remaining calculation
- TEST: effectiveRemaining = admin.remaining - pendingUsageStore.getPendingTokens(ctx.userId)
- TEST: effectiveRemaining <= 0 → QuotaExceededError even if Admin said allowed=true
- TEST: No pending entries → effectiveRemaining equals admin.remaining

### AC4: RequestId propagation
- TEST: Each sendMessage generates a unique requestId (crypto.randomUUID())
- TEST: requestId is stored in a quota context object associated with the session/turn, NOT on RequestContext
- TEST: Quota context is accessible from the SessionManager complete event handler (for usage reporting)
- TEST: Quota context includes: requestId, userId, userJwt, sessionId

### AC5: Non-platform mode bypass
- TEST: Without PLATFORM_ANTHROPIC_API_KEY → ownership check skipped
- TEST: Without PLATFORM_ANTHROPIC_API_KEY → quota check skipped
- TEST: Existing non-platform sendMessage behavior unchanged

### AC6: Admin API unavailable
- TEST: Admin unreachable → ServiceUnavailableError (fail-closed, no LLM call)
- TEST: Admin timeout → ServiceUnavailableError

### AC7: Platform mode with null JWT
- TEST: In platform mode, ctx.userJwt=null (server-token path) → skip quota check (system/admin path)
- TEST: In platform mode, ctx.userJwt present → proceed with quota check
- TEST: In non-platform mode → skip all quota logic entirely

## Boundary Matrix

| Platform mode | Admin allowed | Pending tokens | Effective remaining | Result |
|-------------|--------------|----------------|--------------------|----- |
| no | N/A | N/A | N/A | skip checks, proceed |
| yes | true | 0 | 850000 | proceed |
| yes | true | 900000 | -50000 | QuotaExceededError |
| yes | false | any | 0 | QuotaExceededError |
| yes | error | any | N/A | ServiceUnavailableError |

## Environment Context

- **Runtime**: Bun
- **File to modify**: `packages/server-core/src/handlers/rpc/sessions.ts`
- **Imports**: `assertWorkspaceAccess` (T020), `adminApiClient` (T024), `pendingUsageStore` (T025)
- **New errors**: `QuotaExceededError`, `ServiceUnavailableError`
- **Test file**: `packages/server-core/src/handlers/rpc/__tests__/sessions-quota.test.ts`
- **Test runner**: `bun test`

## Implementation Notes

- Add quota logic at the START of sendMessage handler, before any LLM call
- `crypto.randomUUID()` for requestId
- Only run checks when `!!process.env.PLATFORM_ANTHROPIC_API_KEY`
- Create custom error classes: `QuotaExceededError`, `ServiceUnavailableError`
- Pass requestId through to usage capture callback
- Add ErrorCode variants to packages/shared/src/protocol/types.ts: 'FORBIDDEN', 'QUOTA_EXCEEDED', 'SERVICE_UNAVAILABLE', 'SESSION_EXPIRED'
- Create corresponding CodedError subclasses or use CodedError directly with these codes
- Use shared helper `isPlatformMode()` (checks `!!process.env.PLATFORM_ANTHROPIC_API_KEY`) — define once, import everywhere
