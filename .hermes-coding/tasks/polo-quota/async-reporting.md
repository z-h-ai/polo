---
id: polo-quota.async-reporting
title: "Implement background usage retry timer"
module: polo-quota
priority: 14
estimatedMinutes: 25
depends: ["polo-quota.usage-capture"]
status: pending
spec_ref: "spec-polo-ai.md §5.2, §6.2 (异步用量上报+pending 重试)"
---
# Implement background usage retry timer


## Objective

Implement a background timer that retries pending usage reports every 30 seconds. After 3 failed retries, entries are preserved but skipped. On server startup, load pending entries and start the timer.

## Acceptance Criteria

### AC1: Background timer
- TEST: Timer fires every 30 seconds
- TEST: Timer processes all pending entries with retryCount < 3
- TEST: Entries with retryCount >= 3 are skipped (preserved for investigation)

### AC2: Successful retry
- TEST: Pending entry retried → Admin returns 200 → entry removed from store
- TEST: Pending entry retried → Admin returns 409 (duplicate) → entry removed from store

### AC3: Failed retry
- TEST: Network error on retry → retryCount incremented, entry stays in store
- TEST: HTTP 500 on retry → retryCount incremented
- TEST: HTTP 401 (expired JWT) → retryCount incremented, entry stays

### AC4: Startup behavior
- TEST: On server startup, pending entries from JSONL file are loaded into memory
- TEST: Background timer starts on startup
- TEST: Previously pending entries are retried on next timer tick

### AC5: Timer lifecycle
- TEST: `startRetryTimer()` starts the interval
- TEST: `stopRetryTimer()` clears the interval cleanly (graceful shutdown)
- TEST: Timer does not process new batch while previous batch is still in progress

### AC6: Concurrency guard
- TEST: If retry processing takes >30s, next timer tick is skipped (no overlap)
- TEST: Entries are processed sequentially (not all at once) to avoid overwhelming Admin

### AC7: Lifecycle integration
- TEST: `startRetryTimer()` called in `packages/server-core/src/bootstrap/headless-start.ts` during server initialization
- TEST: `stopRetryTimer()` called during server shutdown/graceful exit
- TEST: Timer does not leak on server restart in tests

### AC8: Shared reporting logic with immediate report (T027)
- TEST: Both immediate reporting (T027) and retry (T028) use the same `reportPendingEntry(entry)` function
- TEST: `reportPendingEntry` handles 200 → remove, 409 → remove, error → markRetry consistently
- TEST: No duplicate logic between immediate and retry paths

## Boundary Matrix

| retryCount | Admin response | Outcome |
|-----------|---------------|---------|
| 0 | 200 | removed |
| 0 | network error | retryCount=1, stays |
| 1 | 500 | retryCount=2, stays |
| 2 | network error | retryCount=3, stays |
| 3 | N/A | skipped by timer |
| 0 | 409 | removed (already recorded) |
| 0 | 401 | retryCount=1 (JWT expired) |

## Environment Context

- **Runtime**: Bun
- **File to create or extend**: `packages/shared/src/admin-api/usage-reporter.ts` (new module for retry logic)
- **Imports**: `pendingUsageStore` (T025), `adminApiClient` (T024)
- **Startup integration**: `packages/server-core/src/bootstrap/headless-start.ts` — call `startRetryTimer()`
- **Test file**: `packages/shared/src/admin-api/__tests__/usage-reporter.test.ts`
- **Test runner**: `bun test`

## Implementation Notes

- Use `setInterval(30_000)` for the timer
- Process entries sequentially with `for...of` loop (avoid Promise.all)
- Use a `processing` boolean flag to prevent overlapping batches
- Each pending entry stores `userJwt` (captured at write time in T027)
- Retry uses `entry.userJwt` for `Authorization: Bearer` header
- JWT has 24h TTL — entries older than 24h will fail with 401, retryCount increments, entry preserved for manual resolution
- Export `startRetryTimer()` and `stopRetryTimer()` for lifecycle management
