# Polo AI 多用户改造 + Admin 管理后台 — 技术规范

> **版本**: v1.1 | **日期**: 2026-06-03 | **状态**: 待评审
> **受众**: 开发团队

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
4. **MVP 优先**：先跑通基础链路，不做过度设计

### 1.3 验收标准（MVP 端到端链路）

```
Admin 创建账号（设用户名+密码+月配额）
    → 用户在 Polo AI 登录（用户名+密码）
    → 用户发消息
    → 系统检查用户配额（调 Admin API）
    → 配额充足 → 用平台 Key 调 Claude → 返回回复 → 上报用量
    → 配额不足 → 拒绝并提示用户
    → Admin 后台可查看各用户用量
```

---

## 2. 整体架构

### 2.1 系统组成

```
┌──────────────────────────────────────────────────────────┐
│                    用户侧（Polo AI）                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Electron │  │  WebUI   │  │   CLI    │  │ Headless │ │
│  │  桌面端   │  │  浏览器端 │  │  命令行  │  │  Server  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       └──────────────┴─────────────┴─────────────┘       │
│                         │ WebSocket RPC                   │
│              ┌──────────▼──────────┐                      │
│              │  Polo AI 服务端       │◄─── 平台 API Key    │
│              │  (Bun + TypeScript) │     (环境变量)        │
│              └──────────┬──────────┘                      │
└─────────────────────────│────────────────────────────────┘
                          │ REST API（透传用户 JWT）
                          ▼
┌──────────────────────────────────────────────────────────┐
│                 Admin 管理后台（新项目）                     │
│  ┌──────────────────┐  ┌─────────────────────────────┐   │
│  │   Next.js 前端    │  │      Next.js API Routes     │   │
│  │  （超级管理员界面） │  │  /api/auth/*  /api/users/*  │   │
│  │                  │  │  /api/quota/*  /api/usage/*  │   │
│  └──────────────────┘  └──────────┬──────────────────┘   │
│                                   │                       │
│                          ┌────────▼────────┐              │
│                          │   PostgreSQL    │              │
│                          │  users, quotas, │              │
│                          │  usage_records  │              │
│                          └─────────────────┘              │
└──────────────────────────────────────────────────────────┘
```

### 2.2 关键设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| Admin 技术栈 | Next.js + PostgreSQL | 团队熟悉，前后端一体，快速开发 |
| 服务间通信 | Admin 暴露 REST API | 简单直接，Polo AI 调 Admin 做鉴权和配额 |
| 服务间鉴权 | 透传用户 JWT | Admin 签发 JWT，Polo AI 透传，Admin 自己验证用户身份 |
| 用户登录方式 | 用户名 + 密码（Admin 创建账号） | MVP 最简，无需邮件服务 |
| LLM 调用模式 | 平台统一 Key + 调前检查配额 | Key 存 Polo AI 环境变量，调前问 Admin 配额是否充足 |
| 配额粒度 | 按 LLM token 数（input + output） | 精确计量，按月重置 |
| Polo AI 存储 | 继续文件存储（JSONL/JSON） | MVP 最小改动 |
| Workspace 多租户 | MVP 不做 | 后期需求明确后再设计 |
| 入口 | 保留全部（Electron、WebUI、CLI、Headless） | 全面支持，认证层统一加在 WebSocket handshake |

### 2.3 交付阶段

| 阶段 | 范围 | 说明 |
|------|------|------|
| **MVP-1** | 登录 + 发消息 + 配额检查/扣减 + 修改密码 + Admin 查看用量 | 端到端链路跑通 |
| MVP-2 | API Access Token 管理 | 给第三方/开发者调用的 API 密钥 |
| MVP-3 | 高级 Admin 功能（报表、多模型、密码重置等） | 完善运营工具 |

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
  status        VARCHAR(16) DEFAULT 'active', -- 'active' | 'disabled'
  monthly_quota_tokens BIGINT NOT NULL DEFAULT 0, -- 每月 token 配额（input+output 合计）
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
```

#### usage_records 表

```sql
CREATE TABLE usage_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  session_id      VARCHAR(128),               -- Polo AI session ID
  model           VARCHAR(64),                -- 使用的模型（claude-sonnet-4-20250514 等）
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_usage_user_month ON usage_records (user_id, created_at);
```

#### quota_periods 表（月度配额周期追踪）

```sql
CREATE TABLE quota_periods (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id),
  period      VARCHAR(7) NOT NULL,            -- '2026-06' 格式
  used_tokens BIGINT NOT NULL DEFAULT 0,      -- 当月已用
  quota_limit BIGINT NOT NULL,                -- 当月配额上限（创建时从 users.monthly_quota_tokens 拷贝）
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, period)
);
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
  "token": "eyJhbGciOiJIUzI1NiIs...",  // JWT, 24h 过期
  "user": {
    "id": "uuid",
    "username": "alice",
    "displayName": "Alice",
    "role": "user"
  }
}

