# Polo AI 多用户改造 — 技术规范

> **版本**: v1.0 | **日期**: 2026-06-05 | **状态**: 待评审
> **仓库**: `polo-ai`（当前项目）
> **对齐契约**: 见 `shared-contract.md`

---

## 1. 改造概述

在 Polo AI 现有代码上增加多用户支持，使其能配合独立部署的 Admin 管理后台，实现：
- 用户通过 WebUI 登录（用户名+密码，Admin 签发 JWT）
- 平台统一托管 LLM API Key，用户无感知
- 发消息前检查配额，完成后上报用量
- 用户数据按 userId 隔离

**MVP-1 入口范围：仅 WebUI。** CLI/Electron 推到 MVP-1.5。

---

## 2. 改造总览

```
改造点                              │ 影响文件
───────────────────────────────────┼──────────────────────────
新增：GET /api/config 端点          │ packages/server-core/src/webui/http-server.ts
新增：POST /auth/session 端点       │ packages/server-core/src/webui/http-server.ts
改造：WebSocket upgrade 认证        │ packages/server-core/src/transport/server.ts
扩展：RequestContext                │ packages/server-core/src/transport/types.ts
改造：文件存储路径（按用户隔离）     │ packages/server-core/
新增：workspace 归属校验+自动创建   │ packages/server-core/src/handlers/
新增：WebUI 登录页                  │ apps/webui/
新增：Admin API Client              │ packages/shared/src/admin-api/client.ts
新增：pending_usage 本地队列        │ packages/shared/src/admin-api/pending-usage.ts
改造：消息发送流程（配额+用量）      │ packages/server-core/src/handlers/rpc/sessions.ts
改造：Agent 初始化（注入平台 Key）   │ packages/shared/src/agent/claude-agent.ts
改造：resolveAuthEnvVars            │ packages/shared/src/config/llm-connections.ts
改造：Onboarding（跳过 Key 配置）   │ packages/shared/src/auth/state.ts
隐藏：LLM 连接配置 UI              │ apps/webui/
新增：WebUI 配额显示组件            │ apps/webui/
```

---

## 3. 认证流程改造

### 3.1 新增 HTTP 端点

#### GET /api/config

前端启动时调用，获取 Admin 服务地址。

```
Response 200:
{
  "adminUrl": "http://localhost:3001",
  "platformMode": true
}
```

- `adminUrl`: 来自 `ADMIN_API_URL` 环境变量
- `platformMode`: `PLATFORM_ANTHROPIC_API_KEY` 是否存在

**改造文件**: `packages/server-core/src/webui/http-server.ts`

#### POST /auth/session

前端拿到 Admin 签发的 JWT 后，调用此端点设置 cookie。

```
Request:
{ "token": "eyJ..." }

Response 200:
Set-Cookie: polo_session=eyJ...; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400
{
  "user": {
    "id": "uuid",
    "username": "alice",
    "role": "user"
  }
}

Response 401:
{ "error": "invalid_token" }
```

**行为：**
1. 用 `JWT_SECRET` 验证 JWT 签名
2. 提取 userId, username, role
3. 设置 HttpOnly cookie（`polo_session`）
4. 内存保存 JWT（后续调 Admin API 用）

**改造文件**: `packages/server-core/src/webui/http-server.ts`, `packages/server-core/src/webui/auth.ts`

### 3.2 WebSocket 认证改造

认证从 handshake message 移到 HTTP upgrade 阶段。

**当前**:
```typescript
// handshake message 带 token
{ type: 'handshake', token: 'POLO_AI_SERVER_TOKEN', workspaceId: 'ws-1' }
```

**改造后**:
```typescript
// HTTP upgrade 阶段
onUpgrade(request) {
  // 1. 从 cookie 提取 JWT
  const jwt = parseCookie(request.headers.cookie, 'polo_session');
  if (jwt) {
    const payload = verifyJwt(jwt, JWT_SECRET);
    return { userId: payload.sub, username: payload.username, role: payload.role, jwt };
  }

  // 2. Fallback: POLO_AI_SERVER_TOKEN（本地开发/服务间通信）
  const token = request.headers['x-server-token'];
  if (token === POLO_AI_SERVER_TOKEN) {
    return { userId: null, username: 'system', role: 'admin', jwt: null };
  }

  // 3. 拒绝
  return reject(401);
}

// handshake message 简化
{ type: 'handshake', protocolVersion: '1.1', workspaceId: 'ws-1' }

// handshake_ack 新增用户信息
{ type: 'handshake_ack', clientId: 'uuid', userId: 'user-uuid', username: 'alice', ... }
```

**向后兼容**: 保留 `POLO_AI_SERVER_TOKEN` 通过 HTTP header 认证。

**改造文件**: `packages/server-core/src/transport/server.ts`, `packages/server-core/src/transport/types.ts`

### 3.3 RequestContext 扩展

