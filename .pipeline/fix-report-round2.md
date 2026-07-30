# POL-51 Reviewer 第 2 轮修复报告

## 逐条问题处理结果

### 1. 会话结束清理失败必须继续 fail closed

- 已修复。`endAdminSession` 现在捕获并记录 `onAdminSessionEnding` 的本地进程停止失败，随后仍在最终 generation CAS 内推进会话代次、拒绝该账号的 Catalog 授权与 access mode，并删除快照凭据。
- CAS 内的二次连接清理失败也不会阻断凭据删除；失败会记录为清理警告，退出结果仍完成本地 fail-closed 收口。
- 覆盖过期 token 刷新 401、Catalog 403 和正常退出三条可信会话结束链路；均验证本地停止抛错后凭据已删除、Catalog 已 denied。
- remote URL 解析补充 Catalog 自身 `authorizationStatus = denied` 的回归，确保即使 access mode 残留为 online 也不能打开旧组织 URL。

### 2. App 与 Home 启动同步竞态

- 已修复。主进程对被新请求替代的 Catalog 同步统一返回显式 `REQUEST_SUPERSEDED`，不再把当时缓存伪装为本次成功结果。
- `useAppCatalog` 遇到 `REQUEST_SUPERSEDED` 会在当前账号、组织和 generation 仍匹配时重读最终提交目录；重试次数有明确上限，组织或账号切换后立即丢弃旧 continuation。
- 覆盖无缓存启动竞态和已有缓存刷新竞态，均验证 Home 最终收到后发请求提交的目录，而不是停留在空目录或旧缓存。

### 3. withdrawn tombstone 优先保留本地数据

- 已修复。Catalog 保存接口接收必须保留的 withdrawn Catalog ID 集合，裁剪 10,000 条 tombstone 时先保留这些 ID，再用其余候选填满容量。
- Electron 主进程在提交新 Catalog 前，从 scoped runtime registry 按 `accountId + organizationId` 读取确有安装或运行数据的 Catalog ID，并传给缓存层；读取按 10,000 scope 分批，未物化、无安装记录的 scope 不会被误保留。
- 当必须保留的本地数据项本身超过缓存契约上限时显式失败，不会静默丢弃已安装项。
- 覆盖“10,000 tombstone 已满 + 新撤下项 + 原裁剪候选已安装”，并验证 scoped registry 只返回确有本地安装数据的 ID。

### 4. 首次状态批次失败时保留 withdrawn 管理入口

- 已修复。首页选择 withdrawn App 时，同时接受可信本地状态或该完整 scope 的状态读取失败标记；首次读取失败不再把可能已安装的 tombstone 从页面过滤。
- 状态未知的 withdrawn Bundle 以“状态不可用”的禁用卡片展示，主启动操作保持禁用，但仍提供停止、日志和卸载入口以及页面级重试。
- 覆盖首次批次失败、无已缓存 renderer 状态但实际保留的 withdrawn App，验证卡片、禁用主操作、重试提示和三项本地管理入口均存在。

### 5. IPC wire-format 快照

- 已修复。`local-apps:resolveRemoteUrl` 已加入排序后的 IPC channel 快照。
- 快照回归验证通道总数为 351。

### 6. 全量测试

- 已修复 Reviewer 报告中的 2 个失败测试，并重新执行完整 `bun run test`。
- 常规测试阶段结果为 4782 pass、19 skip、0 fail，共 4801 tests / 363 files。
- 命令后半段逐文件运行的全部 `*.isolated.ts` 测试也通过，完整命令退出码为 0。

## 关键文件

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `packages/server-core/src/handlers/handler-deps.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/admin/__tests__/app-catalog-cache.test.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
- `apps/electron/src/shared/__tests__/ipc-channels.test.ts`

## 自测结果

- `bun run test`
  - 完整通过，退出码 0。
  - 常规阶段：4782 pass、19 skip、0 fail，4801 tests / 363 files。
  - 后半段全部 isolated 测试逐文件通过。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 44 pass，0 fail。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
  - 13 pass，0 fail。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
  - 6 pass，0 fail。
- Catalog cache、scoped registry 与 IPC channel 联合回归
  - 26 pass，0 fail；IPC 通道精确为 351。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
  - 9 pass，0 fail。
- `bun run typecheck:all`
  - 通过。
- `bun run lint:i18n:parity`
  - 通过，6 个 locale 各 1706 keys。
- `bun run lint:i18n:sorted`
  - 通过。
- `bun run lint:i18n:coverage`
  - 通过。
- 变更文件定向 ESLint
  - 0 error；3 个测试环境既有 `localStorage` 规则 warning。
- `git diff --check`
  - 通过。

## 遗留问题

- SemVer 三份实现仍按 Reviewer 第 1 轮报告中的风险判断保留，未在本轮阻断修复中扩大重构范围。
- 无其他已知阻断问题。