Response 401:
{ "error": "invalid_credentials", "message": "用户名或密码错误" }
```

**JWT Payload 结构：**
```json
{
  "sub": "user-uuid",
  "username": "alice",
  "role": "user",
  "iat": 1717300000,
  "exp": 1717386400
}
```

**POST /api/auth/refresh** — 刷新 token

```
Request:
Headers: { "Authorization": "Bearer <current-jwt>" }

Response 200:
{ "token": "eyJ..." }
```

**POST /api/auth/change-password** — 用户修改密码

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
  "estimatedTokens": 4000  // 预估本次消耗（可选，用于预检）
}

Response 200:
{
  "allowed": true,
  "remaining": 850000,     // 当月剩余 tokens
  "limit": 1000000,        // 当月配额
  "used": 150000,          // 当月已用
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
```

**POST /api/quota/usage** — LLM 调用后上报用量

```
Request:
Headers: { "Authorization": "Bearer <user-jwt>" }
{
  "sessionId": "session-uuid",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 1500,
  "outputTokens": 2500
}

Response 200:
{
  "recorded": true,
  "totalUsed": 154000,    // 更新后的当月已用
  "remaining": 846000
}
```

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

#### 3.2.3 Admin 用户管理 API（仅超级管理员）

**GET /api/admin/users** — 列出所有用户

```
Request:
Headers: { "Authorization": "Bearer <admin-jwt>" }
Query: ?page=1&limit=20&search=alice

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

**PATCH /api/admin/users/:id** — 更新用户（配额、状态、密码重置）

```
Request:
Headers: { "Authorization": "Bearer <admin-jwt>" }
{
  "monthlyQuotaTokens": 2000000,   // 可选：调整配额
  "status": "disabled",             // 可选：禁用/启用
  "password": "new-password",       // 可选：重置密码
  "displayName": "New Name"         // 可选
}

Response 200:
{ "id": "uuid", "username": "bob", ...updated fields }
```

**DELETE /api/admin/users/:id** — 删除用户

```
Response 204: (no content)
```

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
      "sessionId": "session-abc",
      "model": "claude-sonnet-4-20250514",
      "inputTokens": 800,
      "outputTokens": 1200,
      "createdAt": "2026-06-02T14:30:00Z"
    }
  ]
}
```

**GET /api/admin/usage/overview** — 全局用量概览（Admin 仪表盘）

