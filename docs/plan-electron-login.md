# POL-22: Electron 登录 + Admin API 架构评审

## Context

Polo AI Electron 桌面端目前没有用户登录，用户自行配置 LLM 连接（API Key / OAuth）。需要增加基于 Admin 后台的登录功能：用户在 Electron 中输入用户名密码 → Admin 签发 JWT → Polo AI 获取 Admin 下发的 LLM 连接配置。

Admin 后台（`polo-admin` 独立仓库，Next.js）已实现基础能力：用户 CRUD、JWT 登录（HS256/24h）、Argon2 密码、配额系统。缺失：LLM 配置管理、validate 端点。

### 关键决策（已确认）

1. **Admin URL 不需要用户配置**：由 Polo AI Server 端的 `ADMIN_API_URL` 环境变量决定。有 = Admin 管理模式，没有 = 独立模式。用户只需输入用户名和密码。
2. **本次迭代范围**：登录 + LLM 连接同步 + 用量/额度展示（软限制，仅前端展示预警，不做硬截断——第三方 Provider 兜底）。
3. **Admin 模式下完全锁定**：用户不能自行添加/修改 LLM 连接，只用 Admin 下发的。
4. **JWT 采用 refresh token 方案**：access token 7 天过期 + refresh token 30 天，客户端静默续期。不需要服务端 session 撤销系统。

---

## Part A: Admin API 架构评审 + 改进建议

### 1. JWT 策略：改用 access token + refresh token（重大变更）

**原设计问题**：迭代计划要求移除 JWT `exp`，自建 session 撤销系统（sessions 表 + 内存撤销缓存 + 每次 API 调用检查撤销状态）。这是用高复杂度换用户不重登录的体验。

**新方案**：

| 组件 | 值 | 说明 |
|------|-----|------|
| Access Token | JWT HS256, `exp` = 7 天 | 中短命，用于 API 认证 |
| Refresh Token | opaque UUID, 存 DB, 30 天有效 | 长命，仅用于换新 access token |
| 刷新端点 | `POST /api/auth/refresh` | 用 refresh token 换新的 access + refresh token pair |

**用户体验**：
- 7 天内打开 app → 直接用，无任何网络请求开销
- 7-30 天没用 → 打开时静默刷新，用户无感
- 30 天以上没用 → 需要重新输入用户名密码

**对 Admin 迭代计划的影响**：

| 原 Phase | 变化 |
|---------|------|
| Phase 1（JWT 重构 + session 表） | **大幅简化**：保留 JWT `exp`（改为 7 天），只加 `iss`/`aud` claims。删除 sessions 表、撤销缓存、jti 追踪。新增 `refresh_tokens` 表 |
| Phase 2（validate 端点） | 保留 validate，删除 session 撤销检查 |
| Phase 4（session 管理 API） | **取消**。不需要 session 列表和按 session 撤销 |

**Admin 需要的数据库变更**：

```prisma
model RefreshToken {
  id        String   @id @default(uuid()) @db.Uuid
  userId    String   @db.Uuid
  token     String   @unique @db.VarChar(128)  // opaque UUID
  expiresAt DateTime @db.Timestamptz
  createdAt DateTime @default(now()) @db.Timestamptz
  revoked   Boolean  @default(false)

  user      User     @relation(fields: [userId], references: [id])

  @@index([userId])
  @@map("refresh_tokens")
}
```

**登录流程变更**：

```
POST /api/auth/login
  → 验证密码
  → 签发 access token (JWT, 7 天 exp)
  → 生成 refresh token (UUID, 存 DB, 30 天)
  → 返回 { accessToken, refreshToken, expiresIn: 604800, user }

POST /api/auth/refresh
  → 验证 refresh token (DB 查询, 检查 revoked + expiresAt)
  → 签发新 access token (7 天)
  → 生成新 refresh token (rotation: 旧的作废)
  → 返回 { accessToken, refreshToken, expiresIn: 604800 }

POST /api/auth/logout
  → 撤销 refresh token (标记 revoked=true)
  → 客户端删除本地 token
  → access token 7 天内自然过期
```

**安全特性**：
- Refresh token rotation：每次刷新都换新 refresh token，旧的作废。防止 refresh token 泄露后被长期利用
- 管理员可通过删除用户的 refresh tokens 强制登出（最多等 7 天 access token 过期）
- 密码重置时批量 revoke 所有 refresh tokens

### 2. 简化迭代计划：去掉 session 系统和用户组

**原计划优先级问题**：核心价值（LLM 连接管理）排在 Phase 5，前面有大量非必需的基础设施。

**建议的 Admin 新迭代顺序**：

