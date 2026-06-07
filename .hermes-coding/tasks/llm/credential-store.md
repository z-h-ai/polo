---
id: llm.credential-store
module: llm
type: domain
priority: 8
status: completed
estimatedMinutes: 30
dependencies: [llm.config-decrypt]
startedAt: 2026-06-07T09:30:07.783Z
completedAt: 2026-06-07T09:41:22.379Z
---
# Write Decrypted Keys to CredentialManager + StoredConfig

## Description
After LLM connections are fetched and decrypted, write the results to local storage:
1. Write each decrypted API key to `CredentialManager` using typed `CredentialId` with type `llm_api_key` and `connectionSlug` (stored as `llm_api_key::{slug}` via `credentialIdToAccount`)
2. Map Admin API connection format to existing `LlmConnection` type and write to `StoredConfig.llmConnections`
3. Set `StoredConfig.defaultLlmConnection` from the response's `defaultConnection`
4. Cache `configVersion` for startup comparison
5. Implement cleanup: on logout/force-logout, delete all `llm_api_key` type entries from CredentialManager
6. Implement atomic rollback: if any write step fails, clear all partial data written in this batch

## Environment Context
- Runtime: Node.js + Electron
- Package manager: Bun
- Test strategy: Mock CredentialManager and StoredConfig
- Key files:
  - Use: `packages/shared/src/credentials/manager.ts` (the generic CredentialManager)
  - Use: `packages/shared/src/credentials/types.ts` (CredentialId, credentialIdToAccount)
  - Modify: `packages/shared/src/config/llm-connections.ts` (mapping logic)

## Boundary Matrix
| Input | Condition | Expected Output |
|-------|-----------|----------------|
| 2 decrypted connections | Normal | 2 entries in CredentialManager (typed), 2 in StoredConfig |
| 0 connections (empty) | No config assigned | CredentialManager untouched, StoredConfig.llmConnections = [] |
| Connection with piAuthProvider | PI provider type | piAuthProvider mapped to LlmConnection |
| Connection with authType=bearer_token | Non-api_key auth | Credential stored with correct type |
| Connection with authType=environment | Env-based auth | No credential to store, connection still mapped |
| Cleanup called | Logout | All `llm_api_key` CredentialId entries deleted |
| Write fails mid-batch | Partial write | All partial data rolled back |
| Connection with baseUrl | Custom endpoint | baseUrl mapped to LlmConnection |
| Overwrite existing config | Re-login / config refresh | Old entries replaced, not duplicated |

## Input/Output Types
```typescript
// Input: Admin API connection (after decryption)
interface DecryptedConnection {
  slug: string;
  name: string;
  providerType: 'anthropic' | 'pi' | 'pi_compat';
  authType: 'api_key' | 'api_key_with_endpoint' | 'bearer_token' | 'iam_credentials' | 'service_account_file' | 'environment';
  models: { id: string; name: string; tier?: 'fast' | 'standard' | 'premium' }[];
  defaultModel: string;
  apiKey: string;  // decrypted (may be empty for environment authType)
  baseUrl?: string;
  piAuthProvider?: string;
  midStreamBehavior?: 'steer' | 'queue';
}

// CredentialId (from packages/shared/src/credentials/types.ts)
interface CredentialId {
  type: 'llm_api_key';
  connectionSlug: string;
}
// stored as account string: "llm_api_key::{connectionSlug}"
```

## Acceptance Criteria
1. Each decrypted API key is stored in CredentialManager using typed `CredentialId { type: 'llm_api_key', connectionSlug: slug }`
2. Admin connections are mapped to existing `LlmConnection` type with `modelSelectionMode: 'userDefined3Tier'`
3. `StoredConfig.defaultLlmConnection` is set from response's `defaultConnection`
4. `configVersion` is cached locally for startup comparison
5. Cleanup function deletes all `llm_api_key` type entries from CredentialManager
6. Empty connections array results in empty StoredConfig.llmConnections (overwrites any existing)
7. All supported `authType` variants are handled in mapping
8. Atomic rollback on failure: if CredentialManager write fails mid-batch, previously written entries are cleaned up

## Test Cases (Red Phase)

### Write to CredentialManager (typed CredentialId)
- TEST: storeConnections([{ slug: "anthropic-api", apiKey: "sk-ant-123" }]) → CredentialManager.set({ type: "llm_api_key", connectionSlug: "anthropic-api" }, "sk-ant-123") called
- TEST: storeConnections([conn1, conn2]) → CredentialManager.set called twice with correct typed CredentialIds
- TEST: storeConnections([]) → CredentialManager.set not called, StoredConfig.llmConnections = []
- TEST: storeConnections with authType="environment" → CredentialManager.set NOT called for that connection (no key to store)

### Write to StoredConfig
- TEST: storeConnections([anthropicConn]) → StoredConfig.llmConnections contains 1 LlmConnection with correct slug, name, providerType, models
- TEST: Mapped LlmConnection has modelSelectionMode="userDefined3Tier"
- TEST: storeConnections with defaultConnection="anthropic-api" → StoredConfig.defaultLlmConnection = "anthropic-api"
- TEST: Connection with piAuthProvider="openai" → mapped LlmConnection.piAuthProvider = "openai"
- TEST: Connection with baseUrl="https://custom.api" → mapped LlmConnection.baseUrl = "https://custom.api"
- TEST: Connection with midStreamBehavior="steer" → mapped LlmConnection.midStreamBehavior = "steer"

### AuthType Variants
- TEST: Connection with authType="api_key" → credential stored, LlmConnection.authType = "api_key"
- TEST: Connection with authType="bearer_token" → credential stored, LlmConnection.authType = "bearer_token"
- TEST: Connection with authType="api_key_with_endpoint" → credential stored, baseUrl mapped

### ConfigVersion Cache
- TEST: storeConnections with configVersion="cv_001" → cached configVersion = "cv_001"
- TEST: getCachedConfigVersion() returns the last stored configVersion

### Overwrite Behavior
- TEST: storeConnections called twice → second call overwrites first (no duplicate entries)
- TEST: storeConnections with fewer connections than before → old extra entries removed from CredentialManager

### Cleanup
- TEST: cleanupLlmCredentials() → CredentialManager deletes all entries with type `llm_api_key`
- TEST: cleanupLlmCredentials() when no `llm_api_key` entries exist → no error
- TEST: After cleanup, StoredConfig.llmConnections = []
- TEST: After cleanup, cached configVersion = null

### Atomic Rollback
- TEST: If CredentialManager.set fails on 2nd of 3 connections → 1st connection's credential is rolled back (deleted)
- TEST: If StoredConfig write fails → CredentialManager entries written in this batch are rolled back

## Fixtures Required
- Mock CredentialManager (get/set/delete/list) using typed CredentialId
- Mock StoredConfig
- Sample DecryptedConnection objects for each authType variant
