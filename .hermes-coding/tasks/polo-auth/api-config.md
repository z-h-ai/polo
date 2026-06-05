---
id: polo-auth.api-config
title: "Add GET /api/public-config endpoint (pre-login config)"
module: polo-auth
priority: 1
estimatedMinutes: 15
depends: []
status: pending
spec_ref: "spec-polo-ai.md §3.1 — split into public (pre-login) and authenticated (post-login) config"
---
# Add GET /api/public-config endpoint (pre-login config)


## Objective

Split the existing authenticated `/api/config` endpoint: add a new public `GET /api/public-config` that returns `{ adminUrl, platformMode }` without requiring a session cookie. The existing `/api/config` remains authenticated and continues to return `{ wsUrl }`. The login page needs `adminUrl` before any cookie exists.

## Acceptance Criteria

### AC1: Public config endpoint (no auth required)
- TEST: GET /api/public-config without any cookie → 200 with `{ adminUrl, platformMode }`
- TEST: `adminUrl` comes from `ADMIN_API_URL` env var
- TEST: `platformMode` is true when `PLATFORM_ANTHROPIC_API_KEY` is set, false otherwise
- TEST: When `ADMIN_API_URL` is not set, `adminUrl` is null

### AC2: Existing /api/config remains unchanged
- TEST: GET /api/config without cookie → 401
- TEST: GET /api/config with valid cookie → 200 with `{ wsUrl }` (existing behavior preserved)

### AC3: Missing env vars
- TEST: ADMIN_API_URL unset → response `{ adminUrl: null, platformMode: false }` (200, no crash)
- TEST: Both env vars unset → 200 with `{ adminUrl: null, platformMode: false }`

### AC4: Does not leak secrets
- TEST: Response body does NOT contain `PLATFORM_ANTHROPIC_API_KEY` value
- TEST: Response body does NOT contain `JWT_SECRET` value

## API Contract

```
GET /api/public-config
No auth required.

Response 200:
{
  "adminUrl": "http://localhost:3001" | null,
  "platformMode": true | false
}
```

## Error Codes

| Scenario | HTTP Status | Body |
|----------|-------------|------|
| Success | 200 | `{ adminUrl, platformMode }` |
| Server error | 500 | `{ error: "internal_error" }` |

## Environment Context

- **Runtime**: Bun
- **File to modify**: `packages/server-core/src/webui/http-server.ts`
- **Env vars read**: `ADMIN_API_URL`, `PLATFORM_ANTHROPIC_API_KEY`
- **Test file**: `packages/server-core/src/webui/__tests__/http-server-config.test.ts` (new)
- **Dependencies**: none (new route in existing HTTP server)
- **Test runner**: `bun test`

## Implementation Notes

- Add route handler in the existing HTTP server's route table
- Read env vars at request time (not startup-cached) to support hot reconfig
- Do NOT expose actual key values — only boolean presence check
- Use shared helper `isPlatformMode()` (checks `!!process.env.PLATFORM_ANTHROPIC_API_KEY`) — define once, import everywhere
