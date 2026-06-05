# Admin 管理后台 — 技术规范

> **版本**: v1.1 | **日期**: 2026-06-05 | **状态**: 待评审
> **仓库**: `polo-admin`（独立仓库）
> **对齐契约**: 见 `shared-contract.md`
> **上游总规**: 见 `spec.md`

---

## 1. 项目概述

Admin 管理后台是一个独立的 Web 应用，为 Polo AI 平台提供用户管理、配额管理、JWT 签发、用量记录和基础运营视图。

**核心职责：**
- 管理用户账号（创建、禁用、软删除、重置密码）
- 签发 JWT（供 Polo AI Server 本地验证）
- 管理月度 token 配额
- 接收并记录 Polo AI Server 上报的 token 用量
- 提供超级管理员使用的管理界面
- 记录 Admin 写操作审计日志（MVP-1 只写入，不展示）

**不负责：**
- LLM 调用（由 Polo AI Server 使用平台 Key 负责）
- WebSocket 连接管理
- Polo AI workspace、session、文件数据存储
- 普通用户自注册、找回密码、修改密码（MVP-1.5）
- CLI/Electron 登录入口（MVP-1.5）

**MVP-1 成功链路：**

```
Admin 创建账号（用户名 + 初始密码 + 月配额）
  -> 用户在 Polo AI WebUI 登录
  -> Admin 签发 JWT
  -> Polo AI Server 设置 HttpOnly cookie 并建立 WebSocket
  -> 用户发消息前 Polo AI Server 调 Admin quota/check
  -> 配额充足则调用 LLM
  -> agent turn 完成后 Polo AI Server 调 Admin quota/usage 上报用量
  -> Admin 后台可查看用户和用量
```

---

## 2. 技术栈

| 组件 | 选择 | 说明 |
|------|------|------|
| 框架 | Next.js App Router | 前后端一体，适合独立管理后台 |
| 运行时 | Node.js 20+ | Next.js 官方支持 |
| 数据库 | PostgreSQL 16 | 关系型数据、事务、聚合查询 |
| ORM | Prisma | Schema 和迁移工具成熟 |
| UI | shadcn/ui + Tailwind CSS | 管理后台组件效率高 |
| 表单校验 | zod | 请求和表单共享校验语义 |
| JWT | jose | HS256 签发和验证 |
| 密码哈希 | argon2（node-argon2） | 使用 argon2id |
| 部署 | Docker | 独立容器，可进入 Docker Compose |

---

## 3. 核心决策

| 决策项 | MVP-1 选择 |
|--------|------------|
| Admin 控制台会话 | 同域 HttpOnly cookie，不使用 localStorage |
| Polo AI 用户登录 | WebUI 前端跨域直调 Admin `/api/auth/login`，JWT 通过 JSON body 返回 |
| JWT 存储 | Admin 不给 Polo AI 域设置 cookie；Polo AI Server 自行设置 `polo_session` |
| 配额检查 | 乐观软超额：`allowed = remaining > 0`，不预留、不加锁 |
| `estimatedTokens` | 仅作为预检提示字段，不参与 Admin `allowed` 判定 |
| 月度周期 | 所有 `period = YYYY-MM` 按 UTC 月计算 |
| 配额变更 | 修改 `monthlyQuotaTokens` 后立即同步当前 UTC 月 `quotaPeriod.quotaLimit` |
| 0 配额 | 普通用户 `monthlyQuotaTokens=0` 表示无额度，不能发消息 |
| 用户删除 | 软删除，`deleted` 不可恢复、不释放 username |
| Admin 创建 | MVP-1 只通过环境变量自动创建初始超管 |
| Admin 用户管理 | UI/API 创建用户固定 `role=user`，不开放创建其他 admin |
| 自我保护 | 禁止 admin 禁用或删除自己 |
| 限流 | 单实例内存 Map + TTL，不引入 Redis |
| 审计 | 记录字段差异；密码只记 `passwordReset: true`，不记录明文或 hash |

---

## 4. 数据模型

### 4.1 Prisma Schema

