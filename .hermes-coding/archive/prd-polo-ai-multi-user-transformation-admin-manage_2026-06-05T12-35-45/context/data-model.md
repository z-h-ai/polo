# Data Model (PostgreSQL)

## users

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(64) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,        -- argon2id
  display_name  VARCHAR(128),
  role          VARCHAR(16) DEFAULT 'user',   -- 'admin' | 'user'
  status        VARCHAR(16) DEFAULT 'active', -- 'active' | 'disabled' | 'deleted'
  monthly_quota_tokens BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
```

### Status State Machine
- `active` -> `disabled`: Admin disables; JWT still valid but quota/check rejects
- `disabled` -> `active`: Admin re-enables
- `active`/`disabled` -> `deleted`: Soft delete, permanent, not recoverable
- Login requires status = `active`

## usage_records

```sql
CREATE TABLE usage_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  request_id      VARCHAR(128) UNIQUE,          -- Idempotency key
  session_id      VARCHAR(128),
  model           VARCHAR(64),
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_usage_user_month ON usage_records (user_id, created_at);
```

## quota_periods

```sql
CREATE TABLE quota_periods (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  period      VARCHAR(7) NOT NULL,            -- '2026-06' format
  used_tokens BIGINT NOT NULL DEFAULT 0,
  quota_limit BIGINT NOT NULL,                -- Copied from users.monthly_quota_tokens at creation
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, period)
);
```

## admin_audit_logs

```sql
CREATE TABLE admin_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   UUID NOT NULL REFERENCES users(id),
  action          VARCHAR(64) NOT NULL,       -- 'create_user' | 'update_user' | 'disable_user' | 'delete_user' | 'reset_password' | 'update_quota'
  target_user_id  UUID REFERENCES users(id),
  detail          JSONB,                       -- Change details (old/new values)
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_admin ON admin_audit_logs (admin_user_id, created_at);
CREATE INDEX idx_audit_target ON admin_audit_logs (target_user_id, created_at);
```

## JWT Payload

```json
{
  "sub": "user-uuid",
  "username": "alice",
  "role": "user",
  "iat": 1717300000,
  "exp": 1717386400
}
```

| Property | Value |
|----------|-------|
| Algorithm | HS256 |
| Issuer | Admin service |
| Secret | `JWT_SECRET` env var (shared between Admin and Polo AI) |
| Expiry | 24 hours |

## Polo AI Local Storage

### Workspace Metadata (extended)
```typescript
interface WorkspaceMeta {
  id: string;
  name: string;
  owner_user_id: string;  // NEW
}
```

### Pending Usage Entry (JSONL at ~/.polo-ai/pending-usage.jsonl)
```typescript
interface PendingUsageEntry {
  requestId: string;
  userId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  retryCount: number;
}
```
