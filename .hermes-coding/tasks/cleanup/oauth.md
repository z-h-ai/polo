---
id: cleanup.oauth
module: cleanup
type: domain
priority: 12
status: pending
estimatedMinutes: 25
dependencies: [cleanup.onboarding, cleanup.ai-settings]
---
# Remove OAuth Flow Code

## Description
Remove all client-side OAuth flow code from `packages/shared/src/auth/`. This includes OAuth implementations for Claude, ChatGPT, Google, Microsoft, Slack, and generic providers, along with supporting infrastructure (PKCE, callback server, flow store, relay).

Files to remove:
- `packages/shared/src/auth/claude-oauth.ts`
- `packages/shared/src/auth/claude-oauth-config.ts`
- `packages/shared/src/auth/chatgpt-oauth.ts`
- `packages/shared/src/auth/chatgpt-oauth-config.ts`
- `packages/shared/src/auth/google-oauth.ts`
- `packages/shared/src/auth/microsoft-oauth.ts`
- `packages/shared/src/auth/slack-oauth.ts`
- `packages/shared/src/auth/generic-oauth.ts`
- `packages/shared/src/auth/oauth.ts`
- `packages/shared/src/auth/oauth-relay.ts`
- `packages/shared/src/auth/oauth-flow-store.ts`
- `packages/shared/src/auth/oauth-flow-types.ts`
- `packages/shared/src/auth/callback-page.ts`
- `packages/shared/src/auth/callback-server.ts`
- `packages/shared/src/auth/pkce.ts`
- `packages/server-core/src/handlers/rpc/oauth.ts`
- `packages/server-core/src/webui/__tests__/oauth-callback.test.ts`

Files to modify:
- `packages/shared/src/auth/index.ts` — remove OAuth re-exports
- RPC handler index — remove OAuth handler registration
- `packages/server-core/src/webui/http-server.ts` — remove `/api/oauth/callback` route + `generateCallbackPage` import
- `packages/server/src/index.ts` — remove OAuth-related bootstrap references
- `packages/server-core/src/handlers/oauth-flow-store-interface.ts` — remove

## Environment Context
- Package manager: Bun
- Test strategy: Verify build + no dead imports
- Key concern: 17+ files to remove, must trace all import chains

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| Import of any OAuth module | Dead code | Build error if any remains |
| OAuth RPC call | Handler removed | Not registered |
| OAuth callback URL hit | Code removed | No handler (404) |

## Acceptance Criteria
1. All listed OAuth files are deleted
2. OAuth RPC handler is deregistered
3. `packages/shared/src/auth/index.ts` no longer exports OAuth symbols
4. No remaining imports reference deleted files
5. Build succeeds after removal
6. OAuth callback test file removed

## Test Cases (Red Phase)
- TEST: `bun run typecheck` passes after removal → no broken imports
- TEST: `grep -r "oauth" packages/shared/src/auth/` returns only admin-auth.ts references (if any), not old OAuth flow files
- TEST: `grep -r "oauth" packages/server-core/src/handlers/rpc/` returns no results
- TEST: `packages/shared/src/auth/index.ts` does not export `startOAuthFlow`, `OAuthProvider`, or similar symbols
- TEST: No RPC handler registered for OAuth-related methods
- TEST: Build artifact does not contain OAuth callback HTML
- TEST: `grep -r "generateCallbackPage" packages/server-core/` returns no results
- TEST: `grep -r "/api/oauth/callback" packages/server-core/` returns no results
- TEST: `packages/server-core/src/handlers/oauth-flow-store-interface.ts` does not exist

## Fixtures Required
- None (deletion task)
