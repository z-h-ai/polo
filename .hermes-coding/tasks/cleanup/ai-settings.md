---
id: cleanup.ai-settings
module: cleanup
type: domain
priority: 11
status: pending
estimatedMinutes: 20
dependencies: [cleanup.onboarding]
---
# Remove AI Settings Page

## Description
Remove the AI Settings page where users could manually configure LLM providers, enter API keys, and manage OAuth connections. Also remove the `apisetup/` component directory.

Files to remove:
- `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx`
- `apps/electron/src/renderer/components/apisetup/` (entire directory: ApiKeyInput, OAuthConnect, etc.)

Files to modify:
- Settings navigation: remove AI Settings menu item/route
- Settings router: remove route to AiSettingsPage

## Environment Context
- Package manager: Bun
- Test strategy: Verify build + no dead imports
- Key concern: Settings page still exists for other settings, only AI Settings tab/page is removed
- Depends on cleanup.onboarding because OnboardingWizard and CredentialsStep import from apisetup/ — removing apisetup/ before onboarding would break the build

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| Navigate to settings | AI Settings removed | No "AI Settings" or "LLM Settings" menu item |
| Direct URL to AI Settings route | Route removed | 404 or redirect to valid settings page |

## Acceptance Criteria
1. AiSettingsPage component deleted
2. apisetup directory fully deleted
3. Settings navigation no longer shows AI Settings option
4. Settings route for AI Settings removed
5. All imports to removed files cleaned up
6. Build succeeds after removal

## Test Cases (Red Phase)
- TEST: `bun run typecheck` passes after removal → no broken imports
- TEST: Settings page renders without "AI Settings" / "LLM 设置" menu item
- TEST: No component in rendered settings matches "ApiKeyInput" or "OAuthConnect"
- TEST: `grep -r "AiSettingsPage" apps/electron/src/` returns no results
- TEST: `grep -r "apisetup" apps/electron/src/` returns no results (except test files)
- TEST: Navigate to settings → other settings pages still work normally

## Fixtures Required
- None (deletion task)
