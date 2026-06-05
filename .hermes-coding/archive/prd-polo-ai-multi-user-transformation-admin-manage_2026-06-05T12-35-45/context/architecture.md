# System Architecture (from Spec Section 2.1)

## System Components

```
+-------------------------------------------------------------+
|                      User Side (Polo AI)                     |
|                                                              |
|  +----------+                                                |
|  |  WebUI   |  (MVP-1 only entry)                            |
|  | Browser  |                                                |
|  +----+-----+                                                |
|       |                                                      |
|       | 1. POST Admin /api/auth/login                        |
|       |---------------------------------------------+        |
|       |                                              |        |
|       | 2. POST Polo AI /auth/session { token: JWT } v        |
|       |--------------+                         Admin API      |
|       |              v                                        |
|       | 3. WebSocket upgrade (cookie with JWT)                |
|       |--------------v----------+                             |
|       |              |          |                              |
|       |    +---------v--------+ |                             |
|       |    |  Polo AI Server  | |<-- PLATFORM_ANTHROPIC_API_KEY|
|       |    | (Bun+TypeScript) | |    (env var)                |
|       |    +--------+---------+ |                             |
|       |             |           |                              |
+-------------------------------------------------------------+
                      | REST API (pass-through user JWT)
                      v
+--------------------------------------------------------------+
|                  Admin Management Console (New Project)        |
|  +-------------------+  +------------------------------+      |
|  | Next.js Frontend  |  |    Next.js API Routes        |      |
|  | shadcn/ui+Tailwind|  | /api/auth/* /api/admin/*     |      |
|  | (super admin UI)  |  | /api/quota/*                  |      |
|  +-------------------+  +----------+-------------------+      |
|                                    |                          |
|                           +--------v--------+                 |
|                           |   PostgreSQL    |                 |
|                           |  users, quotas, |                 |
|                           |  usage, audit   |                 |
|                           +-----------------+                 |
+--------------------------------------------------------------+
```

## Communication Flows

### Login Flow
1. WebUI -> GET Polo AI `/api/config` -> get `{ adminUrl }`
2. WebUI -> POST Admin `{adminUrl}/api/auth/login` (CORS) -> get JWT in JSON body
3. WebUI -> POST Polo AI `/auth/session` { token: JWT } -> Polo AI verifies JWT, sets HttpOnly cookie
4. WebUI -> WebSocket upgrade (cookie auto-attached) -> Polo AI reads cookie, verifies JWT, binds userId
5. WebUI -> handshake message { workspaceId } -> Polo AI validates workspace ownership

### Message Flow
1. User sends message via WebSocket RPC `sessions:sendMessage`
2. Polo AI checks workspace ownership (`ctx.userId === workspace.owner_user_id`)
3. Polo AI calls Admin `POST /api/quota/check` with user JWT
4. Polo AI computes `effectiveRemaining = adminRemaining - localPending`
5. If allowed: call Claude SDK with `PLATFORM_ANTHROPIC_API_KEY`
6. Stream response to user
7. Agent turn completes -> callback captures `{ inputTokens, outputTokens }`
8. Write to local `pending_usage` (JSONL)
9. Async POST Admin `/api/quota/usage` with idempotent `requestId`
10. Success: remove from pending. Failure: mark for retry (every 30s, max 3 attempts)

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Polo AI Server | Bun + TypeScript |
| Polo AI WebUI | Browser-based (existing) |
| Admin Backend | Next.js API Routes |
| Admin Frontend | Next.js + shadcn/ui + Tailwind |
| Admin ORM | Prisma |
| Database | PostgreSQL 16 |
| Password Hashing | argon2id |
| Auth Tokens | JWT (HS256) |
| Deployment | Docker Compose |

## Environment Variables

### Polo AI Server
- `PLATFORM_ANTHROPIC_API_KEY` - Platform Anthropic API Key
- `ADMIN_API_URL` - Admin service address
- `JWT_SECRET` - JWT signing key (shared with Admin)
- `POLO_AI_RPC_PORT` - WebSocket/HTTP port (default 9100)
- `POLO_AI_RPC_HOST` - Bind address

### Admin Service
- `JWT_SECRET` - JWT signing key (shared with Polo AI)
- `DATABASE_URL` - PostgreSQL connection string
- `ADMIN_USERNAME` - Initial super admin username
- `ADMIN_PASSWORD` - Initial super admin password
- `CORS_ALLOWED_ORIGINS` - Allowed Polo AI domains for CORS

## Deployment (Docker Compose)
Three services:
1. **postgres** - PostgreSQL 16 with persistent volume
2. **admin** - Next.js admin console (port 3001->3000)
3. **polo-server** - Polo AI server (port 9100)

Dependencies: polo-server -> admin -> postgres