```
Request:
Headers: { "Authorization": "Bearer <admin-jwt>" }
Query: ?period=2026-06

Response 200:
{
  "period": "2026-06",
  "totalUsers": 42,
  "activeUsers": 28,           // 当月有用量的用户数
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
| 密钥 | 环境变量 `JWT_SECRET`（Admin 和 Polo AI 需共享，或 Polo AI 调 Admin API 验证） |
| 过期时间 | 24 小时 |
| Payload | `{ sub, username, role, iat, exp }` |

**JWT 验证策略（两种方案，推荐 A）：**

- **方案 A（推荐）**：Admin 和 Polo AI 共享 `JWT_SECRET`。Polo AI 本地验证 JWT 签名，无需每次调 Admin API。性能好，但需要同步密钥。
- **方案 B**：Polo AI 不持有密钥，每次用 JWT 调 Admin API 时由 Admin 验证。简单但增加延迟。

### 3.4 Admin 前端页面（MVP）

| 页面 | 功能 |
|------|------|
| `/login` | Admin 登录（超管账号） |
| `/dashboard` | 概览：用户数、总用量、活跃用户 |
| `/users` | 用户列表：搜索、创建、编辑、禁用 |
| `/users/:id` | 用户详情：配额设置、用量明细、重置密码 |

---

## 4. Polo AI 改造

### 4.1 改造总览

```
改造点                              │ 影响范围
───────────────────────────────────┼──────────────────────────
新增：登录页 UI                     │ apps/webui, apps/electron
新增：认证中间件（WebSocket）         │ packages/server-core/src/transport/
新增：Admin API 客户端              │ packages/shared/src/auth/
修改：Agent 初始化（注入平台 Key）    │ packages/shared/src/agent/
修改：消息发送流程（配额检查）         │ packages/server-core/src/sessions/
修改：Onboarding 流程（跳过 Key 配置）│ packages/shared/src/auth/
隐藏：LLM 连接配置 UI               │ apps/webui, apps/electron
新增：CLI login 命令                │ apps/cli
```

### 4.2 认证流程改造

#### 4.2.1 登录流程

```
用户打开 Polo AI（WebUI/Electron/CLI）
    │
    ▼
显示登录页（用户名 + 密码）
    │
    ▼
Polo AI 前端 → POST Admin /api/auth/login
    │
    ▼ (JWT 返回)
存储 JWT（WebUI: cookie/localStorage, Electron: 内存+keychain, CLI: 配置文件）
    │
    ▼
建立 WebSocket 连接，handshake 时发送 JWT
    │
    ▼
Polo AI 服务端验证 JWT → 提取 userId → 绑定到 WebSocket 连接
    │
    ▼
进入主界面（跳过 onboarding，直接可发消息）
```

#### 4.2.2 WebSocket Handshake 改造

**当前 handshake：**
```typescript
// 客户端发送
{
  type: 'handshake',
  protocolVersion: '1.0',
  token: 'POLO_AI_SERVER_TOKEN',  // 所有用户共用
  workspaceId: 'ws-1'
}
```

**改造后：**
```typescript
// 客户端发送
{
  type: 'handshake',
  protocolVersion: '1.1',
  token: 'eyJhbGciOiJIUzI1NiIs...',  // 用户 JWT
  workspaceId: 'ws-1'
}

// 服务端验证
{
  type: 'handshake_ack',
  clientId: 'uuid',
  userId: 'user-uuid',                // 新增：从 JWT 提取
  username: 'alice',                   // 新增
  registeredChannels: [...]
}
```

**关键改造文件：**
- `packages/server-core/src/transport/server.ts` — handshake 验证逻辑
- `packages/server-core/src/transport/types.ts` — 连接上下文增加 userId

**向后兼容**：保留 `POLO_AI_SERVER_TOKEN` 作为 fallback（用于服务器间通信和本地开发模式）。验证顺序：
1. 尝试验证为 JWT → 提取 userId
2. 如果不是有效 JWT → 检查是否匹配 POLO_AI_SERVER_TOKEN → 以 admin 身份连接

#### 4.2.3 RequestContext 扩展

当前每个 RPC handler 收到的 context：
```typescript
interface RequestContext {
  clientId: string;
  workspaceId: string | null;
  webContentsId: number | null;
}
```

改造后：
```typescript
interface RequestContext {
  clientId: string;
  workspaceId: string | null;
  webContentsId: number | null;
  userId: string | null;      // 新增：用户 ID（从 JWT 提取）
  username: string | null;    // 新增：用户名
  userRole: 'admin' | 'user' | null;  // 新增：角色
}
```

### 4.3 消息发送流程改造

#### 当前流程（简化）

```typescript
// packages/server-core/src/handlers/rpc/sessions.ts
async function handleSendMessage(ctx, sessionId, message) {
  const session = sessionManager.getSession(sessionId);
  // → 直接调用 agent.chat(message)
  // → agent 用本地凭据库的 API Key 调 Claude
}
```

#### 改造后流程

```typescript
async function handleSendMessage(ctx, sessionId, message) {
  // 1. 检查用户配额
  const quotaResult = await adminApiClient.checkQuota(ctx.userJwt);
  if (!quotaResult.allowed) {
    throw new QuotaExceededError(quotaResult);
  }

  // 2. 调用 LLM（使用平台 Key，通过环境变量注入）
  const session = sessionManager.getSession(sessionId);
  const result = await session.sendMessage(message);

  // 3. 上报用量
  await adminApiClient.reportUsage(ctx.userJwt, {
    sessionId,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  });

  return result;
}
```

#### 关键改造文件

| 文件 | 改造内容 |
|------|----------|
| `packages/server-core/src/handlers/rpc/sessions.ts` | sendMessage 增加配额检查和用量上报 |
| `packages/shared/src/agent/claude-agent.ts` | postInit() 改为读取平台环境变量而非本地凭据库 |
| `packages/shared/src/config/llm-connections.ts` | resolveAuthEnvVars() 增加平台 Key 模式 |

### 4.4 API Key 注入改造

#### 当前流程

```
resolveAuthEnvVars()
  → credentialManager.getLlmApiKey(slug)  // 从本地加密文件读取
  → 设置 process.env.ANTHROPIC_API_KEY
