---
id: electron.startup
module: electron
type: domain
priority: 16
status: pending
estimatedMinutes: 25
dependencies: [electron.auth, llm.credential-store, auth.error-pages, auth.login-page]
---
# Electron Startup Flow Modification

## Description
Modify the Electron app startup sequence to:
1. Main process reads cached JWT from safeStorage
2. If no JWT → renderer shows LoginPage
3. If JWT exists → main process calls validateToken() (10s timeout)
4. If valid + same configVersion → use cached config → start local WS RPC server → enter app
5. If valid + different configVersion → re-fetch + decrypt LLM config → start local WS RPC server → enter app
6. If 401 → clear cache → renderer shows LoginPage
7. If network error → renderer shows ServerErrorPage

Key change: the local WS RPC server now starts AFTER auth succeeds (not before).

## Environment Context
- Runtime: Electron main process
- Package manager: Bun
- Test strategy: Mock AdminApiClient, safeStorage, local server
- Key file: `apps/electron/src/main/index.ts`

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| No cached JWT | First launch | Renderer shows LoginPage |
| Valid JWT + same configVersion | Normal restart | Local server starts, app enters main view |
| Valid JWT + different configVersion | Config changed | Config re-fetched, local server starts |
| Revoked JWT | Admin revoked | Cache cleared, LoginPage shown |
| Network error | Admin unreachable | ServerErrorPage with retry |
| Login success on LoginPage | User logs in | Config fetched, local server starts, enter app |

## Acceptance Criteria
1. Local WS RPC server does NOT start until auth succeeds
2. Startup sequence: read JWT → validate → fetch config (if needed) → start server → show app
3. LoginPage is shown before server starts (if no valid token)
4. ServerErrorPage has retry button that re-attempts validation
5. After successful login from LoginPage, config is fetched and server starts

## Test Cases (Red Phase)

### Startup Order
- TEST: On startup with valid cached JWT → validateToken() called before local server starts
- TEST: On startup with valid JWT + same configVersion → local server starts without re-fetching config
- TEST: On startup with valid JWT + different configVersion → getLlmConnections() called before server starts
- TEST: Local WS RPC server start is NOT called before auth completes

### No Token
- TEST: Startup with no cached JWT → renderer receives instruction to show LoginPage
- TEST: Startup with no cached JWT → local server is NOT started

### Auth Failure
- TEST: Startup with revoked JWT → safeStorage cleared, LoginPage shown
- TEST: Startup with network error → ServerErrorPage shown with retry button

### Post-Login
- TEST: After successful login on LoginPage → LLM config fetched and decrypted
- TEST: After successful login → local WS RPC server starts
- TEST: After successful login → renderer transitions to main app view

### Retry
- TEST: ServerErrorPage retry button → re-attempts validateToken()
- TEST: Retry after network recovery → proceeds normally (validate → config → server → app)

### 5xx and Edge Cases
- TEST: Startup with valid JWT + validate returns 5xx → ServerErrorPage shown
- TEST: Startup with valid JWT + same configVersion but cached config is corrupt/missing → re-fetches config
- TEST: Startup with valid JWT + different configVersion + config fetch fails → ConfigErrorPage shown

## Fixtures Required
- Mock Electron main process startup
- Mock safeStorage
- Mock AdminApiClient (validate, getLlmConnections)
- Mock local WS RPC server start function
