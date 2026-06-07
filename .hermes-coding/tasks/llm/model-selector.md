---
id: llm.model-selector
module: llm
type: ui
priority: 9
status: completed
estimatedMinutes: 20
dependencies: [llm.credential-store]
startedAt: 2026-06-07T10:15:05.931Z
completedAt: 2026-06-07T10:43:05.398Z
---
# Model Selector Reads from Admin Config (Read-Only)

## Description
Modify the existing model selector UI to read from Admin-sourced LLM config in StoredConfig rather than locally-configured connections. The selector:
- Shows available connections from Admin config
- Allows switching between connections and models
- Does NOT allow adding, removing, or editing connections
- Shows a `NoLlmConfigBanner` when no connections are assigned

## Environment Context
- UI framework: React (TypeScript)
- Package manager: Bun
- Test strategy: Component tests with mock StoredConfig
- Key files:
  - Modify: Existing model selector component
  - Create: `apps/electron/src/renderer/components/NoLlmConfigBanner.tsx`

## State Matrix
| State | Condition | Renders |
|-------|-----------|---------|
| Normal | 1+ connections available | Connection dropdown + model dropdown |
| No Config | 0 connections | NoLlmConfigBanner: "暂无可用的 LLM 配置，请联系管理员" |
| Single Connection | Exactly 1 connection | Model dropdown only (connection pre-selected) |
| Multi Connection | 2+ connections | Connection dropdown + model dropdown |

## Accessibility
- Keyboard navigation: Tab to connection selector, arrow keys to select, Tab to model selector
- Screen reader: Dropdowns have aria-label, NoLlmConfigBanner has role="status"

## Acceptance Criteria
1. Model selector reads from StoredConfig.llmConnections (Admin-sourced)
2. User can switch between assigned connections
3. User can switch between models within a connection
4. No "Add", "Edit", "Delete" buttons for connections
5. When connections array is empty, shows NoLlmConfigBanner
6. Default connection/model is pre-selected from Admin config

## Test Cases (Red Phase)

### Normal Display
- TEST: StoredConfig has 2 connections → connection dropdown shows 2 options
- TEST: StoredConfig has connection with 3 models → model dropdown shows 3 options
- TEST: Default connection "anthropic-api" → that connection is pre-selected
- TEST: Connection "anthropic-api" has defaultModel "claude-sonnet-4-6" → that model is pre-selected

### Switching
- TEST: Select different connection → model dropdown updates to show that connection's models
- TEST: Select different model within connection → selection is saved

### No Config
- TEST: StoredConfig.llmConnections = [] → NoLlmConfigBanner is displayed
- TEST: NoLlmConfigBanner shows text "暂无可用的 LLM 配置，请联系管理员"
- TEST: NoLlmConfigBanner has role="status" for screen readers

### Read-Only Enforcement
- TEST: No "Add Connection" button rendered
- TEST: No "Edit" or "Delete" buttons on any connection
- TEST: No "Configure API Key" or similar self-service UI elements

### Single Connection
- TEST: StoredConfig has exactly 1 connection → model dropdown visible, connection selector hidden or shows single option

## Fixtures Required
- Mock StoredConfig with 0/1/2+ connections
- Sample LlmConnection objects with various models
