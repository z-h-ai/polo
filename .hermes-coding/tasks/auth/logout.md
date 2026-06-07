---
id: auth.logout
module: auth
type: domain
priority: 5
status: pending
estimatedMinutes: 20
dependencies: [auth.admin-api-client, auth.login-page]
---
# Logout Functionality

## Description
Implement the user-initiated logout flow:
1. Call `POST /api/auth/logout` (best-effort — proceed even if it fails)
2. Clear JWT, user info, LLM config cache, decrypted API keys from CredentialManager
3. Redirect to LoginPage

Also add a "Logout" button in the settings menu / sidebar.

## Environment Context
- Runtime: Node.js + Browser + Electron
- Package manager: Bun
- Test strategy: Mock AdminApiClient
- Key files:
  - Modify: Settings menu component, sidebar component
  - Uses: AdminApiClient.logout(), token cache, CredentialManager

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| Logout clicked, API succeeds | Normal logout | All cache cleared, route to LoginPage |
| Logout clicked, API fails (network) | Admin unreachable | Still clear local cache, route to LoginPage |
| Logout clicked, API returns 401 | Token already revoked | Still clear local cache, route to LoginPage |

## Acceptance Criteria
1. Clicking "Logout" calls AdminApiClient.logout()
2. Regardless of API response, local cache is fully cleared
3. After clearing, user is redirected to LoginPage
4. Cleared data includes: JWT, user info, LLM config, configVersion, CredentialManager `llm_api_key::*` entries
5. Logout button is visible in settings menu

## Test Cases (Red Phase)

### Normal Logout
- TEST: Click logout → AdminApiClient.logout() is called
- TEST: After logout() succeeds → JWT cache returns null
- TEST: After logout() succeeds → user info cache returns null
- TEST: After logout() succeeds → LLM config cache is empty
- TEST: After logout() succeeds → CredentialManager entries with `llm_api_key` prefix are deleted
- TEST: After logout() succeeds → router navigates to LoginPage

### Logout with API Failure
- TEST: logout() throws NetworkError → local cache is still fully cleared
- TEST: logout() throws NetworkError → router still navigates to LoginPage
- TEST: logout() returns 401 → local cache is still fully cleared, route to LoginPage

### UI
- TEST: Settings menu contains a "Logout" / "登出" button
- TEST: Logout button click triggers the logout flow (not just API call)
- TEST: After logout, using old JWT for any Admin API call returns 401 (token invalidated server-side)

## Fixtures Required
- Mock AdminApiClient.logout()
- Mock token/config cache
- Mock CredentialManager
- Mock router
