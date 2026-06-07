---
id: e2e.llm-config
module: e2e
type: e2e
priority: 19
status: pending
estimatedMinutes: 25
dependencies: [llm.model-selector, llm.credential-store, llm.config-decrypt, auth.login-page, auth.startup-flow, cleanup.llm-write-rpcs]
---
# E2E Test: LLM Config Display and Switching

## Description
End-to-end Playwright tests verifying:
1. After login, model selector shows Admin-assigned connections and models
2. User can switch between connections and models
3. No add/edit/delete UI for connections
4. When no connections assigned, NoLlmConfigBanner is shown
5. Config update on restart (different configVersion triggers re-fetch)

## Server Setup
- Start command: `bun run server:dev` (or Electron dev mode)
- Ready signal: Server listening log message
- Required services: None (Admin API mocked)
- Teardown: Kill dev server, clear test storage

## Scenario Steps

### Scenario 1: LLM Config Display
1. Mock getLlmConnections to return 2 connections (Anthropic + OpenAI)
2. Login successfully
3. Navigate to model selector area
4. Assert: Connection dropdown shows "Anthropic (Claude)" and "OpenAI (GPT)"
5. Assert: Default connection is pre-selected
6. Screenshot: `llm-config-two-connections`

### Scenario 2: Model Switching
1. Login with 2 connections available
2. Select "Anthropic (Claude)" connection
3. Assert: Model dropdown shows "Claude Sonnet 4.6" and "Claude Haiku 4.5"
4. Select "Claude Haiku 4.5"
5. Screenshot: `llm-model-switched`
6. Switch to "OpenAI (GPT)" connection
7. Assert: Model dropdown updates to show "GPT-4o"
8. Screenshot: `llm-connection-switched`

### Scenario 3: No Config Available
1. Mock getLlmConnections to return empty connections array
2. Login successfully
3. Assert: NoLlmConfigBanner is displayed with "暂无可用的 LLM 配置"
4. Screenshot: `no-llm-config-banner`

### Scenario 4: Config Update on Restart
1. Login with configVersion "cv_001" and 1 connection
2. Close/reload app
3. Mock validate to return configVersion "cv_002"
4. Mock getLlmConnections to return 2 connections
5. Assert: Model selector now shows 2 connections (updated config)
6. Screenshot: `llm-config-updated`

## Screenshot Checkpoints
| Step | Checkpoint Name | What to Verify |
|------|----------------|---------------|
| Scenario 1, Step 4 | llm-config-two-connections | Two connections in dropdown |
| Scenario 2, Step 5 | llm-model-switched | Haiku model selected |
| Scenario 2, Step 8 | llm-connection-switched | OpenAI connection + GPT-4o model |
| Scenario 3, Step 3 | no-llm-config-banner | Banner with admin contact message |
| Scenario 4, Step 5 | llm-config-updated | Updated connections after restart |

## Browser Config
- Viewport: 1280x720 (desktop)
- Auth state: Login flow included in each scenario
- Test data: MSW handlers with configurable connection lists

## Acceptance Criteria
1. All 4 scenarios pass
2. Screenshots captured at each checkpoint
3. No "Add Connection" or "Edit" or "Delete" buttons visible
4. Model selector correctly reflects Admin-assigned config

## Test Cases (Red Phase)
- TEST: After login with 2 connections → connection dropdown shows both names (screenshot: llm-config-two-connections)
- TEST: Default connection from Admin config is pre-selected in dropdown
- TEST: Select different model → model dropdown value updates (screenshot: llm-model-switched)
- TEST: Switch connection → model dropdown shows new connection's models (screenshot: llm-connection-switched)
- TEST: Login with empty connections → NoLlmConfigBanner visible with "暂无可用的 LLM 配置" (screenshot: no-llm-config-banner)
- TEST: No "Add" / "Edit" / "Delete" / "Configure" buttons visible in model selector area
- TEST: Restart with different configVersion → new config reflected in model selector (screenshot: llm-config-updated)
- TEST: Partial decrypt failure (1 of 2 connections) → only 1 connection shown, no crash
- TEST: Decrypted API keys are NOT visible in page source, localStorage, or console logs
- TEST: After logout, no decrypted API keys remain in local storage / CredentialManager

## Fixtures Required
- MSW handlers for getLlmConnections with configurable responses
- Sample encrypted credentials with matching test JWT for decryption
- Playwright helpers for login + navigation to model selector