| 新序号 | 内容 | 原 Phase | 说明 |
|--------|------|---------|------|
| 1 | 错误标准化 + CORS 扩展 | Phase 0 | 保留 |
| 2 | JWT 加 iss/aud + refresh token + validate + logout | Phase 1+2 简化 | 去掉 sessions 表和撤销系统 |
| 3 | **LLM 连接管理**（用户级，不含组） | Phase 5 简化 | **大幅提前**，去掉 transit key 加密 |
| 4 | 速率限制 + 登录锁定 | Phase 2 部分 | 安全加固 |
| 5 | Admin UI（连接配置页面） | Phase 7 部分 | 只做连接管理 UI |
| — | 用户组 (Phase 3) | 推迟 | 直接配置到用户足够 |
| — | Session 管理 API (Phase 4) | 取消 | refresh token 方案不需要 |

### 3. Transit Key 加密：建议去掉

`GET /api/llm-connections` 用 HKDF(JWT) 派生密钥加密 API Key。HTTPS 已经加密传输层，应用层再加密的威胁模型不明确，但复杂度很高。

**建议**：直接在 HTTPS + Bearer JWT 认证下返回明文 API Key。如果未来有更强安全需求再加。

**对 Polo AI 侧的影响**：去掉 `admin/crypto.ts`，简化 syncConnections 逻辑。

### 4. 其他 API 问题（保留）

- POL-17 遗漏 logout 端点
- quota 响应 BigInt strings vs numbers → 建议统一为 number
- `estimatedTokens` → 建议改为可选
- `configVersion` 格式不一致（ISO timestamp vs `cv_` 前缀）→ 需统一
- LLM connections response "灵活 schema" → 需要严格定义字段

---

## Part B: Polo AI / Electron 侧实现方案

### 整体流程

```
Polo AI Server 启动
  → 读取 ADMIN_API_URL 环境变量 → 存入 config（无则独立模式）

Electron 启动
  → RPC 获取 server config（含 adminUrl）
  → 如果有 adminUrl（Admin 管理模式）：
      → 检查 credential manager 是否有 admin tokens
      → 有 access token：
          → 未过期：调用 validate → 成功 → syncConnections → 进入主界面
          → 已过期：用 refresh token 静默刷新
              → 刷新成功 → validate → syncConnections → 进入主界面
              → 刷新失败（refresh token 也过期/被撤销） → 显示登录页
      → 无 token：显示登录页
  → 如果无 adminUrl（独立模式）：
      → 走现有 onboarding 流程（不变）

登录页（只显示用户名 + 密码）
  → renderer → RPC admin:login → server handler → Admin API
  → 成功：存储 access token + refresh token → syncConnections → 进入主界面
  → 失败：显示错误信息
```

### Phase 0: 基础设施

#### 0.1 新增 Admin 凭证类型

**文件**: `packages/shared/src/credentials/types.ts`
- 新增 `CredentialType: 'admin_token'`（存储 access token + refresh token + 过期时间）
- 更新 `VALID_CREDENTIAL_TYPES`
- `credentialIdToAccount()` 处理 → `admin_token::global`

**文件**: `packages/shared/src/credentials/manager.ts`
- 新增便捷方法：
  - `getAdminTokens(): Promise<{ accessToken, refreshToken, expiresAt, userId, username } | null>`
  - `setAdminTokens(data): Promise<void>`
  - `deleteAdminTokens(): Promise<boolean>`
- `StoredCredential.value` 存 access token，`refreshToken` 字段存 refresh token，`expiresAt` 存过期时间戳

#### 0.2 创建 Admin Client 模块

**新建 `packages/shared/src/admin/` 目录**:

- `types.ts` — 类型定义：
  - `AdminUser { id, username, displayName, role, groupIds }`
  - `AdminLoginResponse { accessToken, refreshToken, expiresIn, user }`
  - `AdminRefreshResponse { accessToken, refreshToken, expiresIn }`
  - `AdminValidateResponse { valid, user, configVersion }`
  - `AdminLlmConnectionsResponse { configVersion, connections[], defaultConnection }`
  - `AdminErrorCode` union type
  - `AdminError` class

- `client.ts` — `AdminClient` class：
  - 构造器接收 `adminUrl: string`
  - `login(username, password)` → `POST /api/auth/login`
  - `refresh(refreshToken)` → `POST /api/auth/refresh`
  - `validate(accessToken)` → `POST /api/auth/validate`
  - `logout(refreshToken)` → `POST /api/auth/logout`
  - `getLlmConnections(accessToken)` → `GET /api/llm-connections`
  - 统一错误处理 → `AdminError`
  - 原生 `fetch()`