```typescript
interface RequestContext {
  clientId: string;
  workspaceId: string | null;
  webContentsId: number | null;
  // 新增
  userId: string | null;
  username: string | null;
  userRole: 'admin' | 'user' | null;
  userJwt: string | null;  // 原始 JWT，用于调 Admin API
}
```

---

## 4. 用户隔离改造

### 4.1 文件存储路径

**当前**: `~/.polo-ai/workspaces/{wsId}/`

**改造后**: `~/.polo-ai/users/{userId}/workspaces/{wsId}/`

平台模式下所有 workspace 数据按 userId 隔离存储。

### 4.2 Workspace 归属校验

Workspace 元数据增加 `owner_user_id` 字段：

```typescript
interface WorkspaceMeta {
  id: string;
  name: string;
  owner_user_id: string;  // 新增
}
```

所有 workspace/session 相关 RPC handler 在执行前校验归属：

```typescript
function assertWorkspaceAccess(ctx: RequestContext, workspace: WorkspaceMeta) {
  if (ctx.userId && workspace.owner_user_id !== ctx.userId) {
    throw new ForbiddenError('无权访问此 workspace');
  }
}
```

需要加校验的 handler：
- `sessions:*`（sendMessage, getSession, listSessions 等）
- `workspace:*`（getWorkspace, updateWorkspace 等）
- `files:*`（读写 workspace 内文件）

### 4.3 自动创建 Workspace

用户首次连接且未指定 workspaceId 时，自动创建以 username 命名的 workspace：

```typescript
if (!workspaceId && ctx.userId) {
  const ws = await workspaceManager.findOrCreate({
    name: ctx.username,
    owner_user_id: ctx.userId,
  });
  workspaceId = ws.id;
}
```

---

## 5. 消息发送流程改造

### 5.1 改造后的 sendMessage

```typescript
async function handleSendMessage(ctx, sessionId, message) {
  // 1. 校验 workspace 归属
  assertWorkspaceAccess(ctx, session.workspace);

  // 2. 检查配额（Admin remaining - 本地 pending）
  const adminResult = await adminApiClient.checkQuota(ctx.userJwt);
  const localPending = pendingUsageStore.getPendingTokens(ctx.userId);
  const effectiveRemaining = adminResult.remaining - localPending;

  if (!adminResult.allowed || effectiveRemaining <= 0) {
    throw new QuotaExceededError({ ...adminResult, effectiveRemaining });
  }

  // 3. 生成 requestId
  const requestId = crypto.randomUUID();

  // 4. 调用 LLM
  const result = await session.sendMessage(message);

  return { accepted: true, requestId };
}
```

### 5.2 Usage 捕获

从 agent turn 完成事件回调捕获：

```typescript
agent.onTurnComplete((turnResult) => {
  const usage = turnResult.usage; // { inputTokens, outputTokens }

  // 写入本地 pending
  pendingUsageStore.add({
    requestId, userId: ctx.userId, sessionId,
    model: turnResult.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  // 异步上报到 Admin
  adminApiClient.reportUsage(ctx.userJwt, { ... })
    .then(() => pendingUsageStore.remove(requestId))
    .catch(() => pendingUsageStore.markRetry(requestId));
});
```

**改造文件**:
- `packages/server-core/src/handlers/rpc/sessions.ts` — sendMessage 改造
- `packages/shared/src/agent/claude-agent.ts` — onTurnComplete 回调

---

## 6. 新增模块

### 6.1 Admin API Client

**位置**: `packages/shared/src/admin-api/client.ts`

```typescript
interface AdminApiClient {
  checkQuota(jwt: string, estimatedTokens?: number): Promise<QuotaCheckResult>;
  reportUsage(jwt: string, usage: UsageReport): Promise<UsageReportResult>;
  getQuotaStatus(jwt: string): Promise<QuotaStatus>;
}
```

- HTTP 客户端用 `fetch`（Bun 原生）
- 超时：配额检查 3s，用量上报 5s
- Admin API URL 来自 `ADMIN_API_URL` 环境变量
- API 契约见 `shared-contract.md` §2

### 6.2 Pending Usage Store

**位置**: `packages/shared/src/admin-api/pending-usage.ts`
**存储**: `~/.polo-ai/pending-usage.jsonl`

```typescript
interface PendingUsageStore {
  add(entry: PendingUsageEntry): void;
  remove(requestId: string): void;
  markRetry(requestId: string): void;
  getPendingTokens(userId: string): number;
  getPendingEntries(): PendingUsageEntry[];
}
```

**行为：**
- `add()`: 追加写入 JSONL 文件
- `getPendingTokens(userId)`: 汇总该用户未上报 token 总量
- 启动时加载未处理条目到内存
- 后台每 30s 重试，最多 3 次，失败后保留

---

## 7. API Key 注入改造

**当前**:
```
resolveAuthEnvVars() → credentialManager.getLlmApiKey(slug) → process.env.ANTHROPIC_API_KEY
```

