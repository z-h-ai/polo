---
id: polo-quota.platform-key
title: "Modify resolveAuthEnvVars() for platform API Key"
module: polo-quota
priority: 8
estimatedMinutes: 15
depends: []
status: pending
spec_ref: "spec-polo-ai.md §7 (API Key 注入改造)"
---
# Modify resolveAuthEnvVars() for platform API Key


## Objective

Modify `resolveAuthEnvVars()` so that when `PLATFORM_ANTHROPIC_API_KEY` is set, it uses that value directly as the Anthropic API key, bypassing the local credential store entirely. MVP-1 platform mode forces Anthropic-only via PLATFORM_ANTHROPIC_API_KEY. All other providers/connections (Pi, OpenAI Codex, user-configured connections) are ignored in platform mode. The resolveAuthEnvVars function only applies to Anthropic SDK providers — non-Anthropic providers already return early with `{ envVars: {}, success: true }`.

## Acceptance Criteria

### AC1: Platform mode — use platform key
- TEST: With `PLATFORM_ANTHROPIC_API_KEY=sk-ant-xxx`, `resolveAuthEnvVars()` sets `process.env.ANTHROPIC_API_KEY` to `sk-ant-xxx`
- TEST: Local credential manager (`getLlmApiKey`) is NOT called
- TEST: Function returns immediately after setting the env var

### AC2: Non-platform mode — original flow
- TEST: Without `PLATFORM_ANTHROPIC_API_KEY`, `resolveAuthEnvVars()` runs the original credential resolution logic
- TEST: Existing tests for local credential resolution continue to pass

### AC3: Platform mode ignores other providers
- TEST: In platform mode, resolveAuthEnvVars for Anthropic connection → uses PLATFORM_ANTHROPIC_API_KEY
- TEST: In platform mode, resolveAuthEnvVars for non-Anthropic connection → returns early (existing behavior)
- TEST: Connection resolver in platform mode always selects the platform Anthropic connection, ignoring user connections
- TEST: Use shared `isPlatformMode()` helper (checks `!!process.env.PLATFORM_ANTHROPIC_API_KEY`)

### AC4: Key not exposed
- TEST: `PLATFORM_ANTHROPIC_API_KEY` value is not logged (no console.log / logger call with key)
- TEST: Key is not included in any API response or WebSocket message
- TEST: Key is not returned by any function (only set on `process.env`)

## Boundary Matrix

| PLATFORM_ANTHROPIC_API_KEY | ANTHROPIC_API_KEY (existing) | Result |
|---------------------------|------------------------------|--------|
| set ("sk-ant-xxx") | any | process.env.ANTHROPIC_API_KEY = "sk-ant-xxx" |
| unset | set ("sk-local") | original flow, key = "sk-local" |
| unset | unset | original flow, credential manager queried |
| empty string ("") | any | treated as unset, original flow |

## Environment Context

- **Runtime**: Bun
- **File to modify**: `packages/shared/src/config/llm-connections.ts`
- **Function**: `resolveAuthEnvVars()` — takes `(connection, connectionSlug, credentialManager, getValidOAuthToken)`, only applies to Anthropic SDK providers
- **Env vars**: `PLATFORM_ANTHROPIC_API_KEY`
- **Existing test**: `packages/shared/src/config/__tests__/llm-connections.test.ts` (extend)
- **Test runner**: `bun test`

## Implementation Notes

- Add early-return guard at the top of `resolveAuthEnvVars()`:
  ```typescript
  const platformKey = process.env.PLATFORM_ANTHROPIC_API_KEY;
  if (platformKey) {
    process.env.ANTHROPIC_API_KEY = platformKey;
    return;
  }
  ```
- Tiny change, high impact — unlocks platform mode for all LLM calls
- Use shared helper `isPlatformMode()` (checks `!!process.env.PLATFORM_ANTHROPIC_API_KEY`) — define once, import everywhere