```

#### 改造后

```
resolveAuthEnvVars()
  → 检查是否存在 PLATFORM_ANTHROPIC_API_KEY 环境变量
  → 如果存在（平台模式）：直接使用，不读本地凭据库
  → 如果不存在（本地模式/向后兼容）：走原有流程
```

**新增环境变量：**

```bash
# Polo AI 服务端
PLATFORM_ANTHROPIC_API_KEY=sk-ant-xxx  # 平台统一 Anthropic Key
ADMIN_API_URL=http://localhost:3001     # Admin 服务地址
JWT_SECRET=shared-secret-xxx            # JWT 验证密钥（与 Admin 共享）
```

### 4.5 Onboarding / UX 简化

**当前 onboarding 流程**：首次启动 → 配置 API Key 或 OAuth → 选择模型 → 创建 workspace → 开始使用

**改造后**：登录 → 自动创建/关联 workspace → 直接进入对话页面

**具体改动：**

1. **跳过 API Key 配置**：检测到平台模式（`PLATFORM_ANTHROPIC_API_KEY` 存在）时，`getSetupNeeds()` 直接返回 `isFullyConfigured: true`
2. **隐藏 LLM 连接管理 UI**：平台模式下不显示 LLM 连接配置页面
3. **自动 workspace**：用户首次登录时自动创建以 username 命名的 workspace
4. **配额显示**：在 UI 中显示当前用户的配额使用情况（调 `GET /api/quota/status`）

**改造文件：**
- `packages/shared/src/auth/state.ts` — getSetupNeeds() 增加平台模式判断
- `packages/server-core/src/handlers/rpc/onboarding.ts` — 平台模式下简化流程
- WebUI/Electron 前端 — 隐藏 LLM 连接配置入口

### 4.6 CLI 改造

```bash
# 新增 login 命令
polo login --server https://polo.example.com --admin-url https://admin.polo.example.com
> Username: alice
> Password: ****
> Login successful. Token saved to ~/.polo-ai/auth.json

# auth.json 格式
{
  "token": "eyJ...",
  "adminUrl": "https://admin.polo.example.com",
  "expiresAt": 1717386400
}
```

---

## 5. 新增模块：Admin API Client

### 5.1 位置

`packages/shared/src/admin-api/client.ts`

### 5.2 接口定义

```typescript
interface AdminApiClient {
  // 认证
  login(username: string, password: string): Promise<LoginResult>;
  refreshToken(jwt: string): Promise<string>;
  changePassword(jwt: string, currentPassword: string, newPassword: string): Promise<void>;