- `index.ts` — barrel export

#### 0.3 Server Config 扩展

**文件**: `packages/shared/src/config/storage.ts`
- `StoredConfig` 新增 `adminUrl?: string`, `adminConfigVersion?: string`
- 新增 getter/setter

### Phase 1: RPC 通道 + Handler

#### 1.1 新增 RPC 通道

**文件**: `packages/shared/src/protocol/channels.ts`
```typescript
admin: {
  LOGIN: 'admin:login',
  VALIDATE: 'admin:validate',
  LOGOUT: 'admin:logout',
  GET_STATUS: 'admin:getStatus',
  SYNC_CONNECTIONS: 'admin:syncConnections',
},
```

#### 1.2 路由分类

所有 `admin.*` → `LOCAL_ONLY`。

#### 1.3 创建 Admin RPC Handler

**新建**: `packages/server-core/src/handlers/rpc/admin.ts`

Handler 逻辑：

- **admin:login(username, password)**:
  1. 读取 `adminUrl` → `AdminClient(adminUrl).login(username, password)`
  2. 存储 tokens：`CredentialManager.setAdminTokens({ accessToken, refreshToken, expiresAt, userId, username })`
  3. 调用 syncConnections
  4. 返回 `{ success, user }` 或 `{ success: false, errorCode, message }`

- **admin:validate**:
  1. 加载 tokens → 检查 access token 是否过期
  2. 如过期 → `AdminClient.refresh(refreshToken)`
     - 成功 → 更新存储的 tokens
     - 失败 → 清除 tokens → 返回 `{ loggedIn: false }`
  3. 调用 `AdminClient.validate(accessToken)`
  4. 对比 `configVersion`，变化则 syncConnections
  5. 返回 `{ loggedIn: true, user, configVersion }`

- **admin:logout**:
  1. 加载 tokens → `AdminClient.logout(refreshToken)`（失败也继续）
  2. 清除 tokens + 删除 `managedBy: 'admin'` 的连接
  3. 返回 `{ success: true }`

- **admin:getStatus**:
  1. 纯本地状态：`{ adminUrl, loggedIn, username, displayName }`

- **admin:syncConnections**:
  1. `AdminClient.getLlmConnections(accessToken)` 获取连接
  2. 映射 Admin 格式 → `LlmConnection`（`managedBy: 'admin'`）
  3. 存储 API Key → `CredentialManager.setLlmApiKey(slug, key)`
  4. 清理已移除的连接，设置 default，更新 configVersion

#### 1.4 Token 自动刷新

在 Admin Client 的所有需要 access token 的方法中，如果收到 401：
1. 尝试用 refresh token 刷新
2. 刷新成功 → 用新 access token 重试原请求
3. 刷新失败 → 抛出错误，上层处理（通知 renderer 重新登录）

这个逻辑封装在 `AdminClient` 内部，调用方无感。

#### 1.5 注册 Handler

**文件**: `packages/server-core/src/handlers/rpc/index.ts`
- import 并调用 `registerAdminHandlers(server, deps)`

### Phase 2: Auth State 双模式

**文件**: `packages/shared/src/auth/state.ts`

`getAuthState()` 新增：
- 读取 `getAdminUrl()` → 有值则 admin 模式
- 检查 `CredentialManager.getAdminTokens()` → 是否已登录
- 返回 `authState.admin = { configured, loggedIn, username }`

`getSetupNeeds()` 新增：
- `adminUrl` 存在 + 无 tokens → `needsAdminLogin: true`
- admin 已登录 + 有连接 → `isFullyConfigured: true`
- admin 模式下抑制 `needsBillingConfig` 和 `needsCredentials`

### Phase 3: Electron Renderer UI

> **视觉参考**: `docs/prototype-login.html`（Python HTTP server 启动后可在浏览器中预览）
> 右上角场景切换器可切换所有状态，实现时不需要场景切换器本身。

#### 3.1 Admin 登录页

**新建**: `apps/electron/src/renderer/components/onboarding/AdminLoginStep.tsx`

布局：居中 glass card（`max-width: 24rem`，圆角 20px，backdrop-filter blur）

内容从上到下：
1. **品牌 logo**：Polo AI 图标（48×48，accent 渐变圆角方块）
2. **标题**："Polo AI" + 副标题 "请输入你的账号和密码"
3. **错误提示区**（条件渲染）：红色背景条 + AlertTriangle 图标 + 错误文案，带 slideUp 动画
4. **表单**：
   - 用户名输入框（label "用户名"，placeholder "请输入用户名"）
   - 密码输入框（label "密码"，placeholder "请输入密码"）+ 右侧眼睛按钮切换明文/密文
   - 登录按钮：全宽、accent 色、hover 上浮、disabled 时半透明
   - loading 态："登录中…" + spinner
