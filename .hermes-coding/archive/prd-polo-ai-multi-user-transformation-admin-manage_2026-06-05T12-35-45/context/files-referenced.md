# Files Referenced (from Spec Appendix A + Section 4)

## Polo AI - Existing Files to Modify

| Module | Path | Description |
|--------|------|-------------|
| WebSocket Service | `packages/server-core/src/transport/server.ts` | Handshake auth, connection management |
| RPC Handler Registry | `packages/server-core/src/handlers/rpc/index.ts` | All handler entry points |
| Session Message Handling | `packages/server-core/src/handlers/rpc/sessions.ts` | sendMessage and other core interfaces |
| Agent Auth Injection | `packages/shared/src/agent/claude-agent.ts` | postInit() injects API Key |
| Credential Resolution | `packages/shared/src/config/llm-connections.ts` | resolveAuthEnvVars() |
| Auth State | `packages/shared/src/auth/state.ts` | getAuthState(), getSetupNeeds() |
| Onboarding | `packages/server-core/src/handlers/rpc/onboarding.ts` | First-time setup flow |
| WebUI HTTP | `packages/server-core/src/webui/http-server.ts` | HTTP routes, static files |
| WebUI Auth | `packages/server-core/src/webui/auth.ts` | JWT/cookie verification |
| Service Bootstrap | `packages/server-core/src/bootstrap/headless-start.ts` | Service initialization |
| Protocol Definitions | `packages/shared/src/protocol/channels.ts` | RPC channel definitions |
| Type Definitions | `packages/core/src/types/` | Session, Message, etc. |
| Transport Types | `packages/server-core/src/transport/types.ts` | Connection context types |

## Polo AI - New Files to Create

| Module | Path | Description |
|--------|------|-------------|
| Admin API Client | `packages/shared/src/admin-api/client.ts` | HTTP client for Admin REST API |
| Pending Usage Store | `packages/shared/src/admin-api/pending-usage.ts` | Local JSONL queue for failed usage reports |

## Admin Project - New Project (polo-admin/)

```
polo-admin/
  src/
    app/
      api/
        auth/
          login/route.ts
          refresh/route.ts          # MVP-1.5
          change-password/route.ts  # MVP-1.5
        admin/
          users/route.ts
          users/[id]/route.ts
          users/[id]/usage/route.ts
          usage/overview/route.ts
        quota/
          check/route.ts
          usage/route.ts
          status/route.ts
      (admin)/
        layout.tsx
        dashboard/page.tsx
        users/page.tsx
        users/[id]/page.tsx
      login/page.tsx
    lib/
      db.ts                  # Prisma client
      auth.ts                # JWT sign/verify
      audit.ts               # Audit log writer
      middleware.ts          # Auth middleware
    types/
      index.ts
  prisma/
    schema.prisma
  package.json
  next.config.ts
  tailwind.config.ts
  Dockerfile
  .env.local
```

## Deployment Files

| File | Description |
|------|-------------|
| `docker-compose.yml` | Root-level orchestration (postgres + admin + polo-server) |
| `polo-admin/Dockerfile` | Admin service container |
| `.env` / `.env.example` | Environment variable templates |

## Storage Paths (Runtime)

| Path | Description |
|------|-------------|
| `~/.polo-ai/users/{userId}/workspaces/{wsId}/` | User-isolated workspace data (platform mode) |
| `~/.polo-ai/pending-usage.jsonl` | Local pending usage queue |
