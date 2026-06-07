---
id: auth.login-page
module: auth
type: ui
priority: 2
status: completed
estimatedMinutes: 30
dependencies: [auth.admin-api-client]
startedAt: 2026-06-07T07:34:22.401Z
completedAt: 2026-06-07T08:02:16.602Z
---
# LoginPage UI Component

## Description
Create the `LoginPage` component that renders a username + password login form. On submit, it calls the platform auth layer (Electron IPC `auth:login` or WebUI server proxy) and handles success (delegate token storage to platform, navigate to app) and all error states (invalid credentials, account disabled, rate limited, network error, config fetch failure). This replaces the existing shared-password login page.

**Security**: LoginPage NEVER handles or sees the raw JWT. On Electron, it calls IPC; on WebUI, the server sets an HttpOnly cookie. The component only receives success/failure results.

## Environment Context
- UI framework: React (TypeScript)
- Package manager: Bun
- Test strategy: Mock AdminApiClient (unit tests), Playwright screenshots (E2E)
- Key files:
  - Create: `apps/electron/src/renderer/pages/LoginPage.tsx`
  - Modify: `apps/webui/src/login.html` and `apps/webui/src/App.tsx`

## State Matrix
| State | Condition | Renders |
|-------|-----------|---------|
| Idle | Initial load | Username + password fields, submit button enabled |
| Submitting | Form submitted, awaiting response | Submit button disabled with spinner, fields disabled |
| Error: Invalid Credentials | 401 invalid_credentials | Error message "用户名或密码错误", fields remain filled |
| Error: Account Disabled | 403 account_disabled | Error message "账号已被禁用，请联系管理员", fields remain filled |
| Error: Rate Limited | 429 rate_limited | Error message "请 N 秒后再试", submit button disabled with countdown |
| Error: Network | Network unreachable | Error message "无法连接服务器，请检查网络连接" + retry hint |

## Accessibility
- Keyboard navigation: Tab order is username → password → submit. Enter key submits form.
- Screen reader: Form fields have associated labels. Error messages use role="alert". Submit button has aria-busy during loading.
- Focus management: On error, focus moves to error message.

## Acceptance Criteria
1. Form has username input, password input, and submit button
2. Submit calls platform auth layer (IPC on Electron, server proxy on WebUI) — NOT AdminApiClient directly
3. On success, platform stores token securely (safeStorage / HttpOnly cookie), component navigates to main app
4. Each error type shows a distinct, user-readable error message
5. Rate limit error shows countdown timer from Retry-After
6. Submit button is disabled while request is in-flight
7. Password field masks input

## Test Cases (Red Phase)

### Rendering
- TEST: LoginPage renders → username input, password input, and submit button are visible
- TEST: Password input has type="password" → input is masked

### Form Submission
- TEST: Enter username "zhangsan" and password "pass", click submit → AdminApiClient.login called with ("zhangsan", "pass")
- TEST: Press Enter in password field → form submits (same as clicking submit)
- TEST: While request in-flight → submit button shows spinner and is disabled, both inputs are disabled

### Success
- TEST: login() resolves with { user } (NO token field in response) → navigates away from LoginPage (router changes to main app route)

### Config Fetch Failure
- TEST: login() succeeds but config fetch fails → navigates to ConfigErrorPage (not main app)

### Error States
- TEST: login() throws InvalidCredentialsError → shows "用户名或密码错误" error message with role="alert"
- TEST: login() throws AccountDisabledError → shows "账号已被禁用，请联系管理员" error message
- TEST: login() throws RateLimitedError(retryAfterSeconds=30) → shows "请 30 秒后再试", submit button disabled for 30s
- TEST: login() throws NetworkError → shows "无法连接服务器，请检查网络连接"
- TEST: After error, username and password fields retain their values (not cleared)

### Keyboard/Accessibility
- TEST: Tab order cycles: username → password → submit
- TEST: On error display, error message element has role="alert"

## Fixtures Required
- Mock AdminApiClient.login() returning success/failure variants
- Router mock to verify navigation on success
