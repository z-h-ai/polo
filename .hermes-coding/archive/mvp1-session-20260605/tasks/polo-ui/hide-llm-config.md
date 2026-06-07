---
id: polo-ui.hide-llm-config
title: "Hide LLM connection config UI in platform mode"
module: polo-ui
priority: 15
estimatedMinutes: 15
depends: ["polo-auth.api-config"]
status: completed
spec_ref: "spec-polo-ai.md §8.3 (隐藏 LLM 连接配置 UI)"
startedAt: 2026-06-05T20:07:36.416Z
completedAt: 2026-06-05T20:23:35.621Z
---
# Hide LLM connection config UI in platform mode


## Objective

In platform mode, hide the LLM connection management UI (API key settings, model provider config, OAuth connection pages) from WebUI users. Platform mode is detected via the `platformMode` flag from `GET /api/public-config`.

## Acceptance Criteria

### AC1: Hidden UI elements in platform mode
- TEST: Navigation menu hides "LLM Connections" / "API Keys" entry
- TEST: Settings page hides connection configuration section
- TEST: Connection picker / model selector is hidden or shows "Platform (Claude)" only
- TEST: Onboarding flow skips API Key / OAuth configuration step
- TEST: OAuth callback route is not accessible (or returns error) in platform mode
- TEST: Quick command palette hides connection-related commands

### AC2: Non-platform mode — unchanged
- TEST: When `platformMode=false`, LLM configuration UI is fully visible and functional
- TEST: All existing LLM connection features work as before

### AC3: Platform mode detection
- TEST: WebUI reads `platformMode` from GET /api/public-config response
- TEST: platformMode flag is propagated through React context or global state
- TEST: Components conditionally render based on this flag

## State Matrix

| platformMode | LLM Config Nav Item | LLM Config Page | Model Provider Settings |
|---|---|---|---|
| true | hidden | not rendered / redirect | hidden |
| false | visible | accessible | visible |
| loading (before /api/public-config) | hidden (safe default) | not rendered | hidden |
| /api/public-config error | hidden (safe default) | not rendered | hidden |

## Environment Context

- **Runtime**: Bun + Vite
- **Framework**: React + Tailwind CSS
- **Files to modify**: WebUI components that render LLM connection config (find in `apps/webui/`)
- **Data source**: `GET /api/public-config` → `{ platformMode }` (T015)
- **WebUI architecture**: Independent React app that reuses Electron renderer transport (Jotai atoms, CHANNEL_MAP, buildClientApi). Changes to shared UI go in packages/ui/ or packages/shared/; WebUI-specific changes in apps/webui/.
- **Test**: Playwright screenshot or component test
- **Dev command**: `bun run webui:dev`

## Implementation Notes

- Find the LLM connection config components in `apps/webui/`
- Add conditional rendering: `if (platformMode) return null`
- Propagate platformMode through React context (or Jotai atom since project uses Jotai)
- Safe default: hide when platformMode is unknown (loading/error state)
- Use shared helper `isPlatformMode()` (checks `!!process.env.PLATFORM_ANTHROPIC_API_KEY`) — define once, import everywhere
