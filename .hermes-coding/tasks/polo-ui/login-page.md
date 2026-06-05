---
id: polo-ui.login-page
title: "Create WebUI login page"
module: polo-ui
priority: 7
estimatedMinutes: 25
depends: ["polo-auth.api-config", "polo-auth.session-endpoint"]
status: pending
spec_ref: "spec-polo-ai.md §8.2 (WebUI 登录页)"
---
# Create WebUI login page


## Objective

Create a login page in Polo AI WebUI. Flow: check session via `/auth/me`, fetch config from `/api/public-config`, show username+password form, POST to Admin's `/api/auth/login`, then call Polo AI's `/auth/session` to set cookie, then redirect to main view.

## Acceptance Criteria

### AC1: Form rendering
- TEST: Login page renders username and password input fields
- TEST: Login page renders a "Login" submit button
- TEST: Submit button is disabled when either field is empty

### AC2: Login flow
- TEST: On mount → GET /auth/me → if valid session, skip login, redirect to main view
- TEST: If no session → GET /api/public-config → receives adminUrl and platformMode
- TEST: If platformMode=false → show error "Platform mode not enabled"
- TEST: If adminUrl is null → show error "Admin service not configured"
- TEST: On submit → POST `{adminUrl}/api/auth/login` with `{ username, password }`
- TEST: On login success → POST /auth/session with `{ token }` from login response
- TEST: On session success → GET /api/config to get wsUrl → redirect to main workspace view
- TEST: Preserves original redirect URL (if user was redirected to login from a deep link)

### AC3: Error states
- TEST: Admin returns 401 (invalid_credentials) → shows "Username or password incorrect"
- TEST: Admin returns 403 (account_disabled) → shows "Account disabled, contact administrator"
- TEST: Admin returns 429 (rate_limited) → shows "Too many attempts, try again later"
- TEST: Network error (Admin unreachable) → shows "Service temporarily unavailable"
- TEST: /auth/session returns 401 (invalid token) → shows "Authentication failed"
- TEST: Error message clears when user modifies input

### AC4: Redirect logic
- TEST: After login success, redirects to originally requested URL if any

### AC5: Visual testing
- TEST: Playwright screenshot of login page in initial state
- TEST: Playwright screenshot of login page in error state

## State Matrix

| State | Username | Password | Submit | Error | Transition |
|-------|----------|----------|--------|-------|------------|
| Initial | empty | empty | disabled | hidden | type → Partial |
| Partial | one filled | other empty | disabled | hidden | fill both → Ready |
| Ready | filled | filled | enabled | hidden | click → Loading |
| Loading | filled | filled | spinner | hidden | success → redirect / fail → Error |
| Error | filled | filled | enabled | visible | type → clears error |

## Environment Context

- **Runtime**: Bun + Vite dev server
- **Framework**: React (confirmed from package.json deps: react, react-dom, @vitejs/plugin-react)
- **UI library**: Radix UI + Tailwind CSS + Lucide icons
- **File**: `apps/webui/` — find existing router/entry and add login route
- **WebUI architecture**: Independent React app reusing Electron renderer transport (Jotai atoms, CHANNEL_MAP). Login page is WebUI-specific (apps/webui/), not shared with Electron.
- **Test**: Playwright screenshot test
- **Dev command**: `bun run webui:dev`

## Implementation Notes

- Match existing WebUI styling (Tailwind CSS, Radix UI components)
- Login API call to Admin is cross-origin (CORS) — Admin handles CORS for `/api/auth/login`
- Use `fetch` API, no extra HTTP library
- Store user info in React context/state after login
- Add Polo AI branding to login page