```prisma
model User {
  id                 String   @id @default(uuid()) @db.Uuid
  username           String   @unique @db.VarChar(64)
  passwordHash       String   @db.VarChar(255)
  displayName        String?  @db.VarChar(128)
  role               String   @default("user") @db.VarChar(16)
  status             String   @default("active") @db.VarChar(16)
  monthlyQuotaTokens BigInt   @default(0)
  createdAt          DateTime @default(now()) @db.Timestamptz
  updatedAt          DateTime @updatedAt @db.Timestamptz

  usageRecords       UsageRecord[]
  quotaPeriods       QuotaPeriod[]
  auditLogsAsAdmin   AdminAuditLog[] @relation("AuditAdmin")
  auditLogsAsTarget  AdminAuditLog[] @relation("AuditTarget")

  @@map("users")
}

model UsageRecord {
  id           String   @id @default(uuid()) @db.Uuid
  userId       String   @db.Uuid
  requestId    String   @unique @db.VarChar(128)
  sessionId    String?  @db.VarChar(128)
  model        String?  @db.VarChar(64)
  inputTokens  Int      @default(0)
  outputTokens Int      @default(0)
  createdAt    DateTime @default(now()) @db.Timestamptz

  user         User     @relation(fields: [userId], references: [id])

  @@index([userId, createdAt])
  @@map("usage_records")
}

model QuotaPeriod {
  id         String   @id @default(uuid()) @db.Uuid
  userId     String   @db.Uuid
  period     String   @db.VarChar(7)
  usedTokens BigInt   @default(0)
  quotaLimit BigInt
  createdAt  DateTime @default(now()) @db.Timestamptz
  updatedAt  DateTime @updatedAt @db.Timestamptz

  user       User     @relation(fields: [userId], references: [id])

  @@unique([userId, period])
  @@map("quota_periods")
}

model AdminAuditLog {
  id            String   @id @default(uuid()) @db.Uuid
  adminUserId   String   @db.Uuid
  action        String   @db.VarChar(64)
  targetUserId  String?  @db.Uuid
  detail        Json?    @db.JsonB
  createdAt     DateTime @default(now()) @db.Timestamptz

  adminUser     User     @relation("AuditAdmin", fields: [adminUserId], references: [id])
  targetUser    User?    @relation("AuditTarget", fields: [targetUserId], references: [id])

  @@index([adminUserId, createdAt])
  @@index([targetUserId, createdAt])
  @@map("admin_audit_logs")
}
```

### 4.2 字段规则

**User**
- `username`: 3-64 字符，唯一；软删除后不释放，不允许重名复用。
- `passwordHash`: argon2id hash，永远不返回给 API 调用方。
- `role`: MVP-1 只有自动创建超管可为 `admin`；Admin UI/API 创建用户固定为 `user`。
- `status`: 只允许 `active`、`disabled`、`deleted`。
- `monthlyQuotaTokens`: 非负整数；普通用户为 `0` 时表示无额度。

**UsageRecord**
- `requestId`: 必填且唯一，用于幂等上报。
- `inputTokens` / `outputTokens`: 非负整数。
- 总用量按 `inputTokens + outputTokens` 计算；MVP-1 不做模型加权。

**QuotaPeriod**
- `period`: UTC 月份，格式 `YYYY-MM`。
- `quotaLimit`: 创建 period 时从 `users.monthlyQuotaTokens` 拷贝；管理员修改用户月配额时同步当前 UTC 月 period。
- `usedTokens`: 只通过 usage 上报累加，不因配额调整重置。

### 4.3 User Status 状态机

```
active -> disabled     Admin 禁用
disabled -> active     Admin 重新启用
active -> deleted      软删除（不可恢复）
disabled -> deleted    软删除（不可恢复）
```

- 登录时 `status` 必须为 `active`。
- `deleted` 等效永久禁用，不物理删除行。
- `deleted` 不可恢复，不释放 username。
- 禁止 admin 将自己的账号改为 `disabled` 或 `deleted`。

---

## 5. API 设计

所有 API 错误响应统一为：

```json
{
  "error": "error_code",
  "message": "人类可读的错误描述"
}
```

| error | HTTP | 触发条件 |
|-------|------|----------|
| `invalid_credentials` | 401 | 用户名不存在或密码错误 |
| `account_disabled` | 403 | 用户状态为 disabled 或 deleted |
| `unauthorized` | 401 | 缺少或无效 JWT / cookie |
| `forbidden` | 403 | 角色权限不足 |
| `validation_error` | 400 | 请求参数不合法 |
| `duplicate_request` | 409 | usage requestId 重复 |
| `username_taken` | 409 | username 已存在（含 deleted 用户） |
| `self_action_forbidden` | 403 | admin 尝试禁用或删除自己 |
| `not_found` | 404 | 目标资源不存在 |
| `rate_limited` | 429 | 超过限流阈值 |

