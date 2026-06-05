# Polo AI × Admin 管理后台 — 对齐契约

> **版本**: v1.0 | **日期**: 2026-06-05
> **用途**: 两个独立仓库之间的接口约定，任何变更需双方同步更新
> **引用方**: `spec-admin.md` 和 `spec-polo-ai.md` 均引用本文档

---

## 1. JWT 规范

### 1.1 签发与验证

| 属性 | 值 |
|------|-----|
| 算法 | HS256 |
| 签发方 | Admin 服务 |
| 密钥 | 环境变量 `JWT_SECRET`（两个服务共享同一值） |
| 过期时间 | 24 小时 |
| 库 | `jose`（两端统一） |

### 1.2 Payload 结构

```json
{
  "sub": "user-uuid",
  "username": "alice",
  "role": "user",
  "iat": 1717300000,
  "exp": 1717386400
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `sub` | UUID string | 用户 ID，users 表主键 |
| `username` | string | 用户名 |
| `role` | `"admin"` \| `"user"` | 用户角色 |
| `iat` | number (unix timestamp) | 签发时间 |
| `exp` | number (unix timestamp) | 过期时间，iat + 86400 |

### 1.3 验证策略

- **Admin**: 签发 JWT，同时也验证（用于 quota/admin API 的认证）
- **Polo AI**: 用共享 `JWT_SECRET` 本地验证签名，不需要调 Admin API 验证

### 1.4 Disabled/Deleted 用户处理

- JWT 签名验证会通过（JWT 本身有效）
- Admin 的 quota/check API 会检查 `user.status` 并拒绝 `disabled`/`deleted` 用户
- 已禁用用户可建立 WebSocket 连接（JWT 有效），但无法发送消息（配额检查被拒）
- MVP-1 不做 token revocation

---

## 2. REST API 契约

Admin 暴露以下 API，Polo AI Server 端调用。

### 2.1 认证 API

#### POST /api/auth/login

**调用方**: Polo AI WebUI 前端（浏览器直调，跨域 CORS）

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

Response 401:
{ "error": "invalid_credentials", "message": "用户名或密码错误" }

Response 403:
{ "error": "account_disabled", "message": "账号已被禁用，请联系管理员" }
```

**行为规则：**
- 校验 `user.status` 必须为 `active`
- `disabled` 返回 403，`deleted` 返回 401（与不存在用户相同，防信息泄漏）
- JWT 在 JSON body 返回，**不**通过 Set-Cookie 设置
- 密码验证使用 argon2id

### 2.2 配额 API（Polo AI Server 端调用）

#### POST /api/quota/check

**调用方**: Polo AI Server（用户发消息前检查配额）

```
Request:
Headers: { "Authorization": "Bearer <user-jwt>" }
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

Response 403:
{ "error": "account_disabled", "message": "账号已被禁用" }
```

**行为规则：**
- 只读操作，不加锁（乐观检查）
- `allowed` 判定：`remaining > 0`
- 检查 `user.status`，`disabled`/`deleted` 返回 403

#### POST /api/quota/usage

**调用方**: Polo AI Server（agent turn 完成后上报用量）

```
Request:
Headers: { "Authorization": "Bearer <user-jwt>" }
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

**行为规则：**
- `requestId` 为幂等键，重复上报返回 409 但不重复计量
- 原子更新 `quota_periods.used_tokens`

#### GET /api/quota/status

**调用方**: Polo AI WebUI 前端（显示配额状态）

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

---

## 3. 错误码约定

所有 API 统一使用以下错误响应格式：

```json
{
  "error": "error_code",
  "message": "人类可读的错误描述"
}
```

| error code | HTTP Status | 触发条件 |
|------------|-------------|----------|
| `invalid_credentials` | 401 | 用户名不存在或密码错误 |
| `account_disabled` | 403 | 用户状态为 disabled 或 deleted |
| `unauthorized` | 401 | 缺少或无效的 JWT |
| `forbidden` | 403 | 角色权限不足 |
| `duplicate_request` | 409 | requestId 已上报 |
| `validation_error` | 400 | 请求参数校验失败 |

---

## 4. 环境变量约定

### 4.1 共享变量

| 变量 | 说明 | 两端必须一致 |
|------|------|-------------|
| `JWT_SECRET` | JWT 签名密钥 | 是 |

### 4.2 Polo AI Server 需要的变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `ADMIN_API_URL` | Admin 服务地址 | `http://localhost:3001` |
| `PLATFORM_ANTHROPIC_API_KEY` | 平台 Anthropic API Key | `sk-ant-xxx` |

### 4.3 Admin 需要的变量

| 变量 | 说明 | 示例 |
|------|------|------|
| `DATABASE_URL` | PostgreSQL 连接串 | `postgresql://polo:xxx@localhost:5432/polo_admin` |
| `ADMIN_USERNAME` | 初始超管用户名 | `admin` |
| `ADMIN_PASSWORD` | 初始超管密码 | `xxx` |
| `CORS_ALLOWED_ORIGINS` | 允许跨域的 Polo AI 域名 | `http://localhost:9100` |

---

## 5. CORS 约定

- Admin 只需对 `/api/auth/login` 配置 CORS（前端浏览器直调）
- 其他 API（quota/check、quota/usage、admin/*）由 Polo AI Server 后端调用，不涉及 CORS
- Admin 通过 `CORS_ALLOWED_ORIGINS` 环境变量配置白名单
- Polo AI 通过 `GET /api/config` 向前端返回 `adminUrl`

---

## 6. Docker Compose 网络约定

```yaml
services:
  postgres:
    ports: ["5432:5432"]

  admin:
    ports: ["3001:3000"]
    environment:
      DATABASE_URL: postgresql://polo:${DB_PASSWORD}@postgres:5432/polo_admin
    depends_on: [postgres]

  polo-server:
    ports: ["9100:9100"]
    environment:
      ADMIN_API_URL: http://admin:3000    # Docker 内部网络
    depends_on: [admin]
```

- Admin 在 Docker 内部监听 3000，外部映射 3001
- Polo AI Server 通过 Docker 服务名 `admin` 访问 Admin API
- PostgreSQL 仅 Admin 直连，Polo AI 不直连数据库

---

## 7. 数据流约定

### 7.1 登录流程

```
WebUI 前端
  │ GET Polo AI /api/config → { adminUrl }
  │ POST {adminUrl}/api/auth/login → { token, user }  (跨域 CORS)
  │ POST Polo AI /auth/session { token } → Set-Cookie
  │ WebSocket upgrade (cookie 自动带)
  └ handshake { workspaceId }
```

### 7.2 发消息流程

```
Polo AI Server
  │ POST Admin /api/quota/check (Bearer JWT) → { allowed, remaining }
  │ effectiveRemaining = remaining - localPending
  │ 调用 Claude SDK
  │ agent turn 完成 → 捕获 usage
  │ POST Admin /api/quota/usage (Bearer JWT) → { recorded }
  └ 失败 → 写本地 pending，后台重试
```

---

## 8. 变更流程

对本契约的任何修改（API 字段增删、错误码变更、JWT 结构变更）需要：

1. 在本文件中更新
2. 同步更新 `spec-admin.md` 和 `spec-polo-ai.md`
3. 两个仓库同时发布对应变更

**向后兼容原则**：新增字段不算破坏性变更，删除/重命名字段需要两端协调发布。
