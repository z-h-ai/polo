# POL-51 第 3 轮阻塞审查修复报告

## 逐项处理结果

### 1. Home recent GET/SET 错误路由到远程 workspace

已修复。

- 将 `GET_HOME_RECENT_APPS`、`SET_HOME_RECENT_APPS` 从
  `REMOTE_ELIGIBLE_CHANNELS` 移除并加入 `LOCAL_ONLY_CHANNELS`。
- RoutedClient 在远程 workspace 已连接时仍将两个调用交给设备本地
  client，远程 client 不会收到 launcher 历史。
- 新增 routing 集合穷尽检查和 RoutedClient 真实路由回归，覆盖 GET 与
  SET 两个方向。

### 2. 组织快照和 unavailable tombstone 使用 localStorage

已修复。

- 新增 browser-safe 的组织上下文 preferences 类型，以及
  `GET_ORGANIZATION_CONTEXT_STORAGE` /
  `UPDATE_ORGANIZATION_CONTEXT_STORAGE` 两个设备本地 RPC。
- 已验证组织快照和 unavailable tombstone 现在写入 Electron
  `preferences.json`，按完整 account entity ID 隔离；RPC 与配置校验接受
  512 字符、NUL、冒号和 Unicode 等合法实体 ID。
- renderer bootstrap 先从本地 preferences hydrate，并在账号 generation
  校验后提交，账号切换后的迟到读取不会污染新账号状态。
- 旧 `polo-verified-organization-context:*`、
  `polo-unavailable-organization:*` 和 active organization localStorage
  值仅用于一次性兼容读取；只有 durable RPC 写入成功后才清理，写入失败
  时保留旧值以便后续重试。
- 组织失权的 verified snapshot 与 tombstone 通过同一次 patch 原子写入，
  恢复授权时也在同一次 patch 中清除 tombstone。
- 通用 preferences WRITE 会保留隐藏的组织上下文字段，避免旧设置写入
  覆盖新持久化数据。

## 关键文件

- `packages/shared/src/protocol/routing.ts`
- `packages/shared/src/protocol/__tests__/routing.test.ts`
- `apps/electron/src/transport/__tests__/routed-client.test.ts`
- `packages/shared/src/config/organization-context.ts`
- `packages/shared/src/config/preferences.ts`
- `packages/shared/src/config/validators.ts`
- `packages/shared/src/protocol/channels.ts`
- `packages/server-core/src/handlers/rpc/settings.ts`
- `apps/electron/src/transport/channel-map.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/renderer/lib/organization-storage.ts`
- `apps/electron/src/renderer/hooks/useOrganizationContext.ts`
- `apps/electron/src/renderer/lib/__tests__/organization-storage.isolated.ts`
- `packages/shared/src/config/__tests__/home-recent-apps.test.ts`

## 实际运行的测试与结果

- `bun run test`
  - 通过（exit 0）。
  - 常规套件：4,833 pass，19 skip，0 fail。
  - 仓库脚本随后逐文件运行全部 `*.isolated.ts`，全部通过。
- 路由、RPC 与配置定向测试：
  - `bun test packages/shared/src/protocol/__tests__/routing.test.ts apps/electron/src/transport/__tests__/routed-client.test.ts packages/shared/src/config/__tests__/home-recent-apps.test.ts apps/electron/src/shared/__tests__/ipc-channels.test.ts`
  - 33 pass，0 fail。
- renderer 持久化与组织上下文定向测试（按 isolated 文件逐个运行）：
  - `organization-storage.isolated.ts`：3 pass，0 fail。
  - `useOrganizationContext.isolated.ts`：14 pass，0 fail。
  - `HomePage.offline-start.interaction.isolated.ts`：1 pass，0 fail。
  - `App.organization-deep-link.interaction.isolated.ts`：6 pass，0 fail。
- `bun run validate:ci`
  - 通过；全部 workspace typecheck、shared config 测试、19 个文档工具
    smoke tests，以及 i18n parity（6 locales / 1706 keys）、sorted、
    coverage 均通过。
- `bun run lint:electron`
  - 通过（0 errors，120 warnings）；warnings 为仓库既有规则告警及测试中的
    legacy localStorage 迁移/隔离清理调用。
- `bun run electron:build`
  - 通过；main、preload、renderer、resources、assets 均构建成功，
    renderer production build 转换 5,582 modules。
- `git diff --check`
  - 通过。

## 遗留问题

- 本轮两个 review issues 无已知遗留。
- worktree 中本轮开始前已有的 `.pipeline/fix-report-round4.md` 删除，
  `design-demos/` 和 `docs/spec-home-app-admin-config*.md` 未跟踪文件均未
  修改、未纳入本轮提交。
