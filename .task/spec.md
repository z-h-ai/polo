# Polo AI 多用户改造 + Admin 管理后台 — 技术规范

> **版本**: v2.0 | **日期**: 2026-06-05 | **状态**: 待评审
> **受众**: 开发团队
> **变更**: 基于 v1.1 功能审阅和深度访谈，修正认证链路、配额原子性、用户隔离、MVP 范围等 9 处设计缺陷

---

## 1. 项目背景与目标

### 1.1 现状

Polo AI 是一个 agent-native 桌面/服务端平台，支持用户通过 AI agent（Claude 等）进行多轮对话。当前架构为 **单用户模式**：

- 用户必须自行配置 Anthropic API Key 或完成 OAuth 认证
- 所有凭据用 AES-256-GCM 加密存储在本机 `~/.polo-ai/credentials.enc`
- 无用户账号系统，无多租户隔离
- 数据按 workspace 隔离，存储在本地文件系统（JSONL/JSON）

### 1.2 目标

**核心诉求**：用户不需要懂 API Key，注册登录就能用。

具体目标：
1. **用户系统**：增加用户注册（由管理员创建）、登录、会话管理
2. **Admin 管理后台**：独立项目，提供用户管理、配额管理、用量查看
3. **平台托管 LLM 调用**：平台统一持有 API Key，用户无感知
4. **用户隔离**：多用户共享服务时，数据严格按用户隔离
5. **MVP 优先**：先跑通基础链路，不做过度设计

### 1.3 验收标准（MVP-1 端到端链路）

```
Admin 创建账号（设用户名+密码+月配额）
    → 用户在 Polo AI WebUI 登录（用户名+密码）
    → 用户发消息
    → 系统检查用户配额（Polo AI Server 调 Admin API，扣减本地 pending）
    → 配额充足 → 用平台 Key 调 Claude → 流式返回回复
    → agent turn 完成 → 从回调捕获 usage → 上报用量到 Admin
    → 上报失败 → 写入本地 pending，后台重试，pending 参与后续配额判断
    → 配额不足 → 拒绝并提示用户
    → Admin 后台可查看各用户用量
```

**MVP-1 入口范围：仅 WebUI**（CLI/Electron 推到 MVP-1.5）。

---

## 2. 整体架构

### 2.1 系统组成

