# Referenced Files Index

## Files to Modify
- `packages/server-core/src/webui/http-server.ts` — 新增 /api/config 和 /auth/session 路由
- `packages/server-core/src/webui/auth.ts` — JWT 验证逻辑改造（支持多用户 JWT payload）
- `packages/server-core/src/transport/server.ts` — WebSocket upgrade 阶段认证改造
- `packages/server-core/src/transport/types.ts` — RequestContext 扩展
- `packages/server-core/src/handlers/rpc/sessions.ts` — sendMessage 增加归属校验、配额检查
- `packages/shared/src/agent/claude-agent.ts` — onTurnComplete 回调捕获 usage
- `packages/shared/src/config/llm-connections.ts` — resolveAuthEnvVars() 平台 Key 模式
- `packages/shared/src/auth/state.ts` — getSetupNeeds() 平台模式判断
- `packages/server-core/src/handlers/rpc/onboarding.ts` — 平台模式简化流程

## Files to Create
- `packages/shared/src/admin-api/client.ts` — Admin API Client
- `packages/shared/src/admin-api/pending-usage.ts` — Pending Usage Store
- `apps/webui/` 内新增登录页组件、配额显示组件

## Spec Files
- `.task/spec-polo-ai.md` — Polo AI 改造 spec
- `.task/shared-contract.md` — 对齐契约（JWT、API 契约、环境变量）