### 5.1 认证 API

#### POST /api/auth/login

同一个登录能力服务两类调用方：
- Polo AI WebUI 跨域调用：返回 JWT JSON body，不设置 Admin cookie。
- Admin 控制台同域登录：返回成功后设置 Admin 同域 HttpOnly cookie。

调用方通过请求头区分场景：
- `X-Client: polo-webui`：跨域登录，只返回 JSON body。
- `X-Client: admin-console` 或缺省同域页面提交：设置 Admin cookie。

```
Request:
{
  "username": "alice",
  "password": "xxx"
}

Response 200:
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "uuid",
    "username": "alice",
    "displayName": "Alice",
    "role": "user"
  }
}
```

Admin 控制台登录成功时额外设置：

```
Set-Cookie: admin_session=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400
```

行为规则：
- 按 `username` 查找用户，验证 argon2id 密码。
- `active` 用户才能登录。
- `disabled` 返回 `403 account_disabled`。
- `deleted` 返回 `401 invalid_credentials`，避免泄漏历史账号存在性。
- JWT 使用 HS256，有效期 24 小时，payload 与 `shared-contract.md` 保持一致：`{ sub, username, role, iat, exp }`。
- 密码策略：MVP-1 最少 8 位，允许任意字符。

#### POST /api/auth/logout

仅 Admin 控制台使用。

```
Response 200:
Set-Cookie: admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0
{ "success": true }
```

#### POST /api/auth/refresh（MVP-1.5）

不在 MVP-1 实现。

#### POST /api/auth/change-password（MVP-1.5）

不在 MVP-1 实现。

### 5.2 配额 API

配额 API 由 Polo AI Server 调用，使用用户 JWT：

```
Authorization: Bearer <user-jwt>
```

#### POST /api/quota/check

```
Request:
{
  "estimatedTokens": 4000
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
```

行为规则：
- 从 JWT `sub` 提取 userId。
- 验证用户存在且 `status=active`；`disabled`/`deleted` 返回 `403 account_disabled`。
- 当前 period 按 UTC 月计算。
- 若当前 `quota_period` 不存在，响应按 `used=0`、`limit=user.monthlyQuotaTokens` 计算；允许实现选择只读不落库。
- `remaining = max(limit - used, 0)`。
- `allowed = remaining > 0`。
- `estimatedTokens` 不参与 Admin `allowed` 判定，仅保留给 Polo AI 侧提示或后续策略。
- 不加锁、不预留额度，允许最后一次调用软超额。

#### POST /api/quota/usage

```
Request:
{
  "requestId": "req-uuid",
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

行为规则：
- `requestId` 必填且唯一；重复上报返回 409，不重复计量。
- `inputTokens` 和 `outputTokens` 必须为非负整数。
- `total = inputTokens + outputTokens`。
- 在同一数据库事务中：
  - 确保当前 UTC 月 `quota_period` 存在，不存在则从 `users.monthlyQuotaTokens` 创建。
  - 插入 `usage_records`。
  - 原子更新 `quota_periods.usedTokens = usedTokens + total`。
- 上报不因配额已经超额而拒绝；真实用量必须被记录。

#### GET /api/quota/status

```
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

行为规则：
- 使用用户 JWT。
- 当前 period 按 UTC 月计算。
- breakdown 从 `usage_records` 聚合当前 UTC 月数据。

### 5.3 Admin 用户管理 API

Admin API 支持两种认证来源：
- `Authorization: Bearer <admin-jwt>`
- 同域 `admin_session` HttpOnly cookie

所有写操作必须写入 `admin_audit_logs`。

#### GET /api/admin/users

```
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

行为规则：
- 默认过滤 `deleted`。
- 仅显式 `status=deleted` 时查看 deleted 用户。
- `search` 匹配 username 和 displayName。
- `currentMonthUsed` 使用当前 UTC 月。
- `limit` 默认 20，最大 100。

#### POST /api/admin/users

```
Request:
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

行为规则：
- 创建用户固定 `role=user`，忽略或拒绝请求中的 `role`。
- `password` 最少 8 位。
- `monthlyQuotaTokens` 必须为非负整数。
- username 已存在时返回 `409 username_taken`，包括 deleted 用户。
- 写入审计 action=`create_user`。

