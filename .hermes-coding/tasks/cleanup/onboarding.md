---
id: cleanup.onboarding
module: cleanup
type: domain
priority: 10
status: pending
estimatedMinutes: 25
dependencies: [auth.login-page, auth.startup-flow, llm.model-selector]
---
# Remove Onboarding Wizard

## Description
Remove the entire Onboarding wizard flow that guided users through LLM provider selection and credential setup. This is no longer needed since LLM config is Admin-managed.

Files to remove:
- `apps/electron/src/renderer/components/onboarding/` (entire directory)
- `apps/electron/src/main/onboarding.ts`
- `packages/server-core/src/handlers/rpc/onboarding.ts`

Files to modify:
- `apps/electron/src/renderer/main.tsx` or `App.tsx` — remove onboarding imports and route
- `apps/electron/src/renderer/hooks/useOnboarding.ts` — remove hook
- `apps/electron/src/renderer/playground/registry/chat.tsx` — remove SetupAuthBanner reference
- Remove onboarding RPC handler registrations from server-core
- Remove SetupAuthBanner: `apps/electron/src/renderer/components/app-shell/SetupAuthBanner.tsx`

Note: Local model removal (Ollama etc.) is handled in separate task `cleanup.local-models`.

## Environment Context
- Package manager: Bun
- Test strategy: Verify build succeeds + no dead imports
- Key concern: Ensure no runtime references to removed code remain

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| App startup (first time) | No onboarding exists | Goes to LoginPage, not onboarding |
| Import of onboarding module | Dead code | Build error if any import remains |
| RPC call to onboarding handler | Removed handler | RPC returns "unknown handler" or similar |

## Acceptance Criteria
1. Onboarding directory fully deleted
2. Onboarding main process file deleted
3. Onboarding RPC handler deleted
4. SetupAuthBanner component deleted
5. All imports/references to removed files are cleaned up
6. Application builds without errors after removal
7. No route or navigation path leads to onboarding

## Test Cases (Red Phase)
- TEST: `bun run typecheck` passes after removal → no broken imports
- TEST: App startup with no cached token → shows LoginPage, NOT onboarding wizard
- TEST: No component in the rendered tree matches "onboarding" or "OnboardingWizard"
- TEST: No RPC handler registered for onboarding-related methods
- TEST: SetupAuthBanner is not rendered in app shell
- TEST: `grep -r "onboarding" apps/electron/src/` returns no results (except test files)
- TEST: `grep -r "SetupAuthBanner" apps/electron/src/` returns no results
- TEST: `grep -r "useOnboarding" apps/electron/src/` returns no results
- TEST: `apps/electron/src/renderer/playground/registry/chat.tsx` does not import SetupAuthBanner

## Fixtures Required
- None (deletion task)