  // 配额
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
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
```

### 5.3 实现要点

- HTTP 客户端用 `fetch`（Bun 原生支持）
- 超时设置：配额检查 3s，用量上报 5s（异步，不阻塞用户）
- 用量上报失败时：本地缓存，后台重试（最多 3 次）
- JWT 过期自动刷新：中间件层面处理

---

## 6. 安全设计

### 6.1 密码存储

| 层级 | 方案 |
|------|------|
| Admin（PostgreSQL） | argon2id 哈希（通过 bcrypt 或 node:crypto） |
| Polo AI 本地 | 不存储密码，只存储 JWT |

### 6.2 JWT 安全

- 过期时间：24 小时
- 刷新机制：JWT 过期前 1 小时可刷新
- 签名算法：HS256（Admin 和 Polo AI 共享 `JWT_SECRET`）
- 传输：WebSocket handshake 时发送，之后连接期间无需重复发送

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

### 7.1 MVP 部署

```
单机部署：
├── Polo AI Server (Bun, port 9100)
│   ├── 环境变量: PLATFORM_ANTHROPIC_API_KEY, ADMIN_API_URL, JWT_SECRET
│   └── 数据: ~/.polo-ai/ (文件存储)
│
├── Admin (Next.js, port 3001)
│   ├── 环境变量: JWT_SECRET, DATABASE_URL
│   └── 数据: PostgreSQL (port 5432)
│
└── PostgreSQL (port 5432)
    └── Database: polo_admin
```

### 7.2 环境变量清单

**Polo AI Server：**
```bash
PLATFORM_ANTHROPIC_API_KEY=sk-ant-xxx   # 平台 Anthropic API Key
ADMIN_API_URL=http://localhost:3001      # Admin 服务地址
JWT_SECRET=xxx                           # JWT 签名密钥（与 Admin 共享）
POLO_AI_RPC_PORT=9100                      # WebSocket 端口
POLO_AI_RPC_HOST=127.0.0.1                # 绑定地址（0.0.0.0 允许远程访问）
```

**Admin 服务：**
```bash
JWT_SECRET=xxx                           # JWT 签名密钥（与 Polo AI 共享）
DATABASE_URL=postgresql://user:pass@localhost:5432/polo_admin
ADMIN_USERNAME=admin                     # 初始超管账号
ADMIN_PASSWORD=xxx                       # 初始超管密码
```

---

## 8. 数据流详解

### 8.1 用户登录（完整流程）

```
前端 (WebUI/Electron)                Polo AI Server              Admin API
       │                                    │                            │
       │  1. POST /api/auth/login           │                            │
       │  { username, password }            │                            │
       │───────────────────────────────────>│                            │
       │                                    │  2. POST /api/auth/login   │
       │                                    │  { username, password }    │
       │                                    │───────────────────────────>│
       │                                    │                            │ 3. 验证密码
       │                                    │  4. { token: JWT }         │    签发 JWT
       │                                    │<───────────────────────────│
       │  5. { token: JWT }                 │                            │
       │<───────────────────────────────────│                            │
       │                                    │                            │
       │  6. WebSocket handshake            │                            │
       │  { type:'handshake', token:JWT }   │                            │
       │───────────────────────────────────>│                            │
       │                                    │ 7. 验证 JWT（本地，用 JWT_SECRET）
       │                                    │    提取 userId, username, role
       │  8. handshake_ack                  │                            │
       │  { clientId, userId, username }    │                            │
       │<───────────────────────────────────│                            │
       │                                    │                            │
       │  9. 进入主界面，可发消息            │                            │
```

### 8.2 发消息 + 配额检查（完整流程）

```
前端                          Polo AI Server              Admin API
  │                                  │                            │
  │ sessions:sendMessage             │                            │
  │ { sessionId, content }           │                            │
  │─────────────────────────────────>│                            │
  │                                  │  POST /api/quota/check     │
  │                                  │  Auth: Bearer <user-jwt>   │
  │                                  │───────────────────────────>│
  │                                  │                            │ 检查当月用量
  │                                  │  { allowed: true,          │ < quota_limit
  │                                  │    remaining: 846000 }     │
  │                                  │<───────────────────────────│
  │                                  │                            │
  │                                  │ 调用 Claude SDK            │
  │                                  │ (PLATFORM_ANTHROPIC_API_KEY)
  │                                  │──────> Claude API ──────>  │
  │                                  │<────── response ────────<  │
  │                                  │                            │
  │  session:event (流式消息)         │                            │
  │<─────────────────────────────────│                            │
  │                                  │                            │
  │                                  │  POST /api/quota/usage     │
  │                                  │  { inputTokens: 1500,      │
  │                                  │    outputTokens: 2500 }    │
  │                                  │───────────────────────────>│
  │                                  │                            │ 记录用量
  │                                  │  { recorded: true }        │ 更新 quota_periods
  │                                  │<───────────────────────────│
```

---

## 9. 错误处理

### 9.1 配额不足

用户发消息时配额不足，Polo AI 应：
1. 返回友好的错误消息（不是技术错误）
2. 告知剩余配额和重置时间
3. 不消耗任何 token

```typescript
// 前端显示
"您本月的使用额度已用完。配额将在下月 1 日重置。如需更多额度，请联系管理员。"
```

### 9.2 Admin API 不可用

Polo AI 无法连接 Admin 服务时：
1. 配额检查失败 → 拒绝发送消息，显示"服务暂时不可用"
2. 用量上报失败 → 本地缓存，后台重试
3. 不应该 fallback 到无配额检查的模式（安全考虑）

### 9.3 JWT 过期

WebSocket 连接中 JWT 过期：
1. 不断开现有连接（连接已建立时不需要重新认证）
2. 调 Admin API 时如果返回 401，尝试刷新 token
3. 刷新失败 → 通知前端重新登录

---

## 10. 实现顺序（建议）

### Phase 1: Admin 项目搭建（独立项目）

1. 初始化 Next.js 项目 + PostgreSQL + Prisma/Drizzle
2. 实现数据模型（users, usage_records, quota_periods）
3. 实现 POST /api/auth/login（JWT 签发）
4. 实现 POST /api/admin/users（创建用户）
5. 实现 GET /api/admin/users（用户列表）
6. 创建初始超管账号（数据库 seed）

### Phase 2: Polo AI 认证层

7. 新增 Admin API Client（`packages/shared/src/admin-api/`）
8. 改造 WebSocket handshake 支持 JWT
9. 扩展 RequestContext 增加 userId
10. 新增 WebUI 登录页
11. 改造 onboarding 跳过 API Key 配置

### Phase 3: LLM 调用 + 配额

12. 改造 resolveAuthEnvVars() 支持平台 Key 模式
13. 实现配额检查（sendMessage 前调 Admin API）
14. 实现用量上报（sendMessage 后调 Admin API）
15. Admin 实现 quota/check 和 quota/usage 端点

### Phase 4: Admin 管理界面

16. Admin 登录页
17. 用户管理页（CRUD）
18. 用量查看页
19. 仪表盘概览

### Phase 5: 完善

20. CLI login 命令
21. Electron 登录集成
22. 用户修改密码
23. JWT 自动刷新
24. 错误处理和边界情况

---

## 11. 开放问题（后续决策）

| 问题 | 说明 | 建议时间 |
|------|------|----------|
| Workspace 多租户 | 用户和 workspace 的归属关系如何设计 | MVP-2 |
| 多模型支持 | 用户能否选择不同模型？不同模型配额如何计算？ | MVP-2 |
| API Access Token | 给第三方开发者的 API 密钥管理 | MVP-2 |
| 密码重置 | 管理员代替重置 vs 邮件自助重置 | MVP-3 |
| 用量报表 | 按天/周/月的详细用量图表 | MVP-3 |
| 用户自带 Key | 高级用户是否可以绑定自己的 API Key 绕过配额 | MVP-3 |
| 审计日志 | Admin 操作审计和用户行为日志 | MVP-3 |
| 数据库迁移 | Session 数据是否从文件迁移到数据库 | 视用户量决定 |

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
| 协议定义 | `packages/shared/src/protocol/channels.ts` | 432 个 RPC channel |
| 类型定义 | `packages/core/src/types/` | Session, Message 等 |

## 附录 B: Admin 项目初始结构（建议）

```
polo-admin/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/
│   │   │   │   ├── login/route.ts
│   │   │   │   ├── refresh/route.ts
│   │   │   │   └── change-password/route.ts
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
│   │   ├── db.ts                  # Prisma/Drizzle client
│   │   ├── auth.ts                # JWT 签发/验证
│   │   └── middleware.ts          # 认证中间件
│   └── types/
│       └── index.ts
├── prisma/
│   ├── schema.prisma
│   └── seed.ts                    # 初始超管账号
├── package.json
├── next.config.ts
└── .env.local
```