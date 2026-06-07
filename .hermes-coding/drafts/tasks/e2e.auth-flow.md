---
id: e2e.auth-flow
module: e2e
type: e2e
priority: 18
status: pending
estimatedMinutes: 35
dependencies: [auth.login-page, auth.startup-flow, auth.logout, auth.global-401, auth.error-pages, cleanup.old-auth, llm.credential-store]
---
# E2E Test: Login / Logout / Session-Expired Flows

## Description
End-to-end Playwright tests covering the complete authentication user journey:
1. Login with valid credentials → enter app
2. Login with wrong credentials → error message
3. Login with disabled account → disabled message
4. Login when rate limited → rate limit message with countdown
5. Logout → return to login page
6. Session expired during runtime → dialog → redirect to login
7. Startup with no token → login page
8. Startup when Admin unreachable → server error page
9. Login success but config fetch fails → config error page

Uses MSW (or network intercept) to mock Admin API responses.

## Server Setup
- Start command: `bun run server:dev` (or Electron dev mode)
- Ready signal: Server listening log message
- Required services: None (Admin API is mocked via MSW/network intercept)
- Teardown: Kill dev server, clear test storage

## Scenario Steps

### Scenario 1: Successful Login
1. Navigate to app URL (no cached token)
2. Assert: LoginPage is displayed with username + password fields
3. Screenshot: `login-page-initial`
4. Type "zhangsan" in username, "correct_password" in password
5. Click submit
6. Assert: App main view is displayed, username "zhangsan" visible
7. Screenshot: `login-success-main-view`

### Scenario 2: Failed Login (Invalid Credentials)
1. Navigate to login page
2. Type "zhangsan" in username, "wrong_password" in password
3. Click submit
4. Assert: Error message "用户名或密码错误" is visible
5. Screenshot: `login-error-invalid-credentials`

### Scenario 3: Logout
1. Login successfully
2. Navigate to settings / click user menu
3. Click "Logout" / "登出"
4. Assert: LoginPage is displayed
5. Assert: Refreshing page shows LoginPage (token cleared)
6. Screenshot: `after-logout`

### Scenario 4: Session Expired
1. Login successfully, enter main app
2. Mock next Admin API call to return 401
3. Trigger an Admin API call (e.g., quota check)
4. Assert: SessionExpiredDialog is displayed
5. Screenshot: `session-expired-dialog`
6. Click "重新登录"
7. Assert: LoginPage is displayed

### Scenario 5: Server Unreachable at Startup
1. Mock Admin API to be unreachable (network error)
2. Set a cached token in storage
3. Navigate to app URL
4. Assert: ServerErrorPage is displayed with retry button
5. Screenshot: `server-error-page`

## Screenshot Checkpoints
| Step | Checkpoint Name | What to Verify |
|------|----------------|---------------|
| Scenario 1, Step 2 | login-page-initial | Username + password fields visible, submit button present |
| Scenario 1, Step 6 | login-success-main-view | Main app view loaded, user info displayed |
| Scenario 2, Step 4 | login-error-invalid-credentials | Error message visible, fields retain values |
| Scenario 3, Step 4 | after-logout | LoginPage displayed, no user info |
| Scenario 4, Step 4 | session-expired-dialog | Modal dialog with expired message |
| Scenario 5, Step 4 | server-error-page | Error page with retry button and server URL |

## Browser Config
- Viewport: 1280x720 (desktop)
- Auth state: Varies per scenario (no token / pre-authenticated)
- Test data: MSW handlers for Admin API mock responses

## Acceptance Criteria
1. All 7+ scenarios pass
2. Screenshots captured at each checkpoint
3. Login → app entry takes <3s (mock API, no real network)
4. No console errors during happy path flows

## Test Cases (Red Phase)
- TEST: Navigate to app with no token → LoginPage rendered with username + password fields (screenshot: login-page-initial)
- TEST: Submit valid credentials → main app view loads, username displayed (screenshot: login-success-main-view)
- TEST: Submit invalid credentials → "用户名或密码错误" error visible (screenshot: login-error-invalid-credentials)
- TEST: Click logout → LoginPage displayed, refresh still shows LoginPage (screenshot: after-logout)
- TEST: Admin API returns 401 during runtime → SessionExpiredDialog displayed (screenshot: session-expired-dialog)
- TEST: Click "重新登录" in dialog → LoginPage displayed
- TEST: Startup with cached token + Admin unreachable → ServerErrorPage with retry button (screenshot: server-error-page)
- TEST: Click retry on ServerErrorPage when Admin recovers → proceeds to app
- TEST: No JavaScript console errors during successful login flow
- TEST: Login with disabled account → "账号已被禁用，请联系管理员" visible (screenshot: login-error-disabled)
- TEST: Login when rate limited (429 + Retry-After: 30) → "请 30 秒后再试" visible, submit button disabled (screenshot: login-rate-limited)
- TEST: Login success but config fetch fails → ConfigErrorPage displayed with retry button (screenshot: config-error-page)

## Fixtures Required
- MSW handlers for all Admin API endpoints (login, validate, logout, llm-connections)
- Configurable mock responses (success, 401, 429, network error)
- Playwright test helpers for login/logout
