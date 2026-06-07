---
id: auth.error-pages
module: auth
type: ui
priority: 6
status: pending
estimatedMinutes: 20
dependencies: [auth.admin-api-client]
---
# ServerErrorPage + ConfigErrorPage + SessionExpiredDialog

## Description
Create three error-state UI components:
1. **ServerErrorPage** — shown when Admin API is unreachable at startup. Displays error message, server address hint, and retry button.
2. **ConfigErrorPage** — shown when login succeeds but LLM config fetch fails. Displays error message and retry button.
3. **SessionExpiredDialog** — modal shown when a 401 is received during runtime. Shows "会话已失效，请重新登录" with a button to go to LoginPage.

## Environment Context
- UI framework: React (TypeScript)
- Package manager: Bun
- Key files to create:
  - `apps/electron/src/renderer/pages/ServerErrorPage.tsx`
  - `apps/electron/src/renderer/pages/ConfigErrorPage.tsx`
  - `apps/electron/src/renderer/components/SessionExpiredDialog.tsx`

## State Matrix

### ServerErrorPage
| State | Condition | Renders |
|-------|-----------|---------|
| Error | Network error | Error message + server address + retry button |
| Retrying | Retry clicked | Spinner on retry button, button disabled |

### ConfigErrorPage
| State | Condition | Renders |
|-------|-----------|---------|
| Error | Config fetch failed | Error message + retry button |
| Retrying | Retry clicked | Spinner on retry button, button disabled |

### SessionExpiredDialog
| State | Condition | Renders |
|-------|-----------|---------|
| Visible | 401 during runtime | Modal with message + "重新登录" button |

## Accessibility
- Keyboard: Retry buttons focusable, Enter activates. Dialog traps focus.
- Screen reader: Error messages have role="alert". Dialog has aria-modal="true" and aria-label.

## Acceptance Criteria
1. ServerErrorPage shows "无法连接到认证服务器" message
2. ServerErrorPage shows the server URL (from POLO_ADMIN_API_URL) for troubleshooting
3. ServerErrorPage has a retry button that re-triggers validation
4. ConfigErrorPage shows "配置加载失败" message
5. ConfigErrorPage has a retry button that re-triggers config fetch
6. SessionExpiredDialog is a modal with "会话已失效，请重新登录" message
7. SessionExpiredDialog "重新登录" button navigates to LoginPage

## Test Cases (Red Phase)

### ServerErrorPage
- TEST: ServerErrorPage renders → shows text containing "无法连接" or "认证服务器"
- TEST: ServerErrorPage shows the server URL string
- TEST: ServerErrorPage has a retry button
- TEST: Click retry → onRetry callback is called
- TEST: While retrying → retry button shows spinner and is disabled
- TEST: Error message has role="alert"

### ConfigErrorPage
- TEST: ConfigErrorPage renders → shows text containing "配置加载失败"
- TEST: ConfigErrorPage has a retry button
- TEST: Click retry → onRetry callback is called
- TEST: While retrying → retry button shows spinner and is disabled

### SessionExpiredDialog
- TEST: SessionExpiredDialog renders when visible=true → modal is visible with "会话已失效" message
- TEST: SessionExpiredDialog not rendered when visible=false
- TEST: Click "重新登录" button → onLogin callback called (navigates to LoginPage)
- TEST: Dialog has aria-modal="true"
- TEST: Dialog traps focus (Tab doesn't leave dialog)

## Fixtures Required
- Mock onRetry callbacks
- Mock onLogin callback
- Mock server URL string
