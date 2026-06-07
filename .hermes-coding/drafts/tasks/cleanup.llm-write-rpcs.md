---
id: cleanup.llm-write-rpcs
module: cleanup
type: domain
priority: 14
status: pending
estimatedMinutes: 30
dependencies: [llm.model-selector, cleanup.ai-settings, cleanup.oauth]
---
# Remove LLM Connection Write RPCs

## Description
Remove ALL RPC handlers that allow users to create, update, delete, or test LLM connections. Per spec §5.2, only LIST and GET read operations should remain.

**Handlers to REMOVE from `packages/server-core/src/handlers/rpc/llm-connections.ts`:**
- `RPC_CHANNELS.llmConnections.SAVE` — create/update connection
- `RPC_CHANNELS.llmConnections.DELETE` — remove connection
- `RPC_CHANNELS.llmConnections.TEST` — test connection
- `RPC_CHANNELS.llmConnections.SET_DEFAULT` — set default connection
- `RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT` — set workspace default
- `RPC_CHANNELS.llmConnections.REFRESH_MODELS` — refresh model list
- `RPC_CHANNELS.llmConnections.GET_API_KEY` — retrieve raw API key (no longer needed with Admin-managed keys)
- `RPC_CHANNELS.settings.SETUP_LLM_CONNECTION` — setup flow
- `RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP` — test setup
- `RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS` — PI provider list for manual setup
- ChatGPT/Copilot OAuth flow handlers (if present in this file)

**Keep ONLY:**
- LIST handler (list all connections — reads Admin-sourced config from StoredConfig)
- GET handler (get single connection details)

**Also update:**
- Protocol constants/channel definitions — remove or deprecate unused channels
- UI call sites — remove any code calling removed RPCs
- Test files — remove tests for deleted handlers

## Environment Context
- Package manager: Bun
- Test strategy: Verify RPC calls to removed methods fail + build succeeds
- Key file: `packages/server-core/src/handlers/rpc/llm-connections.ts` (~650+ lines, most to be removed)

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| RPC: LIST connections | Read operation (keep) | Returns Admin-sourced connections |
| RPC: GET connection | Read operation (keep) | Returns single connection |
| RPC: SAVE connection | Write removed | Error: unknown/unsupported method |
| RPC: DELETE connection | Write removed | Error: unknown/unsupported method |
| RPC: SET_DEFAULT | Write removed | Error: unknown/unsupported method |
| RPC: SET_WORKSPACE_DEFAULT | Write removed | Error: unknown/unsupported method |
| RPC: TEST connection | Write removed | Error: unknown/unsupported method |
| RPC: REFRESH_MODELS | Write removed | Error: unknown/unsupported method |
| RPC: GET_API_KEY | Write removed | Error: unknown/unsupported method |
| RPC: SETUP_LLM_CONNECTION | Write removed | Error: unknown/unsupported method |
| RPC: TEST_LLM_CONNECTION_SETUP | Write removed | Error: unknown/unsupported method |

## Acceptance Criteria
1. Only LIST and GET RPC handlers remain registered
2. All write/test/setup handlers are removed from the handler registration
3. Protocol channel constants still exist (for backward compat error messages) but handlers are not registered
4. No UI code calls any removed RPC method
5. `bun run typecheck` passes after removal
6. Build succeeds after removal

## Test Cases (Red Phase)

### Kept RPCs
- TEST: RPC call LIST → returns connections from StoredConfig (Admin-sourced)
- TEST: RPC call GET with valid slug → returns single connection

### Removed RPCs (all should fail)
- TEST: RPC call SAVE → returns error (handler not found / method not supported)
- TEST: RPC call DELETE → returns error (handler not found / method not supported)
- TEST: RPC call SET_DEFAULT → returns error (handler not found / method not supported)
- TEST: RPC call SET_WORKSPACE_DEFAULT → returns error (handler not found / method not supported)
- TEST: RPC call TEST → returns error (handler not found / method not supported)
- TEST: RPC call REFRESH_MODELS → returns error (handler not found / method not supported)
- TEST: RPC call GET_API_KEY → returns error (handler not found / method not supported)
- TEST: RPC call SETUP_LLM_CONNECTION → returns error (handler not found / method not supported)
- TEST: RPC call TEST_LLM_CONNECTION_SETUP → returns error (handler not found / method not supported)

### Build Verification
- TEST: `bun run typecheck` passes after removal → no broken imports/types
- TEST: No UI code references SAVE/DELETE/SET_DEFAULT/TEST/REFRESH_MODELS/GET_API_KEY/SETUP RPC methods
- TEST: `grep -r "SETUP_LLM_CONNECTION\|TEST_LLM_CONNECTION_SETUP\|GET_API_KEY_PROVIDERS" apps/electron/src/renderer/` returns no results

## Fixtures Required
- Mock RPC dispatcher
- Sample StoredConfig with Admin-sourced connections
