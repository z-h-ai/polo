# Data Models

## Source
- Extracted from: spec §6 (数据模型)
- Timestamp: 2026-06-06

## User
```typescript
interface User {
  id: string;           // e.g. "usr_abc123"
  username: string;     // unique login identifier
  displayName: string;
  role: 'admin' | 'user';
  groupIds: string[];
}
```

## UserGroup
```typescript
interface UserGroup {
  id: string;           // e.g. "grp_dev_team"
  name: string;
  slug: string;         // URL-safe identifier
  userIds: string[];
}
```

## AdminLlmConnectionConfig (Admin-side)
```typescript
interface AdminLlmConnectionConfig {
  slug: string;
  name: string;
  providerType: 'anthropic' | 'pi' | 'pi_compat';
  authType: 'api_key' | 'api_key_with_endpoint' | 'bearer_token' | 'iam_credentials' | 'service_account_file' | 'environment';
  apiKey: string;                // plaintext (Admin storage only)
  baseUrl?: string;
  piAuthProvider?: string;
  models: AdminModelDefinition[];
  defaultModel: string;
  midStreamBehavior?: 'steer' | 'queue';
}

interface AdminModelDefinition {
  id: string;
  name: string;
  tier?: 'fast' | 'standard' | 'premium';
}
```

## LLM Config Assignment
- **User-level override** (highest priority): complete replacement
- **Single group**: use group config
- **Multi-group merge**: union by slug (dedup by first match, groups sorted by groupId lexicographically); defaultConnection from first group in user's groupIds array
- **No config**: empty connections array → client shows "no LLM config" banner

## Config Mapping (Admin API → LlmConnection)
| Admin API field | LlmConnection field | Notes |
|----------------|---------------------|-------|
| slug | slug | direct |
| name | name | direct |
| providerType | providerType | direct |
| authType | authType | direct |
| models | models | modelSelectionMode = 'userDefined3Tier' |
| defaultModel | defaultModel | direct |
| piAuthProvider | piAuthProvider | direct |
| baseUrl | baseUrl | direct |
| midStreamBehavior | midStreamBehavior | direct |
| defaultConnection | StoredConfig.defaultLlmConnection | global default |