#### PATCH /api/admin/users/:id

```
Request:
{
  "monthlyQuotaTokens": 2000000,
  "status": "disabled",
  "password": "new-password",
  "displayName": "New Name"
}

Response 200:
{
  "id": "uuid",
  "username": "bob",
  "displayName": "New Name",
  "role": "user",
  "status": "disabled",
  "monthlyQuotaTokens": 2000000
}
```

行为规则：
- 可更新字段：`displayName`、`monthlyQuotaTokens`、`status`、`password`。
- 禁止更新 `role`、`username`。
- `status` 只允许 `active` 或 `disabled`；删除必须使用 DELETE。
- 若目标用户是当前 admin 自己，禁止将 status 改为 `disabled`。
- 更新 `monthlyQuotaTokens` 时，同步当前 UTC 月 quota period：
  - period 存在：更新 `quotaLimit` 为新配额。
  - period 不存在：创建 period，`usedTokens=0`，`quotaLimit=新配额`。
- 重置密码时审计 detail 只记录 `{ "passwordReset": true }`。
- 写入审计 action 按主要变化归类：`update_user`、`disable_user`、`enable_user`、`reset_password`、`update_quota`。

#### DELETE /api/admin/users/:id

```
Response 200:
{ "id": "uuid", "status": "deleted" }
```

行为规则：
- 软删除：将 status 设为 `deleted`。
- 不物理删除用户、usage records、quota periods。
- 禁止删除当前 admin 自己。
- deleted 不可恢复。
- 写入审计 action=`delete_user`。

#### GET /api/admin/users/:id/usage

```
Query: ?period=2026-06&page=1&limit=50

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
  ],
  "total": 42,
  "page": 1,
  "limit": 50
}
```

行为规则：
- `period` 缺省为当前 UTC 月。
- MVP-1 展示记录表格，不做趋势图。
- `limit` 默认 50，最大 100。

#### GET /api/admin/usage/overview

```
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

行为规则：
- `period` 缺省为当前 UTC 月。
- `totalQuotaAllocated` 汇总当前 period 的 quotaLimit；不存在 period 的 active 用户按 `monthlyQuotaTokens` 计入。
- `topUsers` 默认返回前 10 名。

### 5.4 认证中间件

```typescript
async function requireAuth(request: NextRequest): Promise<JwtPayload>
async function requireAdmin(request: NextRequest): Promise<JwtPayload>
```

认证来源：
- 优先读取 `Authorization: Bearer <jwt>`。
- 若无 Authorization，则读取同域 cookie `admin_session`。

规则：
- 用 `JWT_SECRET` 验证 HS256 签名和过期时间。
- `requireAuth` 返回 payload。
- `requireAdmin` 额外要求 `role=admin`，否则返回 `403 forbidden`。
- Admin 写操作还应查询数据库确认 admin 用户仍为 `active`。

---

## 6. 管理界面（MVP-1）

### 6.1 页面列表

| 路由 | 功能 |
|------|------|
| `/login` | Admin 登录 |
| `/dashboard` | 用户数、活跃用户、总用量、总配额、Top 用户 |
| `/users` | 用户列表、搜索、筛选、创建、编辑、禁用、软删除 |
| `/users/:id` | 用户详情、配额设置、用量明细 |

### 6.2 UX 规则

**登录页**
- 使用用户名和密码登录。
- 成功后进入 `/dashboard`。
- 失败时展示统一错误，不泄漏 deleted 用户存在性。

**Dashboard**
- 使用统计卡片展示：总用户、活跃用户、当月总用量、当月总配额。
- 展示 Top users 表格。
- MVP-1 不做趋势图。

**用户列表**
- 采用运营密集型表格，一屏展示：
  - username
  - displayName
  - status
  - monthlyQuotaTokens
  - currentMonthUsed
  - createdAt
  - actions
- 支持 search、status filter、pagination。
- 默认隐藏 deleted；筛选 deleted 时只允许查看，不提供恢复。

**创建用户**
- 管理员手动输入 username、password、displayName、monthlyQuotaTokens。
- 创建成功后弹窗一次性展示 username 和初始密码，并提供复制按钮。
- 弹窗关闭后不再展示密码。

**编辑用户**
- 支持编辑 displayName、status、monthlyQuotaTokens。
- 支持重置密码；重置后一次性展示新密码。
- 配额调整保存后立即影响当前 UTC 月。

**危险操作**
- 删除用户必须输入 username 确认。
- 禁用用户和重置密码使用确认 Dialog。
- 禁止 admin 对自己执行禁用或删除操作，UI 按钮置灰并由 API 二次保护。

**用户详情**
- 展示基础信息、状态、月配额、当前 UTC 月 used/limit/remaining。
- 展示用量明细分页表格：requestId、sessionId、model、inputTokens、outputTokens、createdAt。
- MVP-1 不做图表。

### 6.3 UI 组件

使用 shadcn/ui：
- Table：用户列表、Top users、用量记录
- Dialog / AlertDialog：创建成功、删除确认、禁用确认、重置密码确认
- Form / Input / Select：创建和编辑用户
- Card：dashboard 指标卡
- Badge：用户状态
- Button：操作按钮，危险操作使用 destructive variant

---

## 7. 超管自动创建

启动时检查 users 表是否存在 `role='admin'` 的用户：
- 不存在：用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 创建超管。
- 已存在：跳过。

规则：
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` 缺失且无 admin 用户时，启动失败并输出明确错误。
- 初始超管 `status=active`。
- 初始超管 `monthlyQuotaTokens=0`；Admin 控制台账号不用于 Polo AI 发消息。
- MVP-1 不提供 UI 创建其他 admin。

