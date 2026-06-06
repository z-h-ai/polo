# Spec: 用户账号登录 + Admin 下发 LLM 配置

## 1. 背景与目标

### 当前现状

- **WebUI 认证**：所有用户共享同一个密码（`CRAFT_WEBUI_PASSWORD`），无独立账号体系。
- **Electron 认证**：无需登录，直接使用本地嵌入服务器。
- **LLM 配置**：用户在各自设备上手动配置 LLM Provider、填写 API Key、完成 OAuth 授权。配置存储在本地 `~/.craft-agent/` 目录。
- **Onboarding 流程**：首次启动引导用户选择 Provider → 输入凭据 → 完成设置。

### 目标

1. **引入用户账号体系**：Web UI 和 Electron 都使用「用户名 + 密码」登录，账号由 Polo Admin（Academy）后端统一管理。
2. **Admin 集中管理 LLM 配置**：管理员在 Polo Admin 后台为用户/用户组配置 LLM 供应商、API Key 和可用模型列表。用户无需手动配置。
3. **移除用户自助配置能力**：移除 Onboarding 向导、AI Settings 页面、客户端 OAuth 流程、本地模型支持。

---

## 2. 架构概览

```
┌─────────────────────────────────────────────────────┐
│                  Polo Admin (Academy)                │
│  独立项目，提供以下 API：                               │
│  • 用户认证（签发 JWT）                                │
│  • 用户/用户组管理                                     │
│  • LLM 连接配置管理                                    │
│  • 会话撤销 / 密码重置                                  │
│  • 配额检查 / 使用报告（已有）                           │
└──────────────┬──────────────────────────────────────┘
               │ HTTPS + Bearer JWT
               ▼
┌──────────────────────────────┐   ┌────────────────────┐
│     Electron App             │   │     Web UI (SPA)    │
│  ┌─────────────────────┐     │   │                     │
│  │ 本地嵌入服务器       │     │   │  React SPA          │
│  │ (WS RPC Server)     │     │   │  连接远程 Polo Server│
│  └─────────────────────┘     │   │                     │
│  启动前先向 Admin 认证        │   │  登录后获取 JWT      │
│  拉取 LLM 配置并缓存          │   │  拉取 LLM 配置       │
└──────────────────────────────┘   └────────────────────┘
```

### 核心原则

- **必须在线**：应用启动时必须能连接 Admin API 完成认证和配置拉取。运行期间，配额检查等 Admin API 调用也要求网络可达。如果运行期间网络断开，已缓存的 LLM 凭据可继续用于 LLM API 调用（因为 LLM API 调用直接访问 Provider，不经过 Admin），但所有 Admin API 调用（配额检查、使用报告）将失败并按各自的容错策略处理。不支持离线启动。
- **传输层凭据保护**：API Key 从 Admin 加密传输到客户端，使用 JWT 派生的 AES 对称密钥加密。此加密保护传输过程中的被动窃听和服务端日志泄露。客户端解密后 Key 以本地加密存储（`CredentialManager`）保存，其安全性等同于客户端设备本身的安全性。
- **单一 Token**：登录获取的 JWT 同时用于配额检查、使用报告、LLM 配置获取等所有 Admin API 调用。
- **强制 Token 有效性检查**：客户端在每次应用启动时必须调用 `POST /api/auth/validate` 验证 token。运行期间，所有 Admin API 调用（配额检查、使用报告）的 401 响应都会触发强制登出。
- **Admin API URL**：通过环境变量（如 `POLO_ADMIN_API_URL`）或构建时硬编码确定，不由用户输入。

---

## 3. Admin API 契约

> 以下 API 由 Polo Admin（Academy）项目实现。本 Spec 定义契约，双方按此实现。

### 3.0 通用约定

#### 错误响应格式

所有 API 的错误响应使用统一的 envelope：

```json
{
  "error": "machine_readable_code",
  "message": "人类可读的错误描述",
  "details": {},
  "requestId": "req_xxxx"
}
```

- `error`：稳定的机器可读错误码（snake_case），客户端用于分支判断
- `message`：可直接展示给用户的描述
- `details`：可选，包含字段级验证错误等附加信息
- `requestId`：可选，用于问题排查

#### 通用状态码

| 状态码 | 含义 | 使用场景 |
|---|---|---|
| 400 | Bad Request | 请求体格式错误、缺少必填字段 |
| 401 | Unauthorized | Token 无效、已撤销、缺少 Authorization header |
| 403 | Forbidden | 账号被禁用、权限不足（如普通用户调 admin 接口） |
| 404 | Not Found | 资源不存在（用户、组等） |
| 409 | Conflict | 资源冲突（如用户名已存在） |
| 422 | Unprocessable Entity | 字段校验失败（如密码太短、slug 格式错误） |
| 429 | Too Many Requests | 触发速率限制，响应包含 `Retry-After` header |
| 500 | Internal Server Error | 服务端未预期错误 |
| 503 | Service Unavailable | 服务维护中 |

### 3.1 认证

#### `POST /api/auth/login`

用户名密码登录，返回 JWT。

