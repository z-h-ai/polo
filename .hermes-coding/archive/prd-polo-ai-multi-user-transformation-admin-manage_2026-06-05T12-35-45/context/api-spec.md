# REST API Specification

## 1. Authentication API (Admin Service)

### POST /api/auth/login -- User Login
- **Request**: `{ username, password }`
- **Response 200**: `{ token: JWT, user: { id, username, displayName, role } }`
- **Response 401**: `{ error: "invalid_credentials" }`
- **Response 403**: `{ error: "account_disabled" }` (status != active)
- **Rules**: JWT returned in JSON body (not cookie). Cookie set by Polo AI.

### POST /api/auth/refresh -- Refresh Token (MVP-1.5)
- **Request**: `Authorization: Bearer <current-jwt>`
- **Response 200**: `{ token: "eyJ..." }`
- Checks user.status; disabled/deleted users rejected.

### POST /api/auth/change-password -- Change Password (MVP-1.5)
- **Request**: `Authorization: Bearer <jwt>`, `{ currentPassword, newPassword }`
- **Response 200**: `{ success: true }`
- **Response 400**: `{ error: "invalid_password" }`

## 2. Quota API (Called by Polo AI Server)

### POST /api/quota/check -- Pre-message Quota Check
- **Request**: `Authorization: Bearer <user-jwt>`, `{ estimatedTokens? }`
- **Response 200**: `{ allowed, remaining, limit, used, period }`
- **Response 403**: Account disabled/deleted
- **Rules**: Read-only, no locks (optimistic check). `allowed = remaining > 0`.

### POST /api/quota/usage -- Post-LLM Usage Report
- **Request**: `Authorization: Bearer <user-jwt>`, `{ requestId, sessionId, model, inputTokens, outputTokens }`
- **Response 200**: `{ recorded: true, totalUsed, remaining }`
- **Response 409**: `{ error: "duplicate_request" }` (idempotent by requestId)
- **Rules**: Atomic UPDATE quota_periods.used_tokens. Auto-create quota_period if missing.

### GET /api/quota/status -- Current User Quota Status
- **Request**: `Authorization: Bearer <user-jwt>`
- **Response 200**: `{ userId, period, limit, used, remaining, usageBreakdown: { inputTokens, outputTokens } }`

## 3. Admin User Management API (admin role only)

### GET /api/admin/users -- List Users
- **Request**: `Authorization: Bearer <admin-jwt>`, Query: `?page=1&limit=20&search=&status=`
- **Response 200**: `{ users: [...], total, page, limit }`
- **Rules**: Filters out `deleted` by default (explicit `?status=deleted` to view).

### POST /api/admin/users -- Create User
- **Request**: `Authorization: Bearer <admin-jwt>`, `{ username, password, displayName, monthlyQuotaTokens }`
- **Response 201**: `{ id, username, displayName, role, status, monthlyQuotaTokens, createdAt }`
- **Rules**: Writes audit log.

### PATCH /api/admin/users/:id -- Update User
- **Request**: `Authorization: Bearer <admin-jwt>`, `{ monthlyQuotaTokens?, status?, password?, displayName? }`
- **Response 200**: Updated user object
- **Rules**: Writes audit log.

### DELETE /api/admin/users/:id -- Soft Delete User
- **Response 200**: `{ id, status: "deleted" }`
- **Rules**: Sets status to `deleted`, preserves data. Writes audit log.

### GET /api/admin/users/:id/usage -- Single User Usage Detail
- **Request**: `Authorization: Bearer <admin-jwt>`, Query: `?period=2026-06`
- **Response 200**: `{ userId, username, period, quota, used, records: [...] }`

### GET /api/admin/usage/overview -- Global Usage Overview
- **Request**: `Authorization: Bearer <admin-jwt>`, Query: `?period=2026-06`
- **Response 200**: `{ period, totalUsers, activeUsers, totalTokensUsed, totalQuotaAllocated, topUsers: [...] }`

## 4. Polo AI HTTP Endpoints (New)

### GET /api/config -- Frontend Config Discovery
- **Response 200**: `{ adminUrl, platformMode }`
- **Source**: `ADMIN_API_URL` env var. `platformMode` = `PLATFORM_ANTHROPIC_API_KEY` exists.

### POST /auth/session -- Set Login Session
- **Request**: `{ token: "eyJ..." }`
- **Response 200**: `Set-Cookie: polo_session=<JWT>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`, `{ user: { id, username, role } }`
- **Response 401**: `{ error: "invalid_token" }`
- **Rules**: Polo AI verifies JWT signature with JWT_SECRET, stores JWT in memory + cookie.

## 5. Rate Limits

| Endpoint | Limit |
|----------|-------|
| POST /api/auth/login | 5/min/IP |
| POST /api/quota/check | 60/min/user |
| POST /api/quota/usage | 60/min/user |