```typescript
async function ensureSuperAdmin() {
  const adminCount = await prisma.user.count({ where: { role: 'admin' } })
  if (adminCount > 0) return

  const username = process.env.ADMIN_USERNAME
  const password = process.env.ADMIN_PASSWORD
  if (!username || !password) {
    throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD required when no admin user exists')
  }

  await prisma.user.create({
    data: {
      username,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      role: 'admin',
      status: 'active',
      monthlyQuotaTokens: 0n,
    },
  })
}
```

---

## 8. CORS

Admin 只需要允许 Polo AI WebUI 跨域调用 `/api/auth/login`。

```bash
CORS_ALLOWED_ORIGINS=http://localhost:9100,https://polo.example.com
```

规则：
- 只对 `/api/auth/login` 返回 CORS headers。
- allowed origins 来自 `CORS_ALLOWED_ORIGINS`，逗号分隔。
- 不允许 `*` 搭配凭据。
- quota API 和 admin API 由服务端或同域页面调用，不开放跨域。

---

## 9. 限流

MVP-1 使用单实例内存 Map + TTL，不引入 Redis。

| 端点 | 限制 | Key |
|------|------|-----|
| POST /api/auth/login | 5 次/分钟 | IP |
| POST /api/quota/check | 60 次/分钟 | userId |
| POST /api/quota/usage | 60 次/分钟 | userId |

规则：
- 超限返回 `429 rate_limited`。
- 内存限流重启后清空，可接受于 MVP 单实例部署。
- 多实例生产部署需在后续版本切换 Redis 或网关限流。

---

## 10. 安全与审计

**密码**
- 使用 argon2id。
- API 永不返回 passwordHash。
- 审计日志永不记录密码明文或 hash。
- MVP-1 密码策略：最少 8 位。

**JWT**
- HS256，`JWT_SECRET` 与 Polo AI Server 共享。
- 有效期 24 小时。
- payload：`sub`、`username`、`role`、`iat`、`exp`。
- Admin 控制台 cookie：`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`。

**审计日志**
- 所有 Admin 写操作必须插入 `admin_audit_logs`。
- `detail` 记录字段级差异，例如：

```json
{
  "changes": {
    "displayName": { "from": "Bob", "to": "Robert" },
    "monthlyQuotaTokens": { "from": 500000, "to": 2000000 }
  }
}
```

- 重置密码只记录：

```json
{
  "passwordReset": true
}
```

**自我保护**
- admin 不能禁用自己。
- admin 不能删除自己。
- API 层必须强制校验，不能只依赖 UI。

---

## 11. 项目结构

```
polo-admin/
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── auth/
│   │   │   │   ├── login/route.ts
│   │   │   │   └── logout/route.ts
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
│   ├── components/
│   │   ├── dashboard/
│   │   └── users/
│   ├── lib/
│   │   ├── audit.ts
│   │   ├── auth.ts
│   │   ├── cors.ts
│   │   ├── db.ts
│   │   ├── quota.ts
│   │   ├── rate-limit.ts
│   │   └── validation.ts
│   └── types/
│       └── index.ts
├── prisma/
│   └── schema.prisma
├── package.json
├── next.config.ts
├── tailwind.config.ts
├── Dockerfile
└── .env.example
```

