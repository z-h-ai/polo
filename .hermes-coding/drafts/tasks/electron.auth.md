---
id: electron.auth
module: electron
type: domain
priority: 15
status: pending
estimatedMinutes: 30
dependencies: [auth.admin-api-client, auth.startup-flow, auth.global-401, llm.config-decrypt, llm.credential-store]
---
# Electron Main Process Auth + safeStorage + IPC

## Description
Implement Electron-specific authentication in the main process:
1. Store JWT using Electron's `safeStorage` API (encrypted at rest by OS)
2. Expose IPC channels for renderer: `login(username, password)`, `logout()`, `getAuthState()`
3. Main process handles all Admin API calls (avoid CORS in renderer)
4. Renderer NEVER sees raw JWT — only auth state (logged in/out, user info)
5. Include device info (`os.platform()` + `os.hostname()`) in login requests

Create `apps/electron/src/main/admin-auth.ts`.

## Environment Context
- Runtime: Electron main process (Node.js)
- Package manager: Bun
- Test strategy: Unit test with mocked Electron APIs (safeStorage, ipcMain)
- Key files:
  - Create: `apps/electron/src/main/admin-auth.ts`
  - Modify: `apps/electron/src/main/index.ts` (add auth check to startup)
  - Modify: `apps/electron/src/preload/bootstrap.ts` (expose IPC channels)

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| safeStorage.encryptString(jwt) | JWT stored securely | Encrypted buffer on disk |
| safeStorage.decryptString(buffer) | JWT retrieved | Original JWT string |
| safeStorage not available | Rare platform issue | Fall back to in-memory only, log warning |
| IPC login(user, pass) | From renderer | Main process calls AdminApiClient.login(), stores JWT, returns user info |
| IPC logout() | From renderer | Main process calls AdminApiClient.logout(), clears safeStorage |
| IPC getAuthState() | From renderer | Returns { isAuthenticated, user } (NO jwt) |

## Input/Output Types
```typescript
// IPC Channel contracts
interface ElectronAuthIPC {
  'auth:login': (username: string, password: string) => Promise<{ user: User }>;
  'auth:logout': () => Promise<void>;
  'auth:get-state': () => Promise<{ isAuthenticated: boolean; user: User | null }>;
  'auth:session-expired': () => void;  // main → renderer event
}
```

## Acceptance Criteria
1. JWT is stored in safeStorage, NOT localStorage or plain file
2. IPC `auth:login` calls AdminApiClient.login(), stores JWT in safeStorage, returns user info (no JWT)
3. IPC `auth:logout` calls AdminApiClient.logout(), clears safeStorage, clears config cache
4. IPC `auth:get-state` returns authentication state without exposing JWT
5. Main process emits `auth:session-expired` to renderer on force-logout (401 interception)
6. Login request includes device info: `os.platform()` + `os.hostname()`
7. If safeStorage is unavailable, JWT stored in-memory only (not persisted)

## Test Cases (Red Phase)

### safeStorage
- TEST: After login, safeStorage.encryptString() is called with the JWT
- TEST: On startup, safeStorage.decryptString() is called to retrieve cached JWT
- TEST: After logout, safeStorage encrypted data is cleared
- TEST: If safeStorage.isEncryptionAvailable() returns false → JWT stored in memory only, warning logged

### IPC: login
- TEST: IPC `auth:login("zhangsan", "pass")` → calls AdminApiClient.login("zhangsan", "pass") with deviceInfo
- TEST: IPC `auth:login` success → returns `{ user: { id, username, displayName, role } }` (no token field)
- TEST: IPC `auth:login` with wrong password → rejects with `{ error: "invalid_credentials" }`
- TEST: IPC `auth:login` with disabled account → rejects with `{ error: "account_disabled" }`

### IPC: logout
- TEST: IPC `auth:logout` → calls AdminApiClient.logout() + clears safeStorage + clears config
- TEST: IPC `auth:logout` when API fails → still clears local storage

### IPC: getAuthState
- TEST: IPC `auth:get-state` when logged in → returns `{ isAuthenticated: true, user: {...} }`
- TEST: IPC `auth:get-state` when not logged in → returns `{ isAuthenticated: false, user: null }`
- TEST: Response from `auth:get-state` does NOT contain jwt/token field

### Session Expired
- TEST: When 401 interceptor fires in main process → renderer receives `auth:session-expired` event
- TEST: Multiple concurrent 401s → only one `auth:session-expired` event emitted

### Device Info
- TEST: Login request body includes `deviceInfo` field with platform and hostname

### Post-Login Config Bootstrap
- TEST: After successful IPC `auth:login` → main process fetches + decrypts LLM config before returning success
- TEST: After IPC `auth:login` → CredentialManager has `llm_api_key::*` entries from decrypted config
- TEST: IPC `auth:login` where config fetch fails → returns error, JWT is cleared (atomic transaction)

## Fixtures Required
- Mock Electron safeStorage API
- Mock ipcMain/ipcRenderer
- Mock AdminApiClient
- Mock os.platform(), os.hostname()