**改造后**:
```
resolveAuthEnvVars()
  → 检查 PLATFORM_ANTHROPIC_API_KEY
  → 存在（平台模式）：直接使用，不读本地凭据库
  → 不存在（本地模式）：走原有流程
```

**改造文件**: `packages/shared/src/config/llm-connections.ts`

---

## 8. Onboarding / UX 简化

### 8.1 跳过 API Key 配置

`getSetupNeeds()` 检测到 `PLATFORM_ANTHROPIC_API_KEY` 时返回 `isFullyConfigured: true`。

**改造文件**: `packages/shared/src/auth/state.ts`

### 8.2 WebUI 登录页

新增登录页，流程：
1. `GET /api/config` → 获取 `adminUrl`
2. 显示用户名+密码表单
3. 提交 → `POST {adminUrl}/api/auth/login`
4. 成功 → `POST /auth/session { token }`
5. 跳转到主界面

### 8.3 隐藏 LLM 连接配置 UI

平台模式下不显示 LLM 连接配置页面。

### 8.4 配额显示

WebUI 顶栏显示当前用户配额使用情况（调 `GET /api/quota/status`，见 `shared-contract.md` §2.2）。

---

## 9. 错误处理

### 9.1 配额不足

返回友好消息：`"您本月的使用额度已用完。配额将在下月 1 日重置。如需更多额度，请联系管理员。"`

### 9.2 Admin API 不可用

- 配额检查失败 → 拒绝发消息（"服务暂时不可用"）
- 用量上报失败 → 写本地 pending，后台重试
- **不 fallback 到无配额检查模式**

### 9.3 JWT 过期

- 已建立的 WebSocket 不断开
- 调 Admin API 返回 401 → 通知前端重新登录
- MVP-1.5 实现自动刷新

### 9.4 用户被禁用

- 已连接 WebSocket 不主动断开
- 下次发消息 → 配额检查返回 403 → 前端显示"账号已被禁用"

---

## 10. 环境变量

```bash
PLATFORM_ANTHROPIC_API_KEY=sk-ant-xxx   # 平台 API Key
ADMIN_API_URL=http://localhost:3001      # Admin 服务地址
JWT_SECRET=xxx                           # 与 Admin 共享
POLO_AI_RPC_PORT=9100
POLO_AI_RPC_HOST=127.0.0.1
```

---

## 11. 实现顺序

| 序号 | 任务 | 依赖 | 改造文件 |
|------|------|------|----------|
| 1 | GET /api/config 端点 | — | http-server.ts |
| 2 | POST /auth/session 端点 | — | http-server.ts, auth.ts |
| 3 | WebSocket upgrade 认证改造 | 2 | transport/server.ts |
| 4 | 扩展 RequestContext | 3 | transport/types.ts |
| 5 | 文件存储路径隔离 | 4 | server-core/ |
| 6 | Workspace 归属校验+自动创建 | 5 | handlers/ |
| 7 | WebUI 登录页 | 1, 2 | apps/webui/ |
| 8 | resolveAuthEnvVars 平台 Key | — | llm-connections.ts |
| 9 | Onboarding 跳过 API Key | 8 | auth/state.ts |
| 10 | Admin API Client | — | admin-api/client.ts |
| 11 | pending_usage store | — | admin-api/pending-usage.ts |
| 12 | sendMessage 配额检查+归属校验 | 6, 10, 11 | sessions.ts |
| 13 | Agent turn 回调捕获 usage | 12 | claude-agent.ts |
| 14 | 异步用量上报+pending 重试 | 13 | sessions.ts |
| 15 | 隐藏 LLM 连接配置 UI | 8 | apps/webui/ |
| 16 | WebUI 配额显示组件 | 7, 10 | apps/webui/ |

---

## 12. 当前代码关键路径

| 模块 | 路径 | 说明 |
|------|------|------|
| WebSocket 服务 | `packages/server-core/src/transport/server.ts` | handshake 认证、连接管理 |
| RPC Handler 注册 | `packages/server-core/src/handlers/rpc/index.ts` | 所有 handler 入口 |
| Session 消息处理 | `packages/server-core/src/handlers/rpc/sessions.ts` | sendMessage 等核心接口 |
| Agent 认证注入 | `packages/shared/src/agent/claude-agent.ts` | postInit() 注入 API Key |
| 凭据解析 | `packages/shared/src/config/llm-connections.ts` | resolveAuthEnvVars() |
| 认证状态 | `packages/shared/src/auth/state.ts` | getAuthState(), getSetupNeeds() |
| Onboarding | `packages/server-core/src/handlers/rpc/onboarding.ts` | 首次设置流程 |
| WebUI HTTP | `packages/server-core/src/webui/http-server.ts` | HTTP 路由、静态文件 |
| WebUI 认证 | `packages/server-core/src/webui/auth.ts` | JWT/cookie 验证 |
| 服务启动 | `packages/server-core/src/bootstrap/headless-start.ts` | 服务初始化 |