**Request:**
```json
{
  "username": "zhangsan",
  "password": "p@ssw0rd"
}
```

**Response 200:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "usr_abc123",
    "username": "zhangsan",
    "displayName": "张三",
    "role": "user",
    "groupIds": ["grp_dev_team"]
  }
}
```

**JWT Claims 要求:**

```json
{
  "sub": "usr_abc123",
  "jti": "sess_unique_id",
  "iat": 1717660800,
  "iss": "polo-admin",
  "aud": "polo-client",
  "role": "user"
}
```

- `jti`：全局唯一 session ID，用于服务端撤销追踪（Admin 维护已撤销 jti 的集合）
- 不设 `exp`（产品决策：token 不自动过期）。安全补偿措施见第 8 节。
- `iss` / `aud`：防止跨系统 token 误用

**Response 401:**
```json
{
  "error": "invalid_credentials",
  "message": "用户名或密码错误"
}
```

**Response 403:**
```json
{
  "error": "account_disabled",
  "message": "账号已被禁用，请联系管理员"
}
```

**Response 429:**
```json
{
  "error": "rate_limited",
  "message": "登录尝试过于频繁，请稍后再试"
}
```
响应包含 `Retry-After: <seconds>` header。

#### `POST /api/auth/logout`

登出当前 session（使当前 JWT 失效）。

**Headers:** `Authorization: Bearer <jwt>`

**Response 200:**
```json
{ "success": true }
```

#### `POST /api/auth/validate`

验证 JWT 是否仍然有效。**强制调用**：客户端每次启动时必须调用此接口。

**Headers:** `Authorization: Bearer <jwt>`

**Response 200:**
```json
{
  "valid": true,
  "user": {
    "id": "usr_abc123",
    "username": "zhangsan",
    "displayName": "张三",
    "role": "user",
    "groupIds": ["grp_dev_team"]
  },
  "configVersion": "cv_20260606_001"
}
```

- `configVersion`：当前用户 LLM 配置的版本号。客户端可将其与本地缓存的版本号比较，判断是否需要重新拉取 LLM 配置（见 4.2 节）。

**Response 401:** token 已被撤销或无效。

### 3.2 LLM 配置

#### `GET /api/llm-connections`

获取当前用户可用的所有 LLM 连接配置（含加密后的 API Key）。

**Headers:** `Authorization: Bearer <jwt>`

**Response 200:**
```json
{
  "configVersion": "cv_20260606_001",
  "connections": [
    {
      "slug": "anthropic-api",
      "name": "Anthropic (Claude)",
      "providerType": "anthropic",
      "authType": "api_key",
      "models": [
        { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "tier": "standard" },
        { "id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5", "tier": "fast" }
      ],
      "defaultModel": "claude-sonnet-4-6",
      "credential": {
        "alg": "aes-256-gcm",
        "kid": "ek_v1",
        "iv": "base64encodedIV==",
        "ciphertext": "base64encodedCiphertext...",
        "tag": "base64encodedAuthTag=="
      },
      "baseUrl": null,
      "midStreamBehavior": "steer"
    },
    {
      "slug": "openai-via-pi",
      "name": "OpenAI (GPT)",
      "providerType": "pi",
      "authType": "api_key",
      "piAuthProvider": "openai",
      "models": [
        { "id": "gpt-4o", "name": "GPT-4o", "tier": "standard" }
      ],
      "defaultModel": "gpt-4o",
      "credential": {
        "alg": "aes-256-gcm",
        "kid": "ek_v1",
        "iv": "base64encodedIV==",
        "ciphertext": "base64encodedCiphertext...",
        "tag": "base64encodedAuthTag=="
      },
      "baseUrl": null,
      "midStreamBehavior": "queue"
    }
  ],
  "defaultConnection": "anthropic-api"
}
```

- `configVersion`：配置版本号，用于客户端判断缓存是否过期

**加密规范:**

```typescript
interface EncryptedCredential {
  alg: 'aes-256-gcm';      // 算法标识，便于未来升级
  kid: string;              // 密钥标识（如 "ek_v1"），用于密钥轮换时的版本追踪
  iv: string;               // base64 编码的 12 字节随机 IV
  ciphertext: string;       // base64 编码的密文
  tag: string;              // base64 编码的 16 字节 GCM 认证标签
}
```

- 算法: AES-256-GCM
- 密钥派生: 从 JWT token 字符串使用 HKDF-SHA256 派生 32 字节密钥
  - `salt`: 固定值 `"polo-llm-key-encryption"` （UTF-8 编码）
  - `info`: `"aes-256-gcm"` （UTF-8 编码）
  - `inputKeyMaterial`: JWT token 原始字符串（UTF-8 编码）
- **IV 要求**: 每次加密必须使用 CSPRNG 生成全新的 12 字节随机 IV。禁止 IV 重用（GCM 模式下 IV 重用会导致密钥泄露）。
- `kid` 用于密钥版本管理：当加密方案升级或 JWT 签发逻辑变更时，通过 `kid` 标识旧密文需要 Admin 侧重新加密。

### 3.3 用户管理（Admin 操作）

> 以下接口供 Admin 后台 UI 调用，需管理员身份（JWT 中 role = admin）。

#### `POST /api/admin/users`

创建用户。

```json
{
  "username": "zhangsan",
  "displayName": "张三",
  "password": "initial_password",
  "groupIds": ["grp_dev_team"],
  "role": "user"
}
```

#### `PUT /api/admin/users/:userId/password`

重置用户密码。

```json
{
  "newPassword": "new_password"
}
```

#### `POST /api/admin/users/:userId/revoke-sessions`

强制下线用户（撤销该用户所有 session token）。

**Response 200:**
```json
{ "success": true, "revokedCount": 3 }
```

#### `POST /api/admin/users/:userId/revoke-session/:jti`

撤销用户的单个 session（按 JWT 的 `jti` 标识）。

**Response 200:**
```json
{ "success": true }
```

**Response 404:** 该 session 不存在或已撤销。

#### `GET /api/admin/users/:userId/sessions`

列出用户的活跃 session 列表。

**Response 200:**
```json
{
  "sessions": [
    {
      "jti": "sess_abc123",
      "createdAt": "2026-06-01T10:00:00Z",
      "lastActiveAt": "2026-06-06T14:30:00Z",
      "deviceInfo": "Electron/macOS",
      "ipAddress": "192.168.1.100"
    }
  ]
}
```

#### `GET /api/admin/users`

列出所有用户。

**Query Parameters:**
- `limit`：每页数量，默认 20，最大 100
- `cursor`：分页游标（上一页响应中的 `nextCursor`）
- `search`：按用户名/显示名模糊搜索
- `groupId`：按用户组筛选
- `role`：按角色筛选（`admin` | `user`）

**Response 200:**
```json
{
  "users": [
    {
      "id": "usr_abc123",
      "username": "zhangsan",
      "displayName": "张三",
      "role": "user",
      "groupIds": ["grp_dev_team"],
      "createdAt": "2026-01-15T08:00:00Z",
      "lastLoginAt": "2026-06-06T09:00:00Z"
    }
  ],
  "nextCursor": "cursor_xxx",
  "total": 42
}
```

#### `POST /api/admin/groups`

创建用户组。

**Request:**
```json
{
  "name": "开发团队",
  "slug": "dev-team"
}
```

**Response 201:**
```json
{
  "id": "grp_dev_team",
  "name": "开发团队",
  "slug": "dev-team",
  "userIds": [],
  "createdAt": "2026-06-06T10:00:00Z"
}
```

**Response 409:**
```json
{
  "error": "slug_conflict",
  "message": "用户组标识 'dev-team' 已存在"
}
```

#### `PUT /api/admin/groups/:groupId/llm-connections`

为用户组配置 LLM 连接列表。

```json
{
  "connections": [
    {
      "slug": "anthropic-api",
      "name": "Anthropic (Claude)",
      "providerType": "anthropic",
      "authType": "api_key",
      "apiKey": "sk-ant-...",
      "models": [
        { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6", "tier": "standard" }
      ],
      "defaultModel": "claude-sonnet-4-6",
      "midStreamBehavior": "steer"
    }
  ],
  "defaultConnection": "anthropic-api"
}
```

#### `PUT /api/admin/users/:userId/llm-connections`

为单个用户覆盖 LLM 连接配置（优先级高于用户组配置）。格式同上。

#### `POST /api/admin/users` — 字段校验规则

| 字段 | 规则 |
|---|---|
| `username` | 3-32 字符，仅允许 `[a-zA-Z0-9._-]`，全局唯一 |
| `displayName` | 1-64 字符 |
| `password` | 最少 8 字符 |
| `role` | 枚举：`admin` \| `user` |
| `groupIds` | 数组，每个元素必须是已存在的组 ID |

连接配置的 `slug` 遵循相同的标识符规则（3-32 字符，`[a-zA-Z0-9._-]`）。

### 3.4 审计日志

Admin 端必须记录以下安全事件的审计日志：

| 事件 | 记录内容 |
|---|---|
| 登录成功 | 用户 ID、IP、时间、设备信息 |
| 登录失败 | 用户名（无论是否存在）、IP、时间、失败原因 |
| 登出 | 用户 ID、session jti |
| 密码重置 | 操作管理员 ID、目标用户 ID |
| 会话撤销 | 操作管理员 ID、目标用户 ID、被撤销的 jti 列表 |
| LLM 配置变更 | 操作管理员 ID、变更对象（组/用户）、变更内容摘要 |
| 用户创建/禁用 | 操作管理员 ID、目标用户 ID |

审计日志的存储和查询 API 由 Polo Academy 自行设计，不在本契约范围内。

### 3.5 全局 401 约定

所有带 `Authorization: Bearer <jwt>` 的 API，当 token 被撤销或无效时，统一返回 HTTP 401：

```json
{
  "error": "token_revoked",
  "message": "Session has been revoked"
}
```

客户端收到 401 后的行为：
1. 取消所有进行中的 LLM API 请求
2. 清除本地缓存的 JWT、用户信息、LLM 配置、已解密的 API Key
3. 如有未保存的用户输入，保存为本地草稿（Workspace 级别，不含敏感数据）
4. 显示「会话已失效，请重新登录」提示（区别于「密码错误」和「账号禁用」）
5. 跳转到登录页

### 3.6 速率限制（contractual）

Admin 端必须实现以下速率限制：

| 接口 | 限制 | 说明 |
|---|---|---|
| `POST /api/auth/login` | 5 次/分钟/IP，3 次/分钟/用户名 | 连续 10 次失败后锁定该用户名 30 分钟 |
| `POST /api/auth/validate` | 60 次/分钟/token | 防止异常客户端轰炸 |
| `GET /api/llm-connections` | 10 次/分钟/token | 正常使用只在登录时调一次 |
| Admin 管理接口 | 30 次/分钟/admin token | 防止误操作 |

触发限制时返回 429 + `Retry-After` header。客户端收到 429 时，显示友好提示并按 `Retry-After` 值延迟重试。

---

## 4. 客户端变更

### 4.1 认证流程

#### 启动流程（Web UI + Electron 共用）

```
应用启动
  ↓
检查本地是否有缓存的 JWT
  ├── 无 token → 显示登录页
  └── 有 token → 调用 POST /api/auth/validate（超时 10 秒）
        ├── 200 (有效)
        │     ├── configVersion 与本地缓存一致 → 使用缓存的 LLM 配置 → 进入应用
        │     └── configVersion 不一致或无缓存 → 拉取 LLM 配置 → 进入应用
        ├── 401 (无效) → 清除缓存 → 显示登录页
        └── 网络错误/超时/5xx → 显示「无法连接服务器」错误页（含重试按钮）
```

**网络故障处理**：启动时如果 Admin API 不可达，不允许使用缓存 token 进入应用。显示错误页面包含：
- 错误描述：「无法连接到认证服务器」
- 重试按钮
- 服务器地址提示（便于排查）
- 超时时间：10 秒（连接超时 5 秒 + 读取超时 5 秒）

#### 登录流程

1. 用户输入用户名 + 密码
2. 客户端调用 `POST /api/auth/login`
3. 成功：安全存储 JWT + 用户信息 → 拉取 LLM 配置 → 解密凭据 → 写入本地存储 → 进入应用
4. 失败：根据错误码显示对应提示
   - `invalid_credentials` → 「用户名或密码错误」
   - `account_disabled` → 「账号已被禁用，请联系管理员」
   - `rate_limited` → 「登录尝试过于频繁，请 N 秒后再试」（N 从 `Retry-After` header 读取）
   - 网络错误 → 「无法连接服务器，请检查网络连接」
5. 部分失败（登录成功但 LLM 配置拉取失败）→ 显示「配置加载失败」错误页（含重试按钮），不进入主应用

#### 登出流程

1. 用户点击「登出」
2. 客户端调用 `POST /api/auth/logout`
3. 清除本地缓存的 JWT、用户信息、LLM 配置、已解密的 API Key
4. 跳转到登录页

#### Token 失效处理

- 任何 Admin API 调用返回 401 时，客户端执行强制登出流程
- 包括配额检查、使用报告等已有的 Admin API 调用
- 强制登出流程：
  1. 取消所有进行中的 LLM API 请求
  2. 清除本地缓存的 JWT、用户信息、LLM 配置
  3. 从 `CredentialManager` 删除所有 Admin 下发的 LLM 凭据（按 `llm::` 前缀匹配）
  4. 如有用户正在编辑的输入，保存为本地草稿
  5. 显示「会话已失效」提示 → 跳转登录页

#### Admin 不可达时的运行期行为

应用已启动运行后，如果 Admin API 不可达（网络断开、Admin 宕机）：
- **LLM 调用**：正常工作（LLM API 直连 Provider，不经过 Admin）
- **配额检查**：使用现有的 `PendingUsageStore` 容错机制（本地记录，恢复后补报）
- **Token 验证**：无法执行，但不主动踢出用户（仅在下次成功联系 Admin 时验证）
- 客户端应在 UI 中显示不显眼的连接状态指示（如灰色图标），但不阻断用户工作

### 4.2 LLM 配置获取与使用

#### 配置拉取时机

- **登录时拉取**：调用 `GET /api/llm-connections`，将 `configVersion` 缓存在本地
- **启动时按需刷新**：`POST /api/auth/validate` 返回的 `configVersion` 与本地不一致时，自动重新拉取
- 管理员更换 API Key 后，用户重新启动应用或重新登录即可获取新配置
- 运行期间不主动轮询配置变更

#### 解密流程

1. 收到 `GET /api/llm-connections` 响应
2. 对每个连接的 `credential` 字段：
   a. 检查 `credential.alg` 是否为支持的算法（当前仅 `aes-256-gcm`），不支持则跳过该连接并记录警告
   b. 从当前 JWT token 使用 HKDF-SHA256 派生 AES-256 密钥
   c. 从 `credential.iv`、`credential.ciphertext`、`credential.tag` 分别 base64 解码
   d. 使用 AES-256-GCM 解密得到明文 API Key
   e. 解密失败（认证标签不匹配等）→ 跳过该连接并记录错误，不中断整体流程
3. 将解密后的 API Key 存入现有的凭据管理器（`CredentialManager`，AES-256-GCM 本地加密存储）
4. 将 `configVersion` 缓存到本地，用于后续启动时的版本比较

**原子性**：认证 + 配置拉取 + 解密 + 本地写入视为一个整体事务。如果任何步骤失败，清除本次写入的所有部分数据，显示错误页面（含重试按钮），不进入主应用。

#### 配置映射

Admin API 返回的连接配置映射到现有的 `LlmConnection` 类型：

| Admin API 字段 | LlmConnection 字段 | 说明 |
|---|---|---|
| `slug` | `slug` | 直接映射 |
| `name` | `name` | 直接映射 |
| `providerType` | `providerType` | 直接映射 |
| `authType` | `authType` | 直接映射 |
| `models` | `models` | 直接映射，`modelSelectionMode` 设为 `'userDefined3Tier'` |
| `defaultModel` | `defaultModel` | 直接映射 |
| `piAuthProvider` | `piAuthProvider` | 直接映射 |
| `baseUrl` | `baseUrl` | 直接映射 |
| `midStreamBehavior` | `midStreamBehavior` | 直接映射 |
| `defaultConnection` | 存入 `StoredConfig.defaultLlmConnection` | 全局默认 |

### 4.3 模型选择

- 用户可以在管理员分配的多个 LLM 连接之间切换
- 每个连接内，用户只能选择管理员配置的模型列表中的模型
- 现有的模型选择器 UI 保留，但数据源从本地配置改为 Admin 下发的配置
- 用户无法增加、删除或修改 LLM 连接

### 4.4 Electron 特殊处理

Electron 继续使用本地嵌入服务器模式，但增加远程认证层：

```
Electron 启动
  ↓
主进程从 safeStorage 读取缓存的 JWT
  ├── 无 token → 渲染器显示登录页
  └── 有 token → 主进程调用 POST /api/auth/validate（超时 10 秒）
        ├── 200 (有效)
        │     ├── configVersion 一致 → 使用缓存配置 → 启动本地 WS RPC 服务器 → 进入应用
        │     └── configVersion 不一致 → 拉取 LLM 配置 → 启动本地 WS RPC 服务器 → 进入应用
        ├── 401 (无效) → 清除缓存 → 渲染器显示登录页
        └── 网络错误/超时 → 渲染器显示「无法连接服务器」错误页
```

- **JWT 存储**：使用 Electron 的 `safeStorage` API 加密存储在主进程。禁止使用 localStorage 存储 JWT。渲染进程通过 IPC 请求主进程执行认证操作，不直接接触 JWT 原文。
- **LLM 配置缓存**：写入本地 `StoredConfig`，覆盖原有的 `llmConnections` 数组
- **Admin API 调用**：通过主进程发起（避免 CORS 问题），结果通过 IPC 传递给渲染进程
- **IPC 安全**：主进程暴露的 IPC 通道仅限于 `login(username, password)`、`logout()`、`getAuthState()` 等高层操作，不暴露 JWT 原文给渲染进程
- **设备信息**：登录时附带设备标识（`os.platform()` + `os.hostname()`），用于 Admin 端的 session 列表展示

### 4.5 Web UI 特殊处理

- 现有的密码登录页替换为用户名 + 密码登录页
- **JWT 存储**：使用 HttpOnly、Secure、SameSite=Strict Cookie（`polo_session`）。Polo Server 在登录成功后设置此 Cookie。禁止将 JWT 存入 localStorage 或 sessionStorage。
- **WebSocket 握手**：JWT 通过 Cookie 自动附带在升级请求中。禁止通过 URL query 参数传递 JWT（URL 会被代理/浏览器历史/崩溃报告记录）。
- **CSRF 防护**：登录接口需附带 CSRF token（由 Server 在登录页渲染时注入）。
- **设备信息**：登录时附带 User-Agent，用于 Admin 端的 session 列表展示

---

## 5. UI 变更清单

### 5.1 新增

| 组件 | 位置 | 说明 |
|---|---|---|
| `LoginPage` | `renderer/pages/` | 用户名 + 密码登录表单，替代现有密码输入页 |
| `ServerErrorPage` | `renderer/pages/` | 「无法连接服务器」错误页，含重试按钮和服务器地址提示 |
| `ConfigErrorPage` | `renderer/pages/` | 「配置加载失败」错误页，含重试按钮 |
| `NoLlmConfigBanner` | `renderer/components/` | 「暂无可用的 LLM 配置，请联系管理员」提示 |
| `SessionExpiredDialog` | `renderer/components/` | 「会话已失效，请重新登录」模态对话框 |
| 登出按钮 | 应用设置菜单 | 用户可主动登出 |
| 用户信息展示 | 侧边栏/标题栏 | 显示当前登录的用户名和角色 |
| 连接状态指示 | 状态栏 | Admin API 不可达时显示灰色图标 |

### 5.2 移除

| 组件/功能 | 当前位置 | 原因 |
|---|---|---|
| `OnboardingWizard` | `renderer/components/onboarding/` | LLM 配置由 Admin 管理 |
| `ProviderSelectStep` | `renderer/components/onboarding/` | 同上 |
| `CredentialsStep` | `renderer/components/onboarding/` | 同上 |
| `AiSettingsPage` | `renderer/pages/` | LLM 配置由 Admin 管理，用户无需设置 |
| `ApiKeyInput` | `renderer/components/apisetup/` | 同上 |
| `OAuthConnect` | `renderer/components/apisetup/` | 同上 |
| `SetupAuthBanner` | `renderer/components/app-shell/` | 不再需要引导用户设置 Provider |
| 所有 OAuth 流程代码 | `packages/shared/src/auth/` | `claude-oauth.ts`, `chatgpt-oauth.ts`, `google-oauth.ts`, `microsoft-oauth.ts`, `oauth.ts`, `oauth-flow-store.ts` 等 |
| 本地模型支持 | 多处 | Ollama 等本地模型相关代码移除 |
| `CRAFT_WEBUI_PASSWORD` 认证 | `packages/server-core/src/webui/auth.ts` | 替换为 Admin JWT 认证 |
| `CRAFT_SERVER_TOKEN` 认证 | `packages/server/src/index.ts` | 替换为 Admin JWT 认证 |
| LLM 连接增删改 RPC 处理器 | `packages/server-core/src/handlers/rpc/llm-connections.ts` | `SAVE`, `DELETE`, `SET_DEFAULT` 等写操作移除，保留 `LIST`/`GET` 只读操作 |

### 5.3 修改

| 组件/功能 | 变更内容 |
|---|---|
| 模型选择器 | 数据源从本地 `StoredConfig` 改为 Admin 下发的配置。保留切换 connection 和 model 的能力，但不允许增删 |
| `AdminApiClient` | 扩展：新增 `login()`, `logout()`, `validateToken()`, `getLlmConnections()` 方法。所有方法统一处理 401 → 触发强制登出。新增全局 401 拦截器 |
| WebSocket 握手认证 | 使用 Admin JWT 替代 `CRAFT_SERVER_TOKEN` 验证 |
| Electron 主进程启动流程 | 增加 Admin 认证检查步骤 |
| 应用路由 | 增加未认证状态跳转登录页的守卫 |

---

## 6. 数据模型

### 6.1 用户（User）

```typescript
interface User {
  id: string;           // 如 "usr_abc123"
  username: string;     // 登录用唯一标识
  displayName: string;  // 显示名
  role: 'admin' | 'user';
  groupIds: string[];   // 所属用户组 ID 列表
}
```

### 6.2 用户组（UserGroup）

```typescript
interface UserGroup {
  id: string;           // 如 "grp_dev_team"
  name: string;         // 如 "开发团队"
  slug: string;         // URL 安全标识
  userIds: string[];    // 组内成员 ID 列表
}
```

### 6.3 LLM 连接配置（Admin 侧）

```typescript
interface AdminLlmConnectionConfig {
  slug: string;
  name: string;
  providerType: 'anthropic' | 'pi' | 'pi_compat';
  authType: 'api_key' | 'api_key_with_endpoint' | 'bearer_token' | 'iam_credentials' | 'service_account_file' | 'environment';
  apiKey: string;                // 明文 API Key（仅 Admin 存储）
  baseUrl?: string;
  piAuthProvider?: string;
  models: AdminModelDefinition[];
  defaultModel: string;
  midStreamBehavior?: 'steer' | 'queue';
}

interface AdminModelDefinition {
  id: string;
  name: string;
  tier?: 'fast' | 'standard' | 'premium';
}
```

### 6.4 LLM 配置分配

```typescript
// 用户组级别配置
interface GroupLlmAssignment {
  groupId: string;
  connections: AdminLlmConnectionConfig[];
  defaultConnection: string;
}

// 用户级别覆盖（优先级高于组）
interface UserLlmAssignment {
  userId: string;
  connections: AdminLlmConnectionConfig[];
  defaultConnection: string;
}
```

**配置解析规则**（按优先级从高到低）：

1. **用户级覆盖**：如果用户有独立配置（`UserLlmAssignment`），完全使用该配置，忽略所有组配置。
2. **单一用户组**：如果用户仅属于一个组，使用该组的配置。
3. **多用户组合并**：如果用户属于多个组且无用户级覆盖，取所有组的连接配置的**并集**（按 `slug` 去重，同一 `slug` 在多个组中出现时，取第一个匹配的组的配置，组按 `groupId` 字典序排列以保证确定性）。`defaultConnection` 取用户 `groupIds` 数组中第一个组的 `defaultConnection`。
4. **无配置**：如果用户无组且无用户级配置 → `GET /api/llm-connections` 返回空 `connections` 数组，客户端显示「暂无可用的 LLM 配置，请联系管理员」提示。

---

## 7. 环境变量

| 变量名 | 说明 | 示例 |
|---|---|---|
| `POLO_ADMIN_API_URL` | Admin API 基础 URL | `https://admin.polo.example.com` |

### 移除的环境变量

| 变量名 | 原用途 | 替代方案 |
|---|---|---|
| `CRAFT_WEBUI_PASSWORD` | Web UI 登录密码 | Admin 用户账号 |
| `CRAFT_SERVER_TOKEN` | Server API 认证 token | Admin JWT |
| `CRAFT_WEBUI_SECURE_COOKIE` | Cookie Secure 标志 | 根据 Admin API URL 协议自动判断 |

---

## 8. 安全考量

### 8.1 密码安全

- **存储**：Admin 端使用 argon2id 哈希存储密码（与现有 WebUI 一致）
- **传输**：密码仅在 `POST /api/auth/login` 中通过 HTTPS 传输，不在 JWT 或其他载荷中出现
- **暴力破解**：见 3.6 节速率限制（contractual，非建议）

### 8.2 传输安全

- 所有 Admin API 调用必须使用 HTTPS
- Electron 客户端：启用 TLS 证书验证，拒绝自签名证书（开发模式除外）。TLS 连接失败时显示明确错误，不 fallback 到 HTTP
- Web UI：通过 Polo Server 中转 Admin API 调用时，Server 到 Admin 的连接也必须为 HTTPS
- Admin 端应设置 `Strict-Transport-Security` header（`max-age=31536000; includeSubDomains`）

### 8.3 API Key 传输加密

**威胁模型**：此加密方案保护以下场景：
- 传输过程中的被动窃听（在 TLS 之上增加一层应用层加密）
- Admin 服务端日志意外记录响应体时，API Key 不以明文出现
- 缓存/CDN 等中间层意外缓存响应时，Key 不可直接读取

**不保护的场景**（已知限制）：
- 客户端设备被入侵（攻击者可读取内存或本地存储中解密后的 Key）
- JWT token 被盗（攻击者可用相同方式派生密钥并解密）

如未来需要更强的客户端 Key 隔离，可考虑升级为服务端代理模式（所有 LLM 请求经由 Polo Server 转发，Key 不离开服务端）。此为未来增强方向，不在本次范围内。

### 8.4 JWT 安全

**产品决策**：JWT 不设 `exp`（不自动过期），以避免用户频繁重新登录。以下补偿措施降低风险：

1. **`jti` 声明**：每个 JWT 包含全局唯一的 `jti`（session ID），Admin 端维护已撤销 `jti` 的集合，所有 API 调用时校验
2. **`iss` / `aud` 声明**：防止跨系统 token 误用
3. **强制启动验证**：每次应用启动必须调用 `POST /api/auth/validate`，被撤销的 token 在下次启动时即失效
4. **运行期 401 拦截**：配额检查等 Admin API 调用频繁发生（每次 LLM 请求前），被撤销的 token 通常在秒级被发现
5. **Admin 管理能力**：管理员可按用户或按 session 撤销，也可重置密码使旧 token 对应的凭据失效
6. **审计日志**：所有 token 签发和撤销事件都有审计记录

**Token 存储要求**：
- Electron：必须使用 `safeStorage` API，禁止 localStorage
- Web UI：必须使用 HttpOnly + Secure + SameSite=Strict Cookie，禁止 localStorage/sessionStorage
- WebSocket：JWT 通过 Cookie 传递，禁止 URL query 参数

### 8.5 本地存储

- 解密后的 API Key 使用现有的凭据管理器（`CredentialManager`）AES-256-GCM 加密存储在本地
- 登出时彻底清除：JWT、用户信息、解密的 API Key、LLM 配置缓存、`configVersion`
- Admin 强制撤销时：同上清除流程，额外保存用户未发送的输入为本地草稿

### 8.6 CSRF 防护

- Web UI 的登录表单需要 CSRF token
- Polo Server 在渲染登录页时生成 CSRF token，登录请求中验证
- Cookie 使用 `SameSite=Strict` 作为额外防线

---

## 9. 迁移计划

### 9.1 部署顺序

1. **先部署 Admin API**：确保认证和 LLM 配置接口可用
2. **创建 bootstrap 管理员**：Admin 端提供初始化命令/脚本，创建第一个管理员账号（如 `polo-admin init --username admin --password <password>`）。此命令仅在无管理员存在时可执行
3. **管理员配置用户和 LLM**：通过 Admin API（或后续 Admin UI）创建用户、用户组、LLM 连接
4. **部署新版客户端**：更新 Electron 和 Web UI，配置 `POLO_ADMIN_API_URL` 环境变量
5. **切换完成**：旧的 `CRAFT_WEBUI_PASSWORD` / `CRAFT_SERVER_TOKEN` 不再被读取

### 9.2 回滚策略

- 如果新版客户端出现严重问题，可回退到旧版客户端 + 恢复 `CRAFT_WEBUI_PASSWORD` 环境变量
- 旧版和新版客户端不会同时运行（同一 Server 实例只接受一种认证方式）
- 建议在灰度环境完整验证后再全量部署

### 9.3 数据迁移

- 本地存储的 LLM 连接配置（`StoredConfig.llmConnections`）在新版启动时会被 Admin 下发的配置覆盖
- 本地的 OAuth token 和手动配置的 API Key 在登录成功后清除
- Workspace 数据和会话历史不受影响

---

## 10. Bootstrap 管理员

首次部署时，Admin 端需要一个机制创建初始管理员账号：

- Admin 端提供 CLI 命令：`polo-admin init --username <name> --password <password>`
- 此命令仅在数据库中无任何管理员用户时可执行
- 执行后创建 `role: 'admin'` 的用户
- 如所有管理员都被锁定（全部禁用），需要通过数据库直接操作恢复（运维流程，不在客户端范围内）

---

## 11. 不在范围内

- CLI 应用的登录支持
- 用户自助修改密码
- 首次登录强制改密
- 离线模式
- 本地模型（Ollama 等）支持
- Workspace 跨设备同步
- Admin 后台 UI 开发（由 Polo Academy 项目负责）
- 第三方 SSO / LDAP / OIDC 集成
- 配额系统改造（已有，复用 JWT）

---

## 12. 实现顺序建议

### Phase 1: 基础认证

1. 扩展 `AdminApiClient`：新增 `login()`, `logout()`, `validateToken()`, `getLlmConnections()` 方法
2. 新增 `LoginPage` 组件
3. 实现应用启动时的认证检查逻辑
4. 实现 401 全局拦截 → 跳转登录
5. 添加登出功能

### Phase 2: LLM 配置对接

6. 实现 LLM 配置拉取和解密逻辑
7. 将解密后的配置写入本地 `StoredConfig` 和 `CredentialManager`
8. 修改模型选择器数据源为 Admin 下发配置（只读）

### Phase 3: 清理

9. 移除 Onboarding 向导
10. 移除 AI Settings 页面
11. 移除客户端 OAuth 流程代码
12. 移除本地模型支持
13. 移除 `CRAFT_WEBUI_PASSWORD` / `CRAFT_SERVER_TOKEN` 认证机制
14. 移除 LLM 连接写操作 RPC 处理器

### Phase 4: Electron 适配

15. Electron 主进程增加 Admin 认证检查
16. JWT 存储和 IPC 传递
17. 启动流程修改：认证 → 拉取配置 → 启动本地服务器

---

## 13. 验证方案

### 认证流程

1. **登录成功**：输入正确用户名密码 → 进入应用 → 显示用户名
2. **登录失败 - 错误凭据**：错误密码 → 显示「用户名或密码错误」，不进入应用
3. **登录失败 - 账号禁用**：已禁用账号 → 显示「账号已被禁用，请联系管理员」
4. **登录失败 - 速率限制**：连续快速失败 → 显示「请 N 秒后再试」
5. **登录失败 - 网络错误**：Admin 不可达 → 显示「无法连接服务器」+ 重试按钮
6. **登出**：点击登出 → 清除所有缓存 → 跳转登录页 → 用旧 token 访问任何 API 返回 401

### Token 生命周期

7. **Token 撤销（全部）**：Admin 强制下线 → 用户下次配额检查时收到 401 → 自动跳转登录页 → 显示「会话已失效」
8. **Token 撤销（单个）**：Admin 撤销单设备 session → 仅该设备被踢出，其他设备不受影响
9. **密码重置**：Admin 重置密码 → 用户用新密码登录成功 → 旧密码无法登录

### LLM 配置

10. **配置展示**：登录后 → 模型选择器显示 Admin 配置的连接和模型 → 可切换 → 无法增删
11. **配置更新**：Admin 更新 LLM 配置 → 用户重启应用 → `configVersion` 变化 → 自动拉取新配置
12. **部分解密失败**：某个连接的 Key 解密失败 → 该连接不可用 → 其他连接正常工作
13. **无配置**：用户未被分配任何 LLM 连接 → 显示「暂无可用的 LLM 配置，请联系管理员」

### 多设备与跨端

14. **多设备登录**：同一用户在 Electron 和 Web UI 同时登录 → 各自正常使用
15. **Electron 冷启动**：无缓存 token → 显示登录页 → 登录后正常使用
16. **Electron 热启动**：有缓存 token + configVersion 一致 → 自动验证 → 直接进入应用（不重新拉取配置）
17. **Electron 热启动 + 配置变更**：有缓存 token + configVersion 不一致 → 验证通过 → 拉取新配置 → 进入应用

### 异常场景

18. **启动时 Admin 不可达**：显示错误页 + 重试按钮，不允许使用缓存 token 进入
19. **运行中 Admin 不可达**：LLM 调用正常（直连 Provider），UI 显示连接状态指示
20. **登录成功但配置拉取失败**：显示「配置加载失败」+ 重试按钮，不进入主应用
21. **Mid-session 撤销**：用户正在对话 → 401 → 取消进行中的 LLM 请求 → 保存输入草稿 → 跳转登录页
