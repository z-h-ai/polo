---
id: polo-ui.quota-display
title: "WebUI quota display component"
module: polo-ui
priority: 16
estimatedMinutes: 25
depends: ["polo-ui.login-page", "polo-client.admin-api", "polo-auth.session-endpoint"]
status: completed
spec_ref: "spec-polo-ai.md §8.4 (配额显示)"
startedAt: 2026-06-05T20:27:11.032Z
completedAt: 2026-06-05T20:44:41.089Z
---
# WebUI quota display component


## Objective

Add a quota usage display in the WebUI top bar showing the user's current month token usage vs limit. Fetches data from Polo AI server proxy `GET /api/quota/status` (server forwards to Admin using the stored JWT from the user's session). Only visible in platform mode.

## Acceptance Criteria

### AC1: Quota display rendering
- TEST: In platform mode, top bar shows usage like "154K / 1M tokens"
- TEST: Numbers are human-readable: K for thousands, M for millions
- TEST: Visual progress bar or percentage indicator shows usage level

### AC2: Color coding by usage level
- TEST: Usage <75% → green/neutral indicator
- TEST: Usage 75-90% → yellow/warning indicator
- TEST: Usage >90% → red/danger indicator
- TEST: Usage >=100% → red with "Quota exceeded" text

### AC3: Data fetching (via Polo AI server proxy)
- TEST: Component calls Polo AI `GET /api/quota/status` on mount (same origin, cookie-authenticated)
- TEST: Polo AI server proxies to Admin `GET /api/quota/status` using stored JWT from user session
- TEST: Component refreshes after each message send completes
- TEST: Loading state shows spinner or "Loading..." placeholder

### AC4: Non-platform mode
- TEST: When platformMode=false, quota component is NOT rendered
- TEST: No API calls made for quota status in non-platform mode

### AC5: Error handling
- TEST: If quota status API fails, shows "Usage unavailable" (no crash)
- TEST: Retries on next message send even after previous failure
- TEST: JWT expired (401) → shows "Session expired" prompt

### AC6: Server-side proxy endpoint
- TEST: Polo AI server exposes `GET /api/quota/status` (authenticated by polo_ai_session cookie)
- TEST: Server extracts userId from cookie JWT, looks up stored JWT from in-memory map
- TEST: Server forwards to Admin `GET /api/quota/status` with `Authorization: Bearer <stored-jwt>`
- TEST: Server returns Admin response to browser (or error if Admin unreachable)
- TEST: 401 from Admin → server returns 401 to browser (session expired)

### AC7: Refresh triggers
- TEST: Quota refreshes after agent complete event (via Jotai atom or event listener)
- TEST: Quota refreshes on WebSocket reconnect
- TEST: 401 response from proxy → redirect to login page

## State Matrix

| State | Display text | Color | Progress bar |
|-------|-------------|-------|-------------|
| Loading | "Loading..." | neutral | indeterminate |
| Normal (<75%) | "154K / 1M" | green | 15% |
| Warning (75-90%) | "820K / 1M" | yellow | 82% |
| Critical (>90%) | "950K / 1M" | red | 95% |
| Exhausted (>=100%) | "1M / 1M — Quota exceeded" | red | 100% |
| Error | "Usage unavailable" | gray | hidden |
| Non-platform | (hidden) | — | — |

## Environment Context

- **Runtime**: Bun + Vite
- **Framework**: React + Tailwind CSS + Radix UI
- **Files to modify**: WebUI top bar / header component in `apps/webui/`
- **API**: Polo AI `GET /api/quota/status` (proxy) — server reads user's cookie, looks up stored JWT, forwards to Admin
- **State management**: Jotai (project uses jotai)
- **WebUI architecture**: Independent React app that reuses Electron renderer transport (Jotai atoms, CHANNEL_MAP, buildClientApi). Changes to shared UI go in packages/ui/ or packages/shared/; WebUI-specific changes in apps/webui/.
- **Test**: Playwright screenshot test for visual states
- **Dev command**: `bun run webui:dev`

## Implementation Notes

- Format helper: `formatTokens(154000)` → "154K", `formatTokens(1000000)` → "1M"
- WebUI fetches same-origin `GET /api/quota/status` — Polo AI server proxies to Admin using the stored JWT (no JWT in browser JS)
- Polo AI server proxy endpoint: added as part of this task in `http-server.ts` (alongside /api/public-config and /auth/session)
- Use CSS transitions for smooth color changes between states
- Refresh quota after message send by listening to a Jotai atom or event
