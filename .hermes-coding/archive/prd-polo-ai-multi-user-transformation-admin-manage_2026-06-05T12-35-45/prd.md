# PRD: Polo AI Multi-User Transformation + Admin Management Console (MVP-1)

> **Version**: 1.0 | **Date**: 2026-06-05 | **Spec Reference**: `.task/spec.md` (v2.0)
> **Status**: Active | **Scope**: MVP-1 (WebUI only)

---

## Context Index

This PRD references the comprehensive technical specification at `.task/spec.md`. For compression recovery, the following context files contain extracted details:

| Context File | Content | Spec Sections |
|-------------|---------|---------------|
| `context/user-intent.md` | Core requirement + acceptance criteria | 1.2, 1.3 |
| `context/architecture.md` | System architecture + deployment | 2.1, 7.1, 7.2 |
| `context/decisions.md` | 20 design decisions + v2.0 changes | 2.2, Appendix C |
| `context/data-model.md` | 4 SQL tables + JWT payload + local storage | 3.1, 3.3, 5.2 |
| `context/api-spec.md` | 14 REST API endpoints with full contracts | 3.2, 4.2.2 |
| `context/files-referenced.md` | All file paths for existing + new code | 4.1, Appendix A, B |

---

## 1. Problem Statement

Polo AI is currently single-user: users must configure their own Anthropic API Key or OAuth credentials. This blocks adoption for non-technical users and prevents multi-tenant deployment.

**Core requirement**: "Users should not need to understand API Keys -- they register, log in, and start using the platform."

## 2. Solution Overview

Add a multi-user layer to Polo AI with an independent Admin management console:

1. **Admin Console** (new project: `polo-admin/`): Next.js + PostgreSQL + Prisma + shadcn/ui
   - User CRUD (admin-created accounts)
   - Monthly token quota management
   - Usage monitoring dashboard

2. **Polo AI Server Modifications** (existing project):
   - JWT-based authentication via HttpOnly cookies
   - WebSocket upgrade-phase auth (replacing handshake-message auth)
   - Platform-managed LLM API Key injection
   - Per-user workspace isolation
   - Quota check before every LLM call
   - Usage capture from agent turn callbacks
   - Async usage reporting with local pending fallback

3. **Deployment**: Docker Compose (PostgreSQL + Admin + Polo AI Server)

## 3. MVP-1 Scope

### In Scope
- Admin login (super admin, auto-created from env vars)
- Admin user management (create, list, update, disable, soft-delete)
- Admin dashboard (user count, total usage, active users, top users)
- Admin user detail page (quota settings, usage records)
- User login on WebUI (username + password)
- JWT authentication flow (Admin issues -> Polo AI cookies -> WebSocket upgrade)
- Platform API Key mode (PLATFORM_ANTHROPIC_API_KEY)
- Pre-message quota check (optimistic, soft over-quota tolerance)
- Usage capture from agent turn completion callback
- Async usage reporting with JSONL pending queue and retry
- User-isolated workspaces (`~/.polo-ai/users/{userId}/workspaces/{wsId}/`)
- Workspace ownership validation on all RPC handlers
- Auto-create workspace on first login
- Quota display in WebUI top bar
- Hide LLM connection config UI in platform mode
- Skip API Key onboarding in platform mode
- Docker Compose deployment
- Audit log table (insert only, no UI)

### Out of Scope (Deferred)
- CLI login (MVP-1.5)
- Electron login (MVP-1.5)
- Password change (MVP-1.5)
- JWT auto-refresh (MVP-1.5)
- Multi-model weighted billing (MVP-2)
- API Access Tokens (MVP-2)
- Workspace sharing/collaboration (MVP-2)
- Usage reports/charts (MVP-3)
- Self-service password reset (MVP-3)
- User-provided API Keys (MVP-3)
- Audit log UI (MVP-3)

## 4. Acceptance Criteria

```
Admin creates account (sets username + password + monthly quota)
    -> User logs in on Polo AI WebUI (username + password)
    -> User sends message
    -> System checks user quota (Polo AI Server calls Admin API, deducts local pending)
    -> Quota sufficient -> Use platform Key to call Claude -> Stream response
    -> Agent turn completes -> Capture usage from callback -> Report usage to Admin
    -> Report fails -> Write to local pending, background retry, pending participates in quota checks
    -> Quota insufficient -> Reject with user-friendly message
    -> Admin console can view per-user usage
```

