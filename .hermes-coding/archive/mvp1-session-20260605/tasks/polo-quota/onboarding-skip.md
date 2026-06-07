---
id: polo-quota.onboarding-skip
title: "Skip API Key onboarding in platform mode"
module: polo-quota
priority: 9
estimatedMinutes: 15
depends: ["polo-quota.platform-key"]
status: completed
spec_ref: "spec-polo-ai.md §8.1 (跳过 API Key 配置)"
startedAt: 2026-06-05T19:04:59.573Z
completedAt: 2026-06-05T19:09:54.036Z
---
# Skip API Key onboarding in platform mode


## Objective

Modify `getSetupNeeds()` and `getAuthState()` to detect platform mode (`PLATFORM_ANTHROPIC_API_KEY` set) and return fully-configured state, skipping the API Key setup step. Users go directly from login to workspace.

## Acceptance Criteria

### AC1: getSetupNeeds in platform mode
- TEST: When isPlatformMode() → getSetupNeeds returns `{ isFullyConfigured: true, needsBillingConfig: false, needsCredentials: false }`
- TEST: Regardless of whether local credentials exist

### AC2: getAuthState in platform mode
- TEST: When isPlatformMode() → getAuthState().billing.type returns 'api_key'
- TEST: getAuthState().billing.hasCredentials returns true
- TEST: This prevents UI from showing "configure billing" prompts anywhere

### AC3: Non-platform mode unchanged
- TEST: When !isPlatformMode() → getSetupNeeds and getAuthState behave exactly as before
- TEST: No code path changes for non-platform mode

### AC4: Onboarding handler
- TEST: Onboarding RPC handler in platform mode returns early with "configured" status
- TEST: No error when querying onboarding state in platform mode

## Boundary Matrix

| PLATFORM_KEY | Local key configured | getSetupNeeds result |
|-------------|---------------------|---------------------|
| set | any | isFullyConfigured: true |
| unset | yes | isFullyConfigured: true (original) |
| unset | no | isFullyConfigured: false (original) |

## Environment Context

- **Runtime**: Bun
- **File to modify**: `packages/shared/src/auth/state.ts` — `getSetupNeeds()` returns `{ needsBillingConfig, needsCredentials, isFullyConfigured, needsMigration }` based on AuthState; also `getAuthState()`
- **File to modify**: `packages/server-core/src/handlers/rpc/onboarding.ts` — handler simplification
- **Env vars**: `PLATFORM_ANTHROPIC_API_KEY`
- **Existing test**: Extend existing auth/state tests
- **Test runner**: `bun test`

## Implementation Notes

- Add early check in `getSetupNeeds()`:
  ```typescript
  if (isPlatformMode()) {
    return { isFullyConfigured: true, needsBillingConfig: false, needsCredentials: false, needsMigration: false };
  }
  ```
- Also update `getAuthState()` to return billing.type='api_key', billing.hasCredentials=true in platform mode
- Check onboarding.ts handler for any steps that reference API key setup
- Use shared helper `isPlatformMode()` (checks `!!process.env.PLATFORM_ANTHROPIC_API_KEY`) — define once, import everywhere
