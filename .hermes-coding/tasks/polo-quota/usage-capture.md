---
id: polo-quota.usage-capture
title: "Capture usage from SessionManager complete event"
module: polo-quota
priority: 13
estimatedMinutes: 25
depends: ["polo-quota.sendmessage-quota"]
status: completed
spec_ref: "spec-polo-ai.md §5.2 (Usage 捕获)"
startedAt: 2026-06-05T19:42:22.878Z
completedAt: 2026-06-05T19:55:05.541Z
---
# Capture usage from SessionManager complete event


## Objective

Hook into SessionManager's `complete` event handling to capture token usage. When `event.type === 'complete'` fires in SessionManager's event iteration loop, extract `event.usage` (AgentEventUsage with inputTokens, outputTokens) and the model name. Write the captured usage to pending store with the quota context (requestId, userId, userJwt) that was attached during sendMessage (T026). Then trigger async reporting.

## Acceptance Criteria

### AC1: Usage extraction from complete event
- TEST: When SessionManager processes `event.type === 'complete'`, captured usage = event.usage `{ inputTokens, outputTokens }`
- TEST: Model name extracted from the session's active connection/model config
- TEST: If event.usage is undefined/null → skip usage capture (no-op, log warning)

### AC2: Quota context retrieval
- TEST: Retrieves the quota context (requestId, userId, userJwt, sessionId) attached during sendMessage (T026)
- TEST: If no quota context exists (non-platform mode or system call) → skip capture

### AC3: Pending store write
- TEST: Captured usage is written to pendingUsageStore.add() with: requestId, userId, userJwt, sessionId, model, inputTokens, outputTokens
- TEST: `userJwt` is taken from quota context for later retry authentication
- TEST: All fields populated from quota context and event.usage

### AC4: Triggers async reporting
- TEST: After writing to pending store, calls `adminApiClient.reportUsage()` (fire-and-forget)
- TEST: On success → `pendingUsageStore.remove(requestId)`
- TEST: On failure → `pendingUsageStore.markRetry(requestId)` (entry persists)

### AC5: Error resilience
- TEST: If usage capture throws, server does NOT crash
- TEST: If capture throws, user still receives their LLM response
- TEST: Error is logged for debugging

### AC6: Non-platform mode
- TEST: Without PLATFORM_ANTHROPIC_API_KEY, usage capture is NOT triggered
- TEST: No pending store writes in non-platform mode

## Boundary Matrix

| Platform mode | Event result | Report result | Outcome |
|-------------|-------------|---------------|---------|
| no | any | N/A | no capture |
| yes | complete, usage={100, 200} | 200 OK | add then remove from pending |
| yes | complete, usage={100, 200} | network error | add, markRetry |
| yes | complete, usage={100, 200} | 409 duplicate | add then remove |
| yes | capture throws | N/A | error logged, user unaffected |

## Environment Context

- **File to modify**: `packages/server-core/src/sessions/SessionManager.ts` — in the event iteration loop where `event.type === 'complete'` is handled
- **No onTurnComplete callback exists** — usage capture happens inline in the complete event handler
- **Imports**: `pendingUsageStore` (T025), `adminApiClient` (T024)
- **Test file**: `packages/server-core/src/sessions/__tests__/usage-capture.test.ts`
- **Test runner**: `bun test`

## Implementation Notes

- SessionManager iterates SDK events and handles `event.type === 'complete'` with `usage: AgentEventUsage`
- Usage capture code goes directly in the complete event handler, not via a callback
- Register quota context in sendMessage handler (T026), passing requestId and user context
- Make reporting async but do NOT await it from user's perspective (fire-and-forget)
- The async report attempt is part of this task; the background retry timer is T028
