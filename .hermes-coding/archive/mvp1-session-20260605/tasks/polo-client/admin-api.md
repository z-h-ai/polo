---
id: polo-client.admin-api
title: "Create Admin API Client module"
module: polo-client
priority: 10
estimatedMinutes: 25
depends: []
status: completed
spec_ref: "spec-polo-ai.md §6.1 (Admin API Client)"
startedAt: 2026-06-05T19:13:03.276Z
completedAt: 2026-06-05T19:19:11.895Z
---
# Create Admin API Client module


## Objective

Create a typed HTTP client that Polo AI Server uses to call Admin API endpoints: quota check, usage report, and quota status. Uses Bun-native `fetch` with per-method timeouts. Admin API is treated as an external service.

## Acceptance Criteria

### AC1: checkQuota
- TEST: `checkQuota(jwt)` sends POST to `{ADMIN_API_URL}/api/quota/check` with `Authorization: Bearer <jwt>`
- TEST: Returns `QuotaCheckResult { allowed, remaining, limit, used, period }`
- TEST: 3-second timeout — request aborted after 3s → throws AdminApiTimeoutError

### AC2: reportUsage
- TEST: `reportUsage(jwt, usage)` sends POST to `{ADMIN_API_URL}/api/quota/usage` with correct body
- TEST: Body includes `{ requestId, sessionId, model, inputTokens, outputTokens }`
- TEST: Returns `UsageReportResult { recorded, totalUsed, remaining }`
- TEST: 5-second timeout

### AC3: getQuotaStatus
- TEST: `getQuotaStatus(jwt)` sends GET to `{ADMIN_API_URL}/api/quota/status` with Bearer header
- TEST: Returns `QuotaStatus { userId, period, limit, used, remaining, usageBreakdown }`

### AC4: Error handling
- TEST: HTTP 401 → throws `AuthenticationError`
- TEST: HTTP 403 → throws `AccountDisabledError`
- TEST: HTTP 409 (duplicate) → throws `DuplicateRequestError`
- TEST: HTTP 500 → throws `AdminApiError` with status code
- TEST: Network error (fetch fails) → throws `AdminApiUnavailableError`
- TEST: Timeout → throws `AdminApiTimeoutError`

### AC5: Base URL config
- TEST: Reads `ADMIN_API_URL` from env var
- TEST: Handles trailing slash in URL: `http://host:3001/` → still works
- TEST: Missing `ADMIN_API_URL` → throws `ConfigurationError` on first call

## API Contract

From shared-contract.md §2:
```
POST /api/quota/check    — Bearer JWT — { estimatedTokens? } → { allowed, remaining, limit, used, period }
POST /api/quota/usage    — Bearer JWT — { requestId, sessionId, model, inputTokens, outputTokens } → { recorded, totalUsed, remaining }
GET  /api/quota/status   — Bearer JWT — → { userId, period, limit, used, remaining, usageBreakdown }
```

## Error Codes

| Admin HTTP | Thrown error class | Meaning |
|-----------|-------------------|---------|
| 200 | (none) | Success |
| 401 | AuthenticationError | JWT invalid/expired |
| 403 | AccountDisabledError | User disabled |
| 409 | DuplicateRequestError | requestId already reported |
| 500 | AdminApiError | Server error |
| timeout | AdminApiTimeoutError | No response in time |
| network | AdminApiUnavailableError | Admin unreachable |

## Environment Context

- **Runtime**: Bun (native fetch + AbortController)
- **File to create**: `packages/shared/src/admin-api/client.ts`
- **Types file**: `packages/shared/src/admin-api/types.ts` (new — shared types)
- **Env vars**: `ADMIN_API_URL`
- **Test file**: `packages/shared/src/admin-api/__tests__/client.test.ts` (mock fetch)
- **Test runner**: `bun test`

## Implementation Notes

- Use `AbortController` + `setTimeout` for per-request timeouts
- Export singleton instance and factory for testing
- Create custom error classes in `packages/shared/src/admin-api/errors.ts`
- All methods pass JWT as `Authorization: Bearer <jwt>` header
- No retry logic in client — retry is handled by pending-usage store (T028)