```
┌─────────────────────────────────────────────────────────────┐
│                      用户侧（Polo AI）                        │
│                                                              │
│  ┌──────────┐                                                │
│  │  WebUI   │  （MVP-1 唯一入口）                              │
│  │  浏览器端 │                                                │
│  └────┬─────┘                                                │
│       │                                                      │
│       │  ① POST Admin /api/auth/login                        │
│       │─────────────────────────────────────────────────┐    │
│       │                                                  │    │
│       │  ② POST Polo AI /auth/session { token: JWT }     ▼    │
│       │──────────────┐                            Admin API   │
│       │              ▼                                        │
│       │  ③ WebSocket upgrade（cookie 带 JWT）                 │
│       │──────────────▼──────────┐                             │
│       │              │          │                              │
│       │    ┌─────────▼────────┐ │                             │
│       │    │  Polo AI 服务端   │ │◄── PLATFORM_ANTHROPIC_API_KEY│
│       │    │ (Bun+TypeScript) │ │    (环境变量)                │
│       │    └────────┬─────────┘ │                             │
│       │             │           │                              │
└──────────────────────────────────────────────────────────────┘
                      │ REST API（透传用户 JWT）
                      ▼
┌──────────────────────────────────────────────────────────────┐
│                  Admin 管理后台（新项目）                        │
│  ┌───────────────────┐  ┌──────────────────────────────┐     │
│  │ Next.js 前端       │  │    Next.js API Routes        │     │
│  │ shadcn/ui+Tailwind│  │ /api/auth/* /api/admin/*     │     │
│  │ （超级管理员界面）  │  │ /api/quota/*                  │     │
│  └───────────────────┘  └──────────┬───────────────────┘     │
│                                    │                          │
│                           ┌────────▼────────┐                │
│                           │   PostgreSQL    │                │
│                           │  users, quotas, │                │
│                           │  usage, audit   │                │
│                           └─────────────────┘                │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| Admin 技术栈 | Next.js + PostgreSQL + Prisma | 团队熟悉，前后端一体，Prisma 迁移工具成熟 |
| Admin UI | shadcn/ui + Tailwind | 轻量可定制，适合管理后台 |
| 服务间通信 | Admin 暴露 REST API | 简单直接，Polo AI 调 Admin 做鉴权和配额 |
| 登录链路 | 前端直调 Admin → JWT body → Polo AI 设 cookie | 前端直连 Admin 拿 JWT，Polo AI 设 HttpOnly cookie 并保存 JWT 用于调 Admin API |
| WebSocket 认证 | HTTP upgrade 阶段读 cookie | 从 cookie 提取 JWT，验证后升级连接；handshake message 只传 workspaceId |
| Token 存储 | Polo AI 域名下 HttpOnly cookie | 复用现有 WebUI 认证模式，防 XSS 窃取 |
| JWT 验证 | 共享 JWT_SECRET 本地验证 | Polo AI 本地验 JWT 签名，无需每次调 Admin API |
| 用户登录方式 | 用户名 + 密码（Admin 创建账号） | MVP 最简，无需邮件服务，不强制首次修改密码 |
| 配额策略 | 乐观检查 + 软超额容忍 | check 只读不锁，remaining > 0 即允许，完成后记实际用量，下次拦截 |
| 用量捕获 | agent turn 完成事件回调 | 从 onTurnComplete/onStreamEnd 捕获本轮 usage，非 session 累计差值 |
| 上报失败处理 | 本地 pending_usage (JSONL) 参与配额判断 | check 时 remaining 减去本地 pending 未上报量 |
| 模型计费 | MVP 不区分模型，token 等价 | 所有模型 token 合计计算，MVP 后按模型加权 |
| 用户隔离 | userId 绑定 workspace，RPC 校验归属 | 文件路径 `~/.polo-ai/users/{userId}/workspaces/{wsId}/` |
| 用户删除 | 软删除（status='deleted'） | 保留数据和外键完整性，登录/配额检查过滤 deleted |
| 多连接 | 允许同一用户多并发 WebSocket | 不限制，配额并发用乐观检查兜底 |
| Admin URL 发现 | Polo AI Server GET /api/config | 前端启动时调用获取 adminUrl |
| CORS | Admin 配置白名单 | 环境变量配置允许 Polo AI 域名跨域 |
| 超管初始化 | 环境变量 + 启动时自动创建 | 检测无 admin 用户时用 ADMIN_USERNAME/ADMIN_PASSWORD 创建 |
| 审计日志 | admin_audit_logs 表 | MVP 只建表插数据，不做 UI |
| 部署 | Docker Compose | Polo AI Server + Admin + PostgreSQL 一键启动 |

### 2.3 交付阶段

| 阶段 | 范围 | 入口 | 说明 |
|------|------|------|------|
| **MVP-1** | 登录 + 发消息 + 配额检查/扣减 + Admin 用户管理 + Admin 查看用量 | 仅 WebUI | 端到端链路跑通 |
| **MVP-1.5** | 修改密码 + CLI login + Electron 登录 + JWT 自动刷新 | WebUI + CLI + Electron | 补全入口和基础功能 |
| MVP-2 | API Access Token 管理 + 多模型加权计费 + Workspace 多租户 | 全入口 | 开发者和高级功能 |
| MVP-3 | 用量报表 + 密码自助重置 + 用户自带 Key + 审计日志 UI | 全入口 | 完善运营工具 |

**以下 spec 聚焦 MVP-1。**

---

## 3. Admin 管理后台 — API 设计

### 3.1 数据模型

#### users 表

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

**status 状态机：**
- `active` → `disabled`：Admin 禁用，已签发 JWT 仍可通过签名验证，但 quota/check 会检查 status 并拒绝
- `disabled` → `active`：Admin 重新启用
- `active` / `disabled` → `deleted`：软删除，等效永久禁用，不可恢复
- 登录时校验 status 必须为 `active`

#### usage_records 表

```sql
CREATE TABLE usage_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  request_id      VARCHAR(128) UNIQUE,          -- 幂等键，防止重复上报
  session_id      VARCHAR(128),
  model           VARCHAR(64),
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_usage_user_month ON usage_records (user_id, created_at);
```

#### quota_periods 表

```sql
CREATE TABLE quota_periods (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  period      VARCHAR(7) NOT NULL,            -- '2026-06' 格式
  used_tokens BIGINT NOT NULL DEFAULT 0,
  quota_limit BIGINT NOT NULL,                -- 创建时从 users.monthly_quota_tokens 拷贝
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, period)
);
```

#### admin_audit_logs 表

```sql
CREATE TABLE admin_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id   UUID NOT NULL REFERENCES users(id),
  action          VARCHAR(64) NOT NULL,       -- 'create_user' | 'update_user' | 'disable_user' | 'delete_user' | 'reset_password' | 'update_quota'
  target_user_id  UUID REFERENCES users(id),
  detail          JSONB,                       -- 变更详情（旧值/新值）
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_admin ON admin_audit_logs (admin_user_id, created_at);
CREATE INDEX idx_audit_target ON admin_audit_logs (target_user_id, created_at);
```

### 3.2 REST API 端点

#### 3.2.1 认证 API

**POST /api/auth/login** — 用户登录

```
Request:
{
  "username": "alice",
  "password": "xxx"
}

Response 200:
{
  "token": "eyJhbGciOiJIUzI1NiIs...",  // JWT, 24h 过期（JSON body，不设 cookie）
  "user": {
    "id": "uuid",
    "username": "alice",
    "displayName": "Alice",
    "role": "user"
  }
}

Response 401:
{ "error": "invalid_credentials", "message": "用户名或密码错误" }

Response 403:
{ "error": "account_disabled", "message": "账号已被禁用，请联系管理员" }
```

**行为规则：**
- 校验 user.status 必须为 `active`，`disabled` 和 `deleted` 均拒绝
- JWT 在 JSON body 中返回，**不**通过 Set-Cookie 设置（cookie 由 Polo AI 设置）

**JWT Payload：**
```json
{
  "sub": "user-uuid",
  "username": "alice",
  "role": "user",
  "iat": 1717300000,
  "exp": 1717386400
}
```

**POST /api/auth/refresh** — 刷新 token（MVP-1.5）

```
Request:
Headers: { "Authorization": "Bearer <current-jwt>" }

Response 200:
{ "token": "eyJ..." }
```

刷新时检查 user.status，disabled/deleted 用户拒绝刷新。

**POST /api/auth/change-password** — 用户修改密码（MVP-1.5）

```
Request:
Headers: { "Authorization": "Bearer <jwt>" }
{
  "currentPassword": "old",
  "newPassword": "new"
}

Response 200:
{ "success": true }

Response 400:
{ "error": "invalid_password", "message": "当前密码错误" }
```

#### 3.2.2 配额 API（Polo AI 服务端调用）

**POST /api/quota/check** — 发消息前检查配额

```
Request:
Headers: { "Authorization": "Bearer <user-jwt>" }
{
  "estimatedTokens": 4000  // 可选，用于预检提示
}

Response 200:
{
  "allowed": true,
  "remaining": 850000,
  "limit": 1000000,
  "used": 150000,
  "period": "2026-06"
}

