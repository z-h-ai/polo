# POL-51 Reviewer 第 2 轮修复报告

## 逐条 Issue 处理结果

### 1. 受限离线冷启动无法恢复组织上下文

- 已修复。新增按 `accountId` 隔离的最近验证组织上下文缓存，持久化组织摘要、活跃组织和成员身份，并在读取时用 Admin schema 重新校验。
- `organizationList` 遇到网络错误、超时或 5xx 时恢复最近验证的活跃成员身份；401、403、账号禁用、成员移除/暂停和组织不可用仍 fail closed，并清除对应账号的组织缓存。
- 在线组织列表、组织激活和刷新成功后都会更新验证缓存；登出/账号清理时同步删除。
- 新增有效 token 离线、过期 token 刷新网络失败、明确 403，以及从组织恢复到 `HomePage` 并启动已准备本地 App 的交互回归。

### 2. A 登录态下切换登录 B 未清理 A

- 已修复。密码登录和手机登录共用的 `completeAdminLogin` 在写入新 token 前读取旧可信 session。
- 旧、新 `accountId` 不同时，先调用 `onAdminSessionEnding(oldAccountId)`，再清理旧账号的 Admin-managed connection、凭据和 Catalog 授权，全部成功后才替换 token。
- 同账号重新登录不会停止自身运行实例；旧账号清理失败时不写入 B 的凭据，保持 fail closed。
- 新增密码 A→B、手机 A→B、同账号重登和清理失败四类主进程回归测试。

### 3. running 状态隐藏可用更新

- 已修复。卡片先处理安装/启动等 busy 状态，再依据 `availableRelease` 派生更新操作。
- 在线的 `running@1.0.0 + Catalog@2.0.0` 同时提供“打开”次操作和“更新”主操作；受限离线时只保留“打开”，不允许下载更新。
- 安装确认弹窗也以实际 `availableRelease` 判断更新，不依赖状态必须等于 `update_available`。
- 新增 running 在线更新和离线打开回归测试。

### 4. 无效 Catalog 版本覆盖最后可信 Release

- 已修复。Catalog cache schema 升级到 v2，独立持久化每个 Catalog App 的 `trustedReleases` 和稳定 `invalid_semver` warning。
- 有效 Release 会更新可信元数据；后续第四段或其他无效 SemVer 只更新服务端原始目录数据，不覆盖最后可信 Release。
- v1 缓存读取时迁移有效 Release；批量运行状态派生会结合可信 Release 保留更新信息，并对 installed/available 任一侧无效版本返回 `versionError: invalid_semver`。
- 新增空状态 valid→invalid、v1 迁移、installed invalid、available invalid 和 UI 可见性测试。

### 5. fresh/未登录/清空最近记录时内置 App 不可见

- 已修复。最近使用仍只显示真实最近记录；当最近记录为空时，显示独立标识和说明的内置 App 启动器，不把内置 App 伪装成最近使用记录。
- 内置 App 继续从外部应用分区排除，点击后正常打开并写入最近记录。
- 新增 fresh localStorage、未登录、清空最近记录及点击启动回归测试。

### 6. 10,000 项目录更新后缓存可能膨胀到 10,001 项

- 已修复。可见目录优先占用 10,000 项容量，撤下记录只使用剩余容量；替换或撤下一项都不会突破 schema 上限。
- 写盘前对最终 v2 结构做完整 schema 校验，再原子替换缓存文件。
- 可信 Release 只保留仍在有界缓存中的本地 Bundle App，避免旁路元数据无界增长。
- 新增 10,000→10,000 替换、撤下一项后读回和授权拒绝边界测试。

### 7. 首页直接展示 RPC/服务端原始错误文案

- 已修复。Catalog 同步状态只在 renderer 保存稳定 `warningCode` / `errorCode`，不保存服务端 `message`。
- 新增统一错误码映射，安装、打开、取消、停止、卸载、日志、broken 状态和 Catalog 警告/错误全部通过 `t()` 输出用户文案；原始 message 不进入普通 UI。
- Admin Catalog RPC 补充 `warningCode`，区分网络离线、授权失败和 `INVALID_SEMVER`。
- 7 个现有 locale 已补齐并排序；新增中文 locale 回归，确认技术详情不会泄漏到 toast、警告或错误状态。

### 8. verifying 阶段不可观察

- 已修复。下载阶段只完成流式落盘和大小校验；SHA-256 文件读取与 checksum 比较移动到 `verifying` 阶段，完成后才进入 `extracting`。
- 安装管理器增加可选阶段观察回调，宿主和测试可以消费真实阶段事件。
- 新增受控安装测试，断言 `downloading → verifying → extracting → preparing` 顺序，并在校验尚未完成时读取到 `verifying` 运行状态。

## 关键文件

- `apps/electron/src/renderer/hooks/useOrganizationContext.ts`
- `apps/electron/src/renderer/lib/organization-storage.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/lib/home-app-errors.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/local-app-runtime/manager.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/admin/types.ts`
- `packages/shared/src/i18n/locales/*.json`
- 对应的 main、renderer、shared 和 server-core 回归测试文件

## 自测结果

- `bun run test`：通过。普通套件 4,774 pass、19 skip、0 fail；随后全部 18 个 `*.isolated.ts` 文件均通过、0 fail。
- `bun run typecheck:all`：通过。
- `bun run lint:i18n:parity`：通过，6 个非英文 locale 与英文基线均为 1,702 keys。
- `bun run lint:i18n:sorted`：通过。
- `bun run lint:i18n:coverage`：通过。
- `bun run electron:build`：通过；main、preload、renderer、resources 和 assets 均构建成功，仅保留既有 Vite chunk size warning。
- `bun run lint:electron`：通过，0 error；仓库现有及本轮测试/组织缓存触发 120 个 warning。
- `git diff --check`：通过。

定向回归包括：

- `useOrganizationContext.isolated.ts`：12 pass，0 fail。
- `HomePage.offline-start.interaction.isolated.ts`：1 pass，0 fail。
- `HomePage.round2.interaction.isolated.ts`：2 pass，0 fail。
- `useAppCatalog.interaction.isolated.ts`：6 pass，0 fail。
- `OrganizationAppCard.test.ts`：4 pass，0 fail。
- `admin.isolated.ts`：31 pass，0 fail。
- `local-apps.isolated.ts`：7 pass，0 fail。
- `app-catalog-cache.test.ts`：8 pass，0 fail。
- `manager.test.ts`：包含新增阶段可观察性用例，全部通过。

## 遗留问题

- 根级 `bun run lint` 在本工作树中会先因仓库缺少 `scripts/check-raw-sends.sh` 和 `scripts/check-task-tool-checks.sh` 退出；改为分别执行现存 lint 入口。
- `lint:shared` 仍有 5 个与本任务无关的既有 `source.config.isAuthenticated` 规则错误；`lint:ui` 仍有 3 个与本任务无关的既有 inline `boxShadow` 规则错误。本轮未越界修改这些文件。
- 未连接真实 POL-52 服务和生产签名 Bundle 做端到端联调；本轮问题已通过主进程 RPC、renderer 交互、全量测试、类型检查和生产构建覆盖。
- 工作树中的三份未跟踪规格文档为本轮开始前已有文件，本轮未修改、未纳入提交。
