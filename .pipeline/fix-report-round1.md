# POL-51 Reviewer 第 1 轮修复报告

## 逐条问题处理结果

### 1. 过期 token 刷新失败的离线白名单

- 已修复。`ensureValidTokens` 现在只允许 `NETWORK_ERROR`、`SERVER_ERROR` 和 HTTP 5xx 等明确临时错误沿用最近验证身份进入受限离线模式。
- HTTP 400、`VALIDATION_ERROR`、未知 4xx 及其他未归类刷新异常均结束当前可信 Admin 会话、清理凭据并 fail closed，不再携带旧身份返回 offline。
- 新增 HTTP 400、`VALIDATION_ERROR`、未知 422 回归覆盖，同时保留既有网络失败离线启动测试。

### 2. Catalog NOT_FOUND 后的旧目录与 remote_url 授权

- 已修复。renderer 收到 `NOT_FOUND` 或其他明确失权结果后立即清除旧 Catalog、运行状态与警告，并提交 `accessMode = denied` 投影。
- 新增 `local-apps:resolveRemoteUrl` 强类型 RPC。组织远程 App 打开前，主进程会用当前可信账号、Catalog 缓存、授权状态、App 可见性和交付类型重新校验，并只返回缓存中的可信 URL。
- renderer 不再直接用旧 `remoteUrl` 打开 WebView；组织/账号切换后的迟到解析结果仍受 context generation 校验。
- 覆盖“先成功缓存、后 NOT_FOUND”、旧 remote card 点击不打开 WebView，以及主进程 denied 后拒绝 URL 解析。

### 3. 批量运行状态的部分失败

- 已修复。状态读取按 10,000 项逐批提交成功结果；单批失败不再丢弃其他批次，也不再构造 `not_installed`。
- 失败 scope 保留上次可信状态；从未成功读取的 scope 记录为“状态不可用”，卡片禁用安装/打开主操作，避免把未知状态误判为未安装。
- 增加可见的状态读取失败提示和重试入口；完整重试成功后清除失败 scope。
- 覆盖第二批失败、第一批成功、失败批次保留旧状态、未知状态不合成 `not_installed`、重试恢复。

### 4. 最大目录渲染性能

- 已修复。首页仅纳入当前可见 App，以及确有可信本地运行/安装状态的 withdrawn Bundle App。
- 组织应用采用每段 60 张卡片的渐进加载，首屏不再一次渲染约 20,000 张复杂卡片。
- 覆盖 `10,000 visible + 10,000 withdrawn`：首屏 60 张、仅保留有本地数据的 withdrawn App、加载更多后 120 张。

### 5. SemVer 实现统一建议

- 本轮未统一。当前三处实现位于缓存迁移/可信 Release 保留、主进程授权运行态派生和 renderer 展示层，直接抽取会扩大本轮安全修复的迁移与依赖风险。
- 既有 SemVer 2.0、前导 `v`、prerelease、无效版本可见性测试继续保留；建议后续独立重构为 shared 纯函数并做三层替换。

## 关键文件

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
- `packages/shared/src/protocol/local-apps.ts`
- `packages/shared/src/protocol/channels.ts`
- `packages/shared/src/protocol/routing.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/transport/channel-map.ts`
- `packages/shared/src/i18n/locales/*.json`

## 自测结果

- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 44 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
  - 9 pass，0 fail。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
  - 11 pass，0 fail。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
  - 5 pass，0 fail。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.offline-start.interaction.isolated.ts`
  - 1 pass，0 fail。
- 协议路由、handler 注册、channel map、`OrganizationAppCard` 联合回归
  - 23 pass，0 fail。
- `bun run typecheck:all`
  - 通过。
- `bun run lint:i18n:parity`
  - 通过，6 个非英文 locale 与英文各 1706 keys。
- `bun run lint:i18n:sorted`
  - 通过。
- `bun run lint:i18n:coverage`
  - 通过。
- 变更文件定向 ESLint
  - 0 error；3 个既有测试 `localStorage` 规则 warning。
- `git diff --check`
  - 通过。

## 遗留问题

- SemVer 三份实现尚未统一，原因见第 5 项；不影响本轮阻断问题闭环。
- 无其他已知阻断问题。