Response 200 (配额不足):
{
  "allowed": false,
  "remaining": 0,
  "limit": 1000000,
  "used": 1000000,
  "period": "2026-06"
}

Response 403:
{ "error": "account_disabled", "message": "账号已被禁用" }
```

**行为规则：**
- 只读操作，不加锁、不预留（乐观检查）
- 检查 user.status，`disabled`/`deleted` 返回 403
- `allowed` 的判定：`remaining > 0`（即 `used < quota_limit`）
- 软超额容忍：只要 check 时 remaining > 0 就允许，调用完成后即使超额也记录实际用量

> **重要**：Polo AI 在使用此 API 返回的 `remaining` 时，需减去本地 `pending_usage` 未上报量再判断。

**POST /api/quota/usage** — LLM 调用后上报用量

```
Request:
Headers: { "Authorization": "Bearer <user-jwt>" }
{
  "requestId": "req-uuid",          // 幂等键，防重复上报
  "sessionId": "session-uuid",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 1500,
  "outputTokens": 2500
}

Response 200:
{
  "recorded": true,
  "totalUsed": 154000,
  "remaining": 846000
}

Response 409:
{ "error": "duplicate_request", "message": "该 requestId 已上报" }
```

**行为规则：**
- `requestId` 为幂等键，重复上报返回 409 但不重复计量
- 上报时更新 `quota_periods.used_tokens`（原子 UPDATE ... SET used_tokens = used_tokens + total）
- 如果当月 quota_period 不存在，自动创建（从 users.monthly_quota_tokens 拷贝 quota_limit）

**GET /api/quota/status** — 查询当前用户配额状态

```
Request:
Headers: { "Authorization": "Bearer <user-jwt>" }

Response 200:
{
  "userId": "uuid",
  "period": "2026-06",
  "limit": 1000000,
  "used": 154000,
  "remaining": 846000,
  "usageBreakdown": {
    "inputTokens": 62000,
    "outputTokens": 92000
  }
}
```

#### 3.2.3 Admin 用户管理 API（仅 admin 角色）

所有 Admin API 在执行写操作时，同时向 `admin_audit_logs` 插入记录。

**GET /api/admin/users** — 列出所有用户

```
Request:
Headers: { "Authorization": "Bearer <admin-jwt>" }
Query: ?page=1&limit=20&search=alice&status=active

Response 200:
{
  "users": [
    {
      "id": "uuid",
      "username": "alice",
      "displayName": "Alice",
      "role": "user",
      "status": "active",
      "monthlyQuotaTokens": 1000000,
      "currentMonthUsed": 154000,
      "createdAt": "2026-05-15T10:00:00Z"
    }
  ],
  "total": 42,
  "page": 1,
  "limit": 20
}
```

默认过滤 `deleted` 状态用户（需显式 `?status=deleted` 查看）。

**POST /api/admin/users** — 创建用户

```
Request:
Headers: { "Authorization": "Bearer <admin-jwt>" }
{
  "username": "bob",
  "password": "initial-password",
  "displayName": "Bob",
  "monthlyQuotaTokens": 500000
}

Response 201:
{
  "id": "uuid",
  "username": "bob",
  "displayName": "Bob",
  "role": "user",
  "status": "active",
  "monthlyQuotaTokens": 500000,
  "createdAt": "2026-06-02T12:00:00Z"
}
```

**PATCH /api/admin/users/:id** — 更新用户

```
Request:
Headers: { "Authorization": "Bearer <admin-jwt>" }
{
  "monthlyQuotaTokens": 2000000,   // 可选
  "status": "disabled",             // 可选：'active' | 'disabled'
  "password": "new-password",       // 可选：重置密码
  "displayName": "New Name"         // 可选
}

Response 200:
{ "id": "uuid", "username": "bob", ...updated fields }
```

**DELETE /api/admin/users/:id** — 软删除用户

```
Response 200:
{ "id": "uuid", "status": "deleted" }
```

**行为**：将 `status` 设为 `deleted`，不物理删除行。保留 usage_records 和 quota_periods 数据用于统计和审计。

**GET /api/admin/users/:id/usage** — 查看单用户用量明细

```
Request:
Headers: { "Authorization": "Bearer <admin-jwt>" }
Query: ?period=2026-06

Response 200:
{
  "userId": "uuid",
  "username": "bob",
  "period": "2026-06",
  "quota": 500000,
  "used": 120000,
  "records": [
    {
      "requestId": "req-abc",
      "sessionId": "session-abc",
      "model": "claude-sonnet-4-20250514",
      "inputTokens": 800,
      "outputTokens": 1200,
      "createdAt": "2026-06-02T14:30:00Z"
    }
  ]
}
```

**GET /api/admin/usage/overview** — 全局用量概览

```
Request:
Headers: { "Authorization": "Bearer <admin-jwt>" }
Query: ?period=2026-06