5. **没有**"忘记密码"链接（S-005：管理员手动重置）
6. **没有** Admin URL 输入、没有模式切换

错误码映射（来自 Admin API）：
- `INVALID_CREDENTIALS` → "用户名或密码错误"（S-001，统一模糊提示）
- `ACCOUNT_DISABLED` → "账号已被禁用，请联系管理员"（S-006）
- 网络错误 / fetch 失败 → "网络连接失败，请检查网络后重试"（S-001）

#### 3.2 被踢下线页面（S-012）

**新建**: `apps/electron/src/renderer/components/onboarding/AdminKickedStep.tsx`

独立全屏页面（不是 toast），居中 card 布局：
- Monitor 图标（大号，info 色）
- 标题："已在其他设备登录"
- 说明文案："你的账号已在另一台设备上登录。同一账号只能在一台设备上使用。"
- "重新登录"按钮 → 回到登录页

触发时机：refresh token 刷新返回 `TOKEN_REVOKED` 或 401 时显示此页面。

#### 3.3 侧边栏用户菜单（S-004 登出 + S-014 用量）

**修改**: LeftSidebar 底部

侧边栏底部新增固定区域：
- 用户头像（首字母，accent 渐变圆形）+ 显示名 + 展开箭头
- 点击弹出向上展开的菜单：

菜单结构（从上到下）：
1. **用户信息头部**：显示名 + @username
2. **用量进度条**（S-014）：
   - 标签 "本月用量" + 已用/总额数字
   - 进度条：正常=accent色，预警(≥80%)=info黄色，耗尽=destructive红色
   - 预警文案（S-015）："额度已使用 82%"
   - 耗尽文案（S-016）："本月额度已用完，{resetDate} 重置"
   - 底部显示重置日期
3. **菜单项**：
   - 个人信息
   - Settings（从侧边栏导航移到这里）
   - What's New（从侧边栏导航移到这里，带 accent 小圆点）
   - ──分割线──
   - 登出（destructive 红色）→ 点击调用 `admin:logout` → 回到登录页

**侧边栏导航变更**：移除原来的 Settings 和 What's New NavItem。

#### 3.4 模型选择器 Admin 锁定（S-009）

**修改**: ChatInputZone 中的模型选择器下拉菜单

现有模型选择器按钮增加：
- 锁图标（Lock，fg-30 色，表示管理员管理）

点击展开的下拉菜单：
- 顶部 header："AI 模型" + 右侧标签 "管理员配置"（accent 色 + Shield 图标）
- 模型列表：每项显示 provider 图标（彩色圆角方块）+ 模型名 + provider 名，选中项打勾
- 底部说明："模型由管理员统一配置，不可添加或删除"（Lock 图标 + fg-30 色文字）
- 用户可以切换默认模型，但不能添加/删除

**不在侧边栏加独立"AI 模型"入口**，模型切换只在聊天输入框的下拉菜单中。

#### 3.5 聊天区状态 Banner

**修改**: ChatPage，在 ChatInputZone 上方条件渲染 banner

| 场景 | Banner 样式 | 文案 | 输入框状态 |
|------|------------|------|-----------|
| S-013 未配置 AI | info 黄色背景 + AlertTriangle | "管理员尚未为你配置 AI 服务，暂时无法发送消息" | disabled |
| S-016 额度用完 | destructive 红色背景 + AlertTriangle | "本月额度已用完，下个周期将自动重置" | disabled |
| S-007 在线被禁用 | destructive 红色背景 + AlertTriangle | "账号已被禁用，请联系管理员。当前会话内容不受影响。" | disabled（下次发消息时触发） |

Banner 带 slideUp 进入动画。

#### 3.6 修改 Onboarding 状态机

**文件**: `apps/electron/src/renderer/hooks/useOnboarding.ts`
- 新增 `'admin-login'` 和 `'admin-kicked'` step
- `setupNeeds.needsAdminLogin` → 起始 step = `'admin-login'`
- 登录成功 → 跳到 `'complete'`
- refresh 被 revoke → 跳到 `'admin-kicked'`

#### 3.7 扩展 Preload API

**文件**: `apps/electron/src/preload/bootstrap.ts`
- 新增：`adminLogin()`, `adminValidate()`, `adminLogout()`, `adminGetStatus()`, `adminSyncConnections()`

### Phase 4: LLM 连接同步

#### 4.1 连接模型扩展