---

## 12. 环境变量

```bash
JWT_SECRET=xxx
DATABASE_URL=postgresql://user:pass@localhost:5432/polo_admin
ADMIN_USERNAME=admin
ADMIN_PASSWORD=xxx
CORS_ALLOWED_ORIGINS=http://localhost:9100
NODE_ENV=production
```

规则：
- `JWT_SECRET` 必须与 Polo AI Server 一致。
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` 仅在无 admin 用户时使用。
- `.env.example` 不包含真实密钥。

---

## 13. Docker 部署

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
EXPOSE 3000
CMD ["node", "server.js"]
```

部署要求：
- 容器启动前需执行 Prisma migration。
- Admin 服务对外端口建议映射为 `3001:3000`。
- PostgreSQL 与 Admin 可通过 Docker Compose 内网通信。

---

## 14. 测试计划

### 14.1 Unit Tests

- JWT sign/verify、过期 token 拒绝。
- argon2 密码验证。
- UTC period 计算。
- quota check 软超额逻辑：`remaining > 0` 即 allowed。
- `monthlyQuotaTokens=0` 普通用户不能发消息。
- 配额变更同步当前 UTC 月 quotaLimit。
- audit detail 不包含密码明文或 hash。

### 14.2 API Integration Tests

使用 PostgreSQL 测试库。

- login 成功、密码错误、disabled、deleted。
- Admin cookie 登录和 Authorization Bearer 均可访问 Admin API。
- 创建用户固定 `role=user`。
- username 唯一，deleted 用户不释放 username。
- 用户列表默认隐藏 deleted，显式 `status=deleted` 可查看。
- admin 禁用/删除自己返回 `self_action_forbidden`。
- quota period 自动创建。
- usage 上报幂等，重复 requestId 返回 409 且不重复计量。
- usage 上报在已超额时仍记录真实用量。

### 14.3 UI / E2E Tests

使用 Playwright。

- Admin 登录进入 dashboard。
- 创建用户成功后一次性展示初始密码。
- 用户列表搜索、状态筛选、分页正常。
- 编辑配额后当前月详情立即显示新 limit。
- 删除用户必须输入 username。
- 禁用和重置密码需要确认。
- 用户详情用量明细表格正常渲染。

### 14.4 Deployment Checks

- Docker build 成功。
- PostgreSQL + Admin 启动成功。
- 缺少必要 env 时输出明确错误。
- `/api/auth/login` CORS 只允许白名单 origin。

---

## 15. 实现顺序

| 序号 | 任务 | 依赖 |
|------|------|------|
| 1 | 初始化 Next.js + Prisma + PostgreSQL | - |
| 2 | 实现 Prisma schema 和 migration | 1 |
| 3 | 实现 db、validation、auth、rate-limit 基础库 | 1 |
| 4 | 实现超管自动创建 | 2, 3 |
| 5 | 实现 `/api/auth/login` 和 `/api/auth/logout` | 3, 4 |
| 6 | 实现 Admin cookie / Bearer 中间件 | 5 |
| 7 | 实现 CORS 白名单 | 5 |
| 8 | 实现 audit helper | 6 |
| 9 | 实现 Admin user CRUD API | 6, 8 |
| 10 | 实现当前 UTC 月 quota helper | 3 |
| 11 | 实现 quota check / usage / status API | 6, 10 |
| 12 | 实现 usage overview 和 user usage API | 9, 11 |
| 13 | 实现 Admin 登录页和受保护 layout | 5, 6 |
| 14 | 实现 dashboard | 12, 13 |
| 15 | 实现用户列表、创建、编辑、删除 UI | 9, 13 |
| 16 | 实现用户详情和用量明细 UI | 12, 13 |
| 17 | 补齐 unit 和 integration tests | 3-12 |
| 18 | 补齐 Playwright E2E | 13-16 |
| 19 | Dockerfile、env example、部署检查 | 1-18 |

---

## 16. MVP-1 明确不做

- 普通用户自注册。
- 用户修改密码。
- JWT refresh。
- 找回密码。
- 创建或管理多个 admin。
- 审计日志 UI。
- 用量趋势图和复杂报表。
- 多模型加权计费。
- Redis 限流。
- 多实例部署一致性保证。
- API Access Token。