Response 200:
{
  "period": "2026-06",
  "totalUsers": 42,
  "activeUsers": 28,
  "totalTokensUsed": 5600000,
  "totalQuotaAllocated": 20000000,
  "topUsers": [
    { "userId": "uuid", "username": "alice", "used": 890000 }
  ]
}
```

### 3.3 JWT 设计

| 属性 | 值 |
|------|-----|
| 算法 | HS256 |
| 签发方 | Admin 服务 |
| 密钥 | 环境变量 `JWT_SECRET`（Admin 和 Polo AI 共享） |
| 过期时间 | 24 小时 |
| Payload | `{ sub, username, role, iat, exp }` |

**验证策略**：Admin 和 Polo AI 共享 `JWT_SECRET`，Polo AI 本地验证 JWT 签名。

**disabled/deleted 用户处理**：JWT 签名验证会通过（JWT 本身有效），但后续的配额 check API 会检查 user.status 并拒绝。这意味着：
- 已禁用用户可以建立 WebSocket 连接（JWT 有效）
- 但无法发送消息（配额检查被拒）
- 这是可接受的 MVP 行为，避免了 token revocation 的复杂性

### 3.4 Admin 前端页面（MVP-1）

| 页面 | 功能 |
|------|------|
| `/login` | Admin 登录（超管账号） |
| `/dashboard` | 概览：用户数、总用量、活跃用户 |
| `/users` | 用户列表：搜索、创建、编辑、禁用、软删除 |
| `/users/:id` | 用户详情：配额设置、用量明细 |

### 3.5 CORS 配置

Admin 服务需配置 CORS 允许 Polo AI WebUI 域名跨域调用 `/api/auth/login`：

```bash
# Admin 环境变量
CORS_ALLOWED_ORIGINS=http://localhost:9100,https://polo.example.com
```

仅 `/api/auth/login` 需要 CORS（前端直调）。其他 API（quota/check、quota/usage、admin/*）由 Polo AI Server 后端调用，不涉及 CORS。

---

## 4. Polo AI 改造

### 4.1 改造总览

```
改造点                              │ 影响范围
───────────────────────────────────┼──────────────────────────
新增：登录页 UI                     │ apps/webui
新增：POST /auth/session 端点       │ packages/server-core/src/webui/
新增：GET /api/config 端点          │ packages/server-core/src/webui/
改造：WebSocket upgrade 认证        │ packages/server-core/src/transport/
新增：Admin API 客户端              │ packages/shared/src/admin-api/
新增：pending_usage 本地队列        │ packages/shared/src/admin-api/
改造：消息发送流程（配额+用量）      │ packages/server-core/src/sessions/
改造：Agent 初始化（注入平台 Key）   │ packages/shared/src/agent/
改造：Onboarding（跳过 Key 配置）   │ packages/shared/src/auth/
改造：文件存储路径（按用户隔离）     │ packages/server-core/
新增：用户↔workspace 归属校验       │ packages/server-core/src/handlers/
隐藏：LLM 连接配置 UI              │ apps/webui
```

### 4.2 认证流程改造

#### 4.2.1 登录流程（统一链路）

```
用户打开 Polo AI WebUI
    │
    ▼
GET /api/config → 获取 { adminUrl }
    │
    ▼
显示登录页（用户名 + 密码）
    │
    ▼
前端 → POST {adminUrl}/api/auth/login   （直接调 Admin，跨域 CORS）
    │
    ▼ Admin 返回 { token: JWT, user: {...} }（JSON body，不设 cookie）
    │
前端 → POST Polo AI /auth/session { token: JWT }
    │
    ▼ Polo AI Server：
    │   1. 验证 JWT 签名（用 JWT_SECRET）
    │   2. 提取 userId, username, role
    │   3. 内存保存 JWT（与后续 WebSocket 连接关联）
    │   4. Set-Cookie: polo_session=<JWT>; HttpOnly; Secure; SameSite=Strict
    │
    ▼
WebSocket 连接建立（HTTP upgrade 自动带 polo_session cookie）
    │
    ▼ Polo AI Server 在 upgrade 阶段：
    │   1. 从 cookie 提取 JWT
    │   2. 验证签名 + 过期时间
    │   3. 提取 userId → 绑定到连接上下文
    │   4. 保存原始 JWT 用于后续调 Admin API
    │
    ▼
handshake message（只传 workspaceId，不再传 token）
    │
    ▼ 服务端校验 workspaceId 归属 userId
    │
    ▼
进入主界面
```

#### 4.2.2 Polo AI 新增 HTTP 端点

**GET /api/config** — 前端获取配置

```
Response 200:
{
  "adminUrl": "http://localhost:3001",
  "platformMode": true
}
```

来源：`ADMIN_API_URL` 环境变量。`platformMode` 由 `PLATFORM_ANTHROPIC_API_KEY` 是否存在决定。

**POST /auth/session** — 设置登录会话

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

**关键改造文件：**
- `packages/server-core/src/webui/http-server.ts` — 新增 /api/config 和 /auth/session 路由
- `packages/server-core/src/webui/auth.ts` — JWT 验证逻辑复用

#### 4.2.3 WebSocket 认证改造

**当前 handshake：**
```typescript
{
  type: 'handshake',
  protocolVersion: '1.0',
  token: 'POLO_AI_SERVER_TOKEN',
  workspaceId: 'ws-1'
}
```

**改造后：**

认证从 handshake message 移到 HTTP upgrade 阶段：

```typescript
// HTTP upgrade 阶段（server.ts）
onUpgrade(request) {
  // 1. 从 cookie 提取 JWT
  const jwt = parseCookie(request.headers.cookie, 'polo_session');

  // 2. 验证 JWT
  if (jwt) {
    const payload = verifyJwt(jwt, JWT_SECRET);
    // 绑定到 WebSocket 上下文
    return { userId: payload.sub, username: payload.username, role: payload.role, jwt };
  }

  // 3. Fallback: 检查 POLO_AI_SERVER_TOKEN（本地开发/服务间通信）
  const token = request.headers['x-server-token'];
  if (token === POLO_AI_SERVER_TOKEN) {
    return { userId: null, username: 'system', role: 'admin', jwt: null };
  }

  // 4. 拒绝连接
  return reject(401);
}

// handshake message（不再承担认证）
{
  type: 'handshake',
  protocolVersion: '1.1',
  workspaceId: 'ws-1'    // 仅传 workspaceId
}

