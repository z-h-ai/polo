# API Specification

## Source
- Extracted from: spec §3 (Admin API 契约)
- Timestamp: 2026-06-06

## Admin API Endpoints (Client Consumes)

### Authentication
| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/auth/login | Username+password login, returns JWT + user info |
| POST | /api/auth/logout | Logout current session (invalidate JWT by jti) |
| POST | /api/auth/validate | Validate JWT, returns user info + configVersion |

### LLM Configuration
| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/llm-connections | Get user's LLM connections (encrypted API keys) |

### Admin Management (Admin role only)
| Method | Path | Purpose |
|--------|------|---------|
| POST | /api/admin/users | Create user |
| PUT | /api/admin/users/:userId/password | Reset password |
| POST | /api/admin/users/:userId/revoke-sessions | Revoke all sessions |
| POST | /api/admin/users/:userId/revoke-session/:jti | Revoke single session |
| GET | /api/admin/users/:userId/sessions | List active sessions |
| GET | /api/admin/users | List users (paginated) |
| POST | /api/admin/groups | Create user group |
| PUT | /api/admin/groups/:groupId/llm-connections | Set group LLM config |
| PUT | /api/admin/users/:userId/llm-connections | Set user LLM override |

## Error Response Format
```json
{
  "error": "machine_readable_code",
  "message": "Human-readable description",
  "details": {},
  "requestId": "req_xxxx"
}
```

## JWT Claims
```json
{
  "sub": "usr_abc123",
  "jti": "sess_unique_id",
  "iat": 1717660800,
  "iss": "polo-admin",
  "aud": "polo-client",
  "role": "user"
}
```
- No `exp` (product decision)
- `jti` used for server-side revocation tracking

## Encrypted Credential Format
```typescript
interface EncryptedCredential {
  alg: 'aes-256-gcm';
  kid: string;
  iv: string;    // base64, 12-byte random IV
  ciphertext: string; // base64
  tag: string;   // base64, 16-byte GCM auth tag
}
```
- Key derivation: HKDF-SHA256 from JWT string
  - salt: "polo-llm-key-encryption" (UTF-8)
  - info: "aes-256-gcm" (UTF-8)
  - inputKeyMaterial: JWT token raw string (UTF-8)

## Rate Limits (Contractual)
| Endpoint | Limit |
|----------|-------|
| POST /api/auth/login | 5/min/IP, 3/min/username; 10 consecutive fails → 30min lockout |
| POST /api/auth/validate | 60/min/token |
| GET /api/llm-connections | 10/min/token |
| Admin endpoints | 30/min/admin-token |

## Global 401 Convention
All Bearer JWT endpoints return 401 when token is revoked/invalid.
Client must: cancel LLM requests → clear all caches → save drafts → show dialog → redirect to login.