## 5. Implementation Phases

| Phase | Scope | Tasks |
|-------|-------|-------|
| **Phase 1**: Admin Project Setup | Next.js + DB + Auth + User CRUD | Tasks 1-9 |
| **Phase 2**: Admin Quota API | Quota check/usage/status + Admin usage views | Tasks 10-14 |
| **Phase 3**: Polo AI Auth Layer | /api/config + /auth/session + WS auth + user isolation | Tasks 15-21 |
| **Phase 4**: LLM + Quota Integration | Platform Key + Admin API client + pending usage + message flow | Tasks 22-30 |
| **Phase 5**: Admin Management UI | Login + Dashboard + User management + User detail | Tasks 31-34 |
| **Phase 6**: Docker + Integration Testing | docker-compose.yml + E2E + error scenarios | Tasks 35-37 |

## 6. Technical Decisions

All 20 design decisions are documented in `context/decisions.md`. Key highlights:

- **Optimistic quota check**: No locks, soft over-quota tolerance, pending participates in subsequent checks
- **Agent turn callback**: Usage captured from onTurnComplete, not synchronous sendMessage return
- **Soft delete**: Users are never physically deleted; status='deleted' preserves FK integrity
- **Shared JWT_SECRET**: Both Admin and Polo AI verify JWT locally
- **HttpOnly cookie**: JWT stored in Polo AI domain cookie, not localStorage

## 7. Testing Strategy Decisions

> Note: These decisions were made with sensible defaults. They can be revised during implementation.

### 7.1 External Service Interaction
- **Admin API tests**: Use actual PostgreSQL in Docker for integration tests. Unit tests mock Prisma client.
- **Polo AI -> Admin communication**: Mock Admin API responses using MSW (Mock Service Worker) or similar HTTP interception.

### 7.2 Test Database Isolation
- **Strategy**: Each test suite uses a separate PostgreSQL schema or database created via Prisma migrate.
- **Cleanup**: Transaction rollback for unit tests; database drop for integration test suites.
- **CI**: Use `docker-compose` with a dedicated test PostgreSQL service.

### 7.3 Visual Regression Testing
- **MVP-1**: Playwright screenshots for key Admin pages (login, dashboard, user list, user detail).
- **Baseline**: Capture reference screenshots during initial implementation; compare on subsequent changes.

### 7.4 CI/CD Constraints
- **Assumption**: CI can run Docker (for PostgreSQL). No cloud service dependencies for tests.
- **No external API calls**: LLM calls are mocked in all test environments.
- **Test matrix**: Unit tests (fast, no Docker) + Integration tests (Docker PostgreSQL) + E2E tests (full Docker Compose stack).

## 8. Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| JWT stolen via XSS | HttpOnly + Secure + SameSite=Strict cookie |
| Concurrent quota over-spending | Optimistic check acceptable for MVP; pending participates in checks |
| Admin API downtime | Refuse messages (no fallback to no-quota mode); pending queue for usage reports |
| Disabled user continues using | Quota check validates status; next message rejected |
| Pending usage data loss | JSONL file persisted to disk; loaded on startup |
| Password brute force | Rate limit: 5 attempts/min/IP on login endpoint |

## 9. Environment Variables

### Polo AI Server
```
PLATFORM_ANTHROPIC_API_KEY  # Platform Anthropic API Key
ADMIN_API_URL               # Admin service URL
JWT_SECRET                  # Shared JWT signing key
POLO_AI_RPC_PORT            # Server port (default 9100)
POLO_AI_RPC_HOST            # Bind address
```

### Admin Service
```
JWT_SECRET                  # Shared JWT signing key
DATABASE_URL                # PostgreSQL connection string
ADMIN_USERNAME              # Initial super admin username
ADMIN_PASSWORD              # Initial super admin password
CORS_ALLOWED_ORIGINS        # Allowed origins for CORS
```

## 10. Success Metrics

- E2E flow completes: admin creates user -> user logs in -> sends message -> gets response -> usage tracked
- Quota enforcement works: user exceeding quota is blocked
- Disabled user cannot send messages
- Usage reports survive Admin downtime (pending queue)
- Docker Compose single-command deployment works
- Admin can view all user usage data