// handshake_ack
{
  type: 'handshake_ack',
  clientId: 'uuid',
  userId: 'user-uuid',
  username: 'alice',
  registeredChannels: [...]
}
```

**关键改造文件：**
- `packages/server-core/src/transport/server.ts` — upgrade 阶段认证 + handshake 简化
- `packages/server-core/src/transport/types.ts` — 连接上下文类型

**向后兼容**：保留 `POLO_AI_SERVER_TOKEN` 通过 HTTP header 认证（用于服务间通信和本地开发）。

#### 4.2.4 RequestContext 扩展

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

### 4.3 用户隔离改造

#### 4.3.1 文件存储路径

**当前**：`~/.polo-ai/workspaces/{wsId}/`

**改造后**：`~/.polo-ai/users/{userId}/workspaces/{wsId}/`

平台模式下所有 workspace 数据按 userId 隔离存储。workspace 关联 `owner_user_id`。

#### 4.3.2 Workspace 归属校验

Workspace 元数据增加 `owner_user_id` 字段：

```typescript
interface WorkspaceMeta {
  id: string;
  name: string;
  owner_user_id: string;  // 新增
  // ...
}
```

**校验规则**：所有 workspace/session 相关的 RPC handler 在执行前校验 `ctx.userId === workspace.owner_user_id`。

```typescript
function assertWorkspaceAccess(ctx: RequestContext, workspace: WorkspaceMeta) {
  if (ctx.userId && workspace.owner_user_id !== ctx.userId) {
    throw new ForbiddenError('无权访问此 workspace');
  }
}
```

需要加校验的 RPC handler（非穷举）：
- `sessions:*`（sendMessage, getSession, listSessions 等）
- `workspace:*`（getWorkspace, updateWorkspace 等）
- `files:*`（读写 workspace 内文件）

#### 4.3.3 自动创建 Workspace

用户首次通过 WebSocket 连接且未指定 workspaceId 时，自动创建以 username 命名的 workspace：

```typescript
if (!workspaceId && ctx.userId) {
  const ws = await workspaceManager.findOrCreate({
    name: ctx.username,
    owner_user_id: ctx.userId,
  });
  workspaceId = ws.id;
}
```

### 4.4 消息发送流程改造

#### 当前流程

```typescript
async function handleSendMessage(ctx, sessionId, message) {
  const session = sessionManager.getSession(sessionId);
  // → agent.chat(message) → 本地凭据 API Key → Claude
}
```

#### 改造后

```typescript
async function handleSendMessage(ctx, sessionId, message) {
  // 1. 检查 workspace 归属
  assertWorkspaceAccess(ctx, session.workspace);

  // 2. 检查用户配额（Admin remaining - 本地 pending）
  const adminRemaining = await adminApiClient.checkQuota(ctx.userJwt);
  const localPending = pendingUsageStore.getPendingTokens(ctx.userId);
  const effectiveRemaining = adminRemaining.remaining - localPending;

  if (!adminRemaining.allowed || effectiveRemaining <= 0) {
    throw new QuotaExceededError({ ...adminRemaining, effectiveRemaining });
  }

  // 3. 生成 requestId（用于幂等上报）
  const requestId = generateRequestId();

  // 4. 调用 LLM（平台 Key）
  const session = sessionManager.getSession(sessionId);
  const result = await session.sendMessage(message);
  // → result 在 agent turn 完成后通过回调获取 usage

  return { accepted: true, requestId };
}

// agent turn 完成回调（异步，不阻塞用户）
agent.onTurnComplete((turnResult) => {
  const usage = turnResult.usage; // { inputTokens, outputTokens }
  const totalTokens = usage.inputTokens + usage.outputTokens;

  // 5. 写入本地 pending
  pendingUsageStore.add({
    requestId,
    userId: ctx.userId,
    sessionId,
    model: turnResult.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  });

  // 6. 异步上报到 Admin
  adminApiClient.reportUsage(ctx.userJwt, {
    requestId,
    sessionId,
    model: turnResult.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  }).then(() => {
    // 上报成功，清除 pending
    pendingUsageStore.remove(requestId);
  }).catch(() => {
    // 上报失败，pending 保留，后台重试
    pendingUsageStore.markRetry(requestId);
  });
});
```

#### 关键改造文件

| 文件 | 改造内容 |
|------|----------|
| `packages/server-core/src/handlers/rpc/sessions.ts` | sendMessage 增加归属校验、配额检查 |
| `packages/shared/src/agent/claude-agent.ts` | postInit() 读平台环境变量；onTurnComplete 回调捕获 usage |
| `packages/shared/src/config/llm-connections.ts` | resolveAuthEnvVars() 增加平台 Key 模式 |

### 4.5 API Key 注入改造

#### 当前流程

```
resolveAuthEnvVars()
  → credentialManager.getLlmApiKey(slug)
  → 设置 process.env.ANTHROPIC_API_KEY
```

#### 改造后

```
resolveAuthEnvVars()
  → 检查 PLATFORM_ANTHROPIC_API_KEY 环境变量
  → 存在（平台模式）：直接使用，不读本地凭据库
  → 不存在（本地模式）：走原有流程
```

### 4.6 Onboarding / UX 简化（MVP-1 仅 WebUI）

**当前**：首次启动 → 配置 API Key 或 OAuth → 选择模型 → 创建 workspace → 开始使用

**改造后**：登录 → 自动创建 workspace → 直接进入对话页面

**具体改动：**

1. **跳过 API Key 配置**：`getSetupNeeds()` 检测到 `PLATFORM_ANTHROPIC_API_KEY` 时返回 `isFullyConfigured: true`
2. **隐藏 LLM 连接管理 UI**：平台模式下不显示 LLM 连接配置页面
3. **自动 workspace**：首次登录自动创建（见 §4.3.3）
4. **配额显示**：WebUI 顶栏显示当前用户配额使用情况（调 `GET /api/quota/status`）

**改造文件：**
- `packages/shared/src/auth/state.ts` — getSetupNeeds() 增加平台模式判断
- `packages/server-core/src/handlers/rpc/onboarding.ts` — 平台模式下简化流程
- WebUI 前端 — 登录页、隐藏 LLM 配置入口、配额显示组件

---

## 5. 新增模块

### 5.1 Admin API Client

**位置**：`packages/shared/src/admin-api/client.ts`

```typescript
interface AdminApiClient {
  login(username: string, password: string): Promise<LoginResult>;
  checkQuota(jwt: string, estimatedTokens?: number): Promise<QuotaCheckResult>;
  reportUsage(jwt: string, usage: UsageReport): Promise<UsageReportResult>;
  getQuotaStatus(jwt: string): Promise<QuotaStatus>;
}

