# Design Decisions (from Spec Section 2.2)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Admin tech stack | Next.js + PostgreSQL + Prisma | Team familiarity, unified frontend/backend, mature Prisma migration tools |
| 2 | Admin UI framework | shadcn/ui + Tailwind | Lightweight, customizable, suited for admin consoles |
| 3 | Inter-service communication | Admin exposes REST API | Simple and direct; Polo AI calls Admin for auth and quota |
| 4 | Login chain | Frontend -> Admin (JWT body) -> Polo AI (sets cookie) | Frontend directly calls Admin for JWT, Polo AI sets HttpOnly cookie and stores JWT for Admin API calls |
| 5 | WebSocket auth | HTTP upgrade phase reads cookie | Extract JWT from cookie, verify, then upgrade; handshake message only carries workspaceId |
| 6 | Token storage | HttpOnly cookie on Polo AI domain | Reuses existing WebUI auth pattern, prevents XSS theft |
| 7 | JWT verification | Shared JWT_SECRET, local verification | Polo AI verifies JWT signature locally, no need to call Admin API each time |
| 8 | User login method | Username + password (admin-created accounts) | Simplest MVP, no email service needed, no forced first-time password change |
| 9 | Quota strategy | Optimistic check + soft over-quota tolerance | Check is read-only (no locks), remaining > 0 allows request, actual usage recorded after completion, next check enforces |
| 10 | Usage capture | Agent turn completion event callback | Capture per-turn usage from onTurnComplete/onStreamEnd, not session cumulative delta |
| 11 | Report failure handling | Local pending_usage (JSONL) participates in quota checks | On check: remaining minus local unreported pending amount |
| 12 | Model billing | MVP: no model differentiation, tokens are equal | All model tokens counted equally; post-MVP: weighted by model |
| 13 | User isolation | userId-bound workspace + RPC ownership validation | File path: `~/.polo-ai/users/{userId}/workspaces/{wsId}/` |
| 14 | User deletion | Soft delete (status='deleted') | Preserves data and foreign key integrity; login/quota checks filter deleted |
| 15 | Multiple connections | Allow same user multiple concurrent WebSocket | No restriction; quota concurrency handled by optimistic checks |
| 16 | Admin URL discovery | Polo AI Server GET /api/config | Frontend calls on startup to get adminUrl |
| 17 | CORS | Admin whitelist configuration | Env var configures allowed Polo AI domain for cross-origin |
| 18 | Super admin initialization | Env vars + auto-create on startup | Detects no admin user -> creates from ADMIN_USERNAME/ADMIN_PASSWORD |
| 19 | Audit logs | admin_audit_logs table | MVP: create table + insert data, no UI |
| 20 | Deployment | Docker Compose | Polo AI Server + Admin + PostgreSQL single-command launch |

## v1.1 -> v2.0 Key Changes

| Original v1.1 Issue | v2.0 Resolution |
|---------------------|-----------------|
| User isolation deferred to MVP-2 | userId-bound workspace + file path isolation + RPC ownership validation |
| Auth chain forked (frontend direct vs server proxy) | Unified: frontend -> Admin JWT body -> Polo AI sets HttpOnly cookie |
| Quota check+usage non-atomic, concurrent over-quota | Optimistic check + soft tolerance + local pending participates |
| Usage report assumed sendMessage synchronously returns usage | Changed to agent turn completion event callback |
| Report failure creates free-quota window | Local pending_usage (JSONL) participates in quota checks |
| Disabled user JWT still valid | Quota check validates user.status, disabled returns 403 |
| MVP scope inconsistent | MVP-1 narrowed to WebUI only, MVP-1.5 added to fill remaining entries |
| Platform mode other credentials not isolated | File path isolation by userId naturally covers all workspace data |
| Missing audit fields | Added admin_audit_logs table |
| DELETE users conflicts with foreign keys | Changed to soft delete status='deleted' |

## Testing & CI Decisions (User Confirmed 2026-06-05)

### Test Strategy
- **Approach**: Mixed — unit tests mock Prisma/Admin API; integration tests use real PostgreSQL in Docker; LLM calls always mocked
- **Rationale**: Balance between speed (unit) and confidence (integration)

### Test DB Isolation
- **Strategy**: Separate `_test` database per test suite via Prisma migrate; transaction rollback for unit tests
- **Rationale**: Full PostgreSQL feature compatibility, clean isolation

### Visual Testing
- **Tool**: Playwright screenshots for key Admin pages
- **Rationale**: User wants visual regression coverage for Admin UI

### CI/CD Constraints
- **Environment**: CI can run Docker containers (PostgreSQL) but no external API calls in tests
- **Rationale**: Docker-only CI environment