**文件**: `packages/shared/src/config/llm-connections.ts`
- `LlmConnection` 新增 `managedBy?: 'admin'`
- Admin 模式下 Settings UI 禁用添加/编辑/删除

#### 4.2 连接映射

| Admin 字段 | LlmConnection 字段 |
|-----------|-------------------|
| `slug` | `slug` |
| `providerType` | `providerType` |
| `authType` | `authType` |
| `models` | `models` |
| `defaultModel` | `defaultModel` |
| `apiKey` (明文) | → `CredentialManager.setLlmApiKey()` |
| — | `managedBy: 'admin'` |

### Phase 5: 启动 + 登出集成

#### 5.1 App 启动流程

**文件**: `apps/electron/src/renderer/App.tsx`

修改 `initialize`：
1. 获取 setup needs
2. `needsAdminLogin` → 尝试 `adminValidate()`（内含 token 自动刷新）
   - 成功 → sync + 进入主界面
   - 失败 → onboarding `'admin-login'` step
3. 其他 → 正常流程

#### 5.2 休眠恢复

**文件**: `apps/electron/src/main/index.ts`
- `powerMonitor.on('resume')` → 触发 `admin:validate`
- 失败 → 通知 renderer 重新登录

#### 5.3 登出

侧边栏左下角用户菜单中（不在 Settings 中）：
- 点击"登出"→ `admin:logout` → 清除 tokens + 连接 → 回到登录页
- 参见 Phase 3.3 的菜单结构

---

## 模式判断

| 条件 | 模式 | 行为 |
|------|------|------|
| Server 无 `ADMIN_API_URL` | 独立模式 | 现有流程不变 |
| Server 有 `ADMIN_API_URL` + 无 token | Admin 待登录 | 显示登录页 |
| Server 有 `ADMIN_API_URL` + 有效 token | Admin 已登录 | 直接进入主界面 |
| Server 有 `ADMIN_API_URL` + access token 过期 | 静默刷新 | 用 refresh token 自动换新 |
| Server 有 `ADMIN_API_URL` + refresh token 也失效 | 需重登录 | 显示登录页 |

---

## Admin 侧需要的配合改动

Polo AI 侧的实现依赖 Admin 提供以下端点：

| 端点 | Admin 现状 | 需要做的 |
|------|-----------|---------|
| `POST /api/auth/login` | ✅ 已有 | 响应增加 `refreshToken` + `expiresIn` |
| `POST /api/auth/refresh` | ❌ 不存在 | **新建**：验证 refresh token → 签发新 pair |
| `POST /api/auth/validate` | ❌ 不存在 | **新建**：验证 access token → 返回用户信息 + configVersion |
| `POST /api/auth/logout` | ❌ 未实现 | **新建**：revoke refresh token |
| `GET /api/llm-connections` | ❌ 不存在 | **新建**：返回用户的 LLM 连接配置（明文 API Key） |

Admin 侧需要新增 `refresh_tokens` DB 表（见 Part A 第 1 节）。

**不需要**：sessions 表、撤销缓存、jti 追踪、用户组。

---

## 实现顺序

| 序号 | Phase | 关键文件 | 依赖 |
|------|-------|---------|------|
| 1 | Phase 0: 基础设施 | `credentials/types.ts`, `manager.ts`, `admin/client.ts`, `config/storage.ts` | — |
| 2 | Phase 1: RPC + Handler | `protocol/channels.ts`, `handlers/rpc/admin.ts`, `handlers/rpc/index.ts` | 1 |
| 3 | Phase 2: Auth State | `auth/state.ts` | 1 |
| 4 | Phase 3: Electron UI | `AdminLoginStep.tsx`, `AdminKickedStep.tsx`, `UserMenu`, 模型选择器锁定, 聊天区 Banner, `useOnboarding.ts`, `bootstrap.ts` | 2, 3 |
| 5 | Phase 4: 连接同步 | `llm-connections.ts`（模型扩展）+ handler 中的 sync 逻辑 | 1, 2 |
| 6 | Phase 5: 集成 | `App.tsx`, `main/index.ts`, LeftSidebar（移除 Settings/What's New 导航） | 3, 4, 5 |

---

## 验证方案

1. **单元测试**：Admin Client（mock fetch）、token 刷新逻辑、连接映射
2. **手动验证**：
   - 启动 Admin + Polo AI（设 ADMIN_API_URL），Electron 中登录
   - 等 access token 过期 → 验证静默刷新无感
   - Admin 侧 revoke refresh token → 验证下次刷新时弹出登录
   - 不设 ADMIN_API_URL → 独立模式不受影响
3. **i18n**：新增翻译 key，运行 `bun run validate:ci`
4. **类型检查**：`bun run typecheck:all`