interface QuotaCheckResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  used: number;
  period: string;
}

interface UsageReport {
  requestId: string;    // 幂等键
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
```

**实现要点：**
- HTTP 客户端用 `fetch`（Bun 原生支持）
- 超时：配额检查 3s，用量上报 5s
- Admin API URL 来自 `ADMIN_API_URL` 环境变量

### 5.2 Pending Usage Store

**位置**：`packages/shared/src/admin-api/pending-usage.ts`
**存储**：`~/.polo-ai/pending-usage.jsonl`

```typescript
interface PendingUsageEntry {
  requestId: string;
  userId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;       // ISO 时间戳
  retryCount: number;
}

interface PendingUsageStore {
  add(entry: PendingUsageEntry): void;
  remove(requestId: string): void;
  markRetry(requestId: string): void;
  getPendingTokens(userId: string): number;  // 该用户未上报的 token 总量
  getPendingEntries(): PendingUsageEntry[];  // 所有待重试条目
}
```

**行为：**
- `add()`：追加写入 JSONL 文件
- `remove()`：标记为已处理（或从文件移除）
- `getPendingTokens(userId)`：汇总该用户所有未上报条目的 token 总量
- 启动时加载所有未处理条目到内存
- 后台定时重试（每 30s），最多 3 次，失败后仍保留（不丢弃，等待手动排查或 Admin 恢复后自动成功）

---

## 6. 安全设计

### 6.1 密码存储

| 层级 | 方案 |
|------|------|
| Admin（PostgreSQL） | argon2id 哈希 |
| Polo AI 本地 | 不存储密码，只存储 JWT（HttpOnly cookie） |

### 6.2 JWT 安全

- 过期时间：24 小时
- 签名算法：HS256（Admin 和 Polo AI 共享 `JWT_SECRET`）
- 存储：Polo AI 域名下的 HttpOnly cookie（`polo_session`）
- 传输：HTTP upgrade 时自动带 cookie，之后连接期间无需重复发送
- 刷新：MVP-1.5 实现，JWT 过期前 1 小时可刷新

### 6.3 平台 API Key 保护

- 存储位置：Polo AI 服务端环境变量，永不传给前端
- 日志：禁止记录包含 Key 的请求/响应
- 用户隔离：虽然用同一个 Key，但通过 userId 追踪用量和配额

### 6.4 限流

| 端点 | 限制 |
|------|------|
| POST /api/auth/login | 5 次/分钟/IP |
| POST /api/quota/check | 60 次/分钟/用户 |
| POST /api/quota/usage | 60 次/分钟/用户 |

---

## 7. 部署架构

### 7.1 MVP 部署（Docker Compose）

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: polo_admin
      POSTGRES_USER: polo
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  admin:
    build: ./polo-admin
    environment:
      DATABASE_URL: postgresql://polo:${DB_PASSWORD}@postgres:5432/polo_admin
      JWT_SECRET: ${JWT_SECRET}
      ADMIN_USERNAME: ${ADMIN_USERNAME}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD}
      CORS_ALLOWED_ORIGINS: http://localhost:9100
    ports:
      - "3001:3000"
    depends_on:
      - postgres

  polo-server:
    build: ./polo-ai
    environment:
      PLATFORM_ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      ADMIN_API_URL: http://admin:3000
      JWT_SECRET: ${JWT_SECRET}
      POLO_AI_RPC_PORT: 9100
      POLO_AI_RPC_HOST: 0.0.0.0
    volumes:
      - polo-data:/root/.polo-ai
    ports:
      - "9100:9100"
    depends_on:
      - admin

volumes:
  pgdata:
  polo-data:
```

### 7.2 环境变量清单

**Polo AI Server：**
```bash
PLATFORM_ANTHROPIC_API_KEY=sk-ant-xxx   # 平台 Anthropic API Key
ADMIN_API_URL=http://localhost:3001      # Admin 服务地址
JWT_SECRET=xxx                           # JWT 签名密钥（与 Admin 共享）
POLO_AI_RPC_PORT=9100
POLO_AI_RPC_HOST=127.0.0.1
```

**Admin 服务：**
```bash
JWT_SECRET=xxx                           # JWT 签名密钥（与 Polo AI 共享）
DATABASE_URL=postgresql://user:pass@localhost:5432/polo_admin
ADMIN_USERNAME=admin                     # 初始超管账号
ADMIN_PASSWORD=xxx                       # 初始超管密码（启动时自动创建）
CORS_ALLOWED_ORIGINS=http://localhost:9100  # 允许跨域的 Polo AI 域名
```

**超管自动创建逻辑**：Admin 服务启动时检查 users 表是否存在 role='admin' 的用户，不存在则用 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 创建。已存在则跳过。

---

## 8. 数据流详解

### 8.1 用户登录（完整流程）

```
WebUI 前端                        Polo AI Server              Admin API
    │                                    │                            │
    │  1. GET /api/config                │                            │
    │───────────────────────────────────>│                            │
    │  { adminUrl: "..." }              │                            │
    │<───────────────────────────────────│                            │
    │                                    │                            │
    │  2. POST {adminUrl}/api/auth/login │                            │
    │  { username, password }            │                            │
    │────────────────────────────────────────────────────────────────>│
    │                                    │                            │ 3. 验证密码
    │  4. { token: JWT, user: {...} }    │                            │    检查 status
    │<────────────────────────────────────────────────────────────────│    签发 JWT
    │                                    │                            │
    │  5. POST /auth/session             │                            │
    │  { token: JWT }                    │                            │
    │───────────────────────────────────>│                            │
    │                                    │ 6. 验证 JWT 签名            │
    │                                    │    提取 userId              │
    │  7. Set-Cookie: polo_session=JWT   │    保存 JWT                 │
    │  { user: {...} }                   │                            │
    │<───────────────────────────────────│                            │
    │                                    │                            │
    │  8. WebSocket upgrade              │                            │
    │  (cookie 自动带 polo_session)       │                            │
    │───────────────────────────────────>│                            │
    │                                    │ 9. 从 cookie 提取 JWT       │
    │                                    │    验证签名 + 提取 userId    │
    │                                    │    绑定到连接上下文           │
    │                                    │                            │
    │  10. handshake { workspaceId }     │                            │
    │───────────────────────────────────>│                            │
    │                                    │ 11. 校验 workspace 归属      │
    │                                    │     或自动创建              │
    │  12. handshake_ack                 │                            │
    │  { clientId, userId, username }    │                            │
    │<───────────────────────────────────│                            │
    │                                    │                            │
    │  13. 进入主界面                     │                            │
```

### 8.2 发消息 + 配额检查（完整流程）

```
WebUI 前端                    Polo AI Server                      Admin API
  │                                  │                                   │
  │ sessions:sendMessage             │                                   │
  │ { sessionId, content }           │                                   │
  │─────────────────────────────────>│                                   │
  │                                  │ 1. 校验 workspace 归属             │
  │                                  │                                   │
  │                                  │ 2. POST /api/quota/check          │
  │                                  │    Auth: Bearer <user-jwt>        │
  │                                  │──────────────────────────────────>│
  │                                  │                                   │ 检查 user.status
  │                                  │    { allowed, remaining }         │ 检查当月用量
  │                                  │<──────────────────────────────────│
  │                                  │                                   │
  │                                  │ 3. effectiveRemaining =           │
  │                                  │    remaining - localPending       │
  │                                  │    if <= 0 → 拒绝                 │
  │                                  │                                   │
  │                                  │ 4. 调用 Claude SDK                │
  │                                  │    (PLATFORM_ANTHROPIC_API_KEY)   │
  │                                  │                                   │
  │  session:event (流式消息)         │                                   │
  │<─────────────────────────────────│                                   │
  │  ...流式传输...                   │                                   │
  │                                  │                                   │
  │                                  │ 5. agent turn 完成回调             │
  │                                  │    捕获 usage (inputTokens,       │
  │                                  │    outputTokens)                  │
  │                                  │                                   │
  │                                  │ 6. 写入本地 pending_usage         │
  │                                  │                                   │
  │                                  │ 7. POST /api/quota/usage          │
  │                                  │    { requestId, inputTokens,      │
  │                                  │      outputTokens }               │
  │                                  │──────────────────────────────────>│
  │                                  │                                   │ 幂等检查 requestId
  │                                  │    { recorded: true }             │ 更新 quota_periods
  │                                  │<──────────────────────────────────│
  │                                  │                                   │
  │                                  │ 8. 上报成功 → 清除 pending        │
  │                                  │    上报失败 → 保留 pending + 重试  │
```

---

## 9. 错误处理

### 9.1 配额不足

用户发消息时配额不足（Admin 返回 allowed=false 或 effectiveRemaining <= 0），Polo AI 应：
1. 返回友好的错误消息
2. 告知剩余配额和重置时间
3. 不消耗任何 token

```
"您本月的使用额度已用完。配额将在下月 1 日重置。如需更多额度，请联系管理员。"
```

### 9.2 Admin API 不可用

1. 配额检查失败 → 拒绝发送消息，显示"服务暂时不可用"
2. 用量上报失败 → 写入本地 pending_usage，后台重试
3. 不 fallback 到无配额检查模式（安全考虑）
4. pending_usage 参与后续配额判断，防止"免费额度窗口"

### 9.3 JWT 过期

1. WebSocket 连接中 JWT 过期：不断开连接（已建立的连接不需要重新认证）
2. 调 Admin API 返回 401：MVP-1 通知前端重新登录；MVP-1.5 实现自动刷新
3. cookie 过期：浏览器自动不再发送，WebSocket 断开重连时需要重新登录

### 9.4 用户被禁用

1. 已连接的 WebSocket 不主动断开
2. 下次发消息时，配额检查返回 403 → 前端显示"账号已被禁用"并跳转到登录页
3. 刷新 token 被拒绝

---

## 10. 实现顺序（MVP-1）

### Phase 1: Admin 项目搭建

1. 初始化 Next.js 项目 + PostgreSQL + Prisma
2. 实现数据模型（users, usage_records, quota_periods, admin_audit_logs）
3. 超管自动创建逻辑（环境变量检测）
4. 实现 POST /api/auth/login（JWT 签发，status 检查）
5. 实现 POST /api/admin/users（创建用户 + 审计日志）
6. 实现 GET /api/admin/users（用户列表，过滤 deleted）
7. 实现 PATCH /api/admin/users/:id（更新/禁用 + 审计日志）
8. 实现 DELETE /api/admin/users/:id（软删除 + 审计日志）
9. 配置 CORS

### Phase 2: Admin 配额 API

10. 实现 POST /api/quota/check（status 检查 + 乐观配额判断）
11. 实现 POST /api/quota/usage（幂等上报 + requestId）
12. 实现 GET /api/quota/status
13. 实现 GET /api/admin/users/:id/usage
14. 实现 GET /api/admin/usage/overview

### Phase 3: Polo AI 认证层

15. 新增 GET /api/config 端点
16. 新增 POST /auth/session 端点（JWT 验证 + cookie 设置）
17. 改造 WebSocket upgrade 认证（cookie 读取）
18. 扩展 RequestContext（userId, userJwt）
19. 改造文件存储路径（按 userId 隔离）
20. 实现 workspace 归属校验 + 自动创建
21. 新增 WebUI 登录页

### Phase 4: LLM 调用 + 配额

22. 改造 resolveAuthEnvVars() 支持平台 Key 模式
23. 改造 onboarding 跳过 API Key 配置
24. 新增 Admin API Client
25. 新增 pending_usage store
26. 改造 sendMessage（配额检查 + 归属校验）
27. 实现 agent turn 完成回调捕获 usage
28. 实现异步用量上报 + pending 重试
29. 隐藏 LLM 连接配置 UI
30. WebUI 配额显示组件

### Phase 5: Admin 管理界面

31. Admin 登录页
32. 用户管理页（列表 + CRUD + 禁用 + 软删除）
33. 用户详情页（配额设置 + 用量明细）
34. 仪表盘概览页

### Phase 6: Docker Compose + 集成测试

35. 编写 docker-compose.yml
36. 端到端链路测试
37. 错误场景测试（配额不足、Admin 不可用、用户禁用）

---

## 11. 开放问题（后续决策）

| 问题 | 说明 | 建议时间 |
|------|------|----------|
| CLI login | CLI 通过 `polo login` 命令认证，token 存 `~/.polo-ai/auth.json` | MVP-1.5 |
| Electron 登录 | Electron 端内嵌登录流程 | MVP-1.5 |
| 修改密码 | 用户自助修改密码 | MVP-1.5 |
| JWT 自动刷新 | JWT 过期前自动刷新，前端无感知 | MVP-1.5 |
| 多模型计费 | 不同模型 token 加权计算（Opus=15x, Sonnet=1x） | MVP-2 |
| Workspace 多租户 | 用户间 workspace 共享/协作 | MVP-2 |
| API Access Token | 给第三方开发者的 API 密钥管理 | MVP-2 |
| 用量报表 | 按天/周/月的详细用量图表 | MVP-3 |
| 密码自助重置 | 邮件验证自助重置 | MVP-3 |
| 用户自带 Key | 高级用户绑定自己的 API Key | MVP-3 |
| 审计日志 UI | Admin 后台可视化审计日志 | MVP-3 |
| 数据库迁移 | Session 数据从文件迁移到数据库 | 视用户量决定 |

---

## 附录 A: 当前代码关键路径参考

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
| 协议定义 | `packages/shared/src/protocol/channels.ts` | RPC channel 定义 |
| 类型定义 | `packages/core/src/types/` | Session, Message 等 |

## 附录 B: Admin 项目初始结构

```
polo-admin/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/
│   │   │   │   ├── login/route.ts
│   │   │   │   ├── refresh/route.ts          # MVP-1.5
│   │   │   │   └── change-password/route.ts  # MVP-1.5
│   │   │   ├── admin/
│   │   │   │   ├── users/route.ts
│   │   │   │   ├── users/[id]/route.ts
│   │   │   │   ├── users/[id]/usage/route.ts
│   │   │   │   └── usage/overview/route.ts
│   │   │   └── quota/
│   │   │       ├── check/route.ts
│   │   │       ├── usage/route.ts
│   │   │       └── status/route.ts
│   │   ├── (admin)/
│   │   │   ├── layout.tsx
│   │   │   ├── dashboard/page.tsx
│   │   │   ├── users/page.tsx
│   │   │   └── users/[id]/page.tsx
│   │   └── login/page.tsx
│   ├── lib/
│   │   ├── db.ts                  # Prisma client
│   │   ├── auth.ts                # JWT 签发/验证
│   │   ├── audit.ts               # 审计日志写入
│   │   └── middleware.ts          # 认证中间件
│   └── types/
│       └── index.ts
├── prisma/
│   └── schema.prisma
├── package.json
├── next.config.ts
├── tailwind.config.ts
├── Dockerfile
└── .env.local
```

## 附录 C: v1.1 → v2.0 变更摘要

| 原 v1.1 问题 | v2.0 解决方案 |
|---------------|--------------|
| 用户隔离推迟到 MVP-2 | userId 绑定 workspace + 文件路径按用户隔离 + RPC 归属校验（§4.3） |
| 认证链路分叉（前端直调 vs Server 代理） | 统一为：前端直调 Admin 拿 JWT body → Polo AI 设 HttpOnly cookie（§4.2.1） |
| 配额 check+usage 非原子，并发超额 | 乐观检查 + 软超额容忍 + 本地 pending 参与判断（§4.4, §5.2） |
| 用量上报假设 sendMessage 同步返回 usage | 改为 agent turn 完成事件回调捕获（§4.4） |
| 上报失败产生免费额度窗口 | 本地 pending_usage (JSONL) 参与配额判断（§5.2） |
| 禁用用户 JWT 仍有效 | 配额检查时校验 user.status，disabled 返回 403（§3.3） |
| MVP 范围前后不一致 | MVP-1 收窄为仅 WebUI，新增 MVP-1.5 补全入口（§2.3） |
| 平台模式下其他凭据未隔离 | 文件路径按 userId 隔离，自然覆盖所有 workspace 数据（§4.3.1） |
| 缺少审计字段 | 新增 admin_audit_logs 表（§3.1） |
| DELETE users 与外键冲突 | 改为软删除 status='deleted'（§3.2.3） |
