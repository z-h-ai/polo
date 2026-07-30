# POL-51 Reviewer 第 3 轮修复报告

## 逐条 Issue 处理结果

### 1. 明确失权码未进入共享错误契约

- 已修复。将 `MEMBERSHIP_REMOVED`、`MEMBERSHIP_SUSPENDED`、`ORGANIZATION_UNAVAILABLE` 加入 `AdminErrorCode`、Admin Client 受信允许列表、大小写别名和安全文案。
- Catalog 授权失败及会话结束判定现在按错误码语义处理，不再依赖 HTTP 401/403；409/423 携带明确失权码时会 deny 缓存、关闭离线启动权限并结束可信账号会话。
- 新增 Client 契约和主进程回归，覆盖非 401/403 状态下三个失权码的保留、deny、账号清理及禁止离线启动。

### 2. 在线组织列表未原子撤销旧组织上下文

- 已修复。在线 `organizationList` 成功结果现在是新的授权真相：只接受组织未暂停且成员身份为 `active` 的条目。
- renderer 按 `accountId` 原子覆盖最近验证组织摘要；旧活跃组织缺失、组织暂停或成员非 active 时同步清除验证上下文和已存选择，之后网络失败不能恢复旧授权。
- 主进程同时遍历该账号已有 Catalog 缓存，对成功列表中缺失或非 active 的组织设置 `authorizationStatus=denied` 和生命周期访问门禁。
- 新增 active→空列表→离线、active→暂停→离线回归，确认不恢复组织且不能启动本地 App。

### 3. cached 403 返回成功导致 renderer 保持登录态

- 已修复。命中缓存后的明确 Catalog 403 先 deny 缓存并结束可信主进程会话，再返回 `success:false` 的稳定 Admin auth failure。
- `useAppCatalog` 将该失败送入统一 auth-failure 事件；`App` 收到后清空账号和组织上下文并回到登录流程。
- 新增主进程、hook 和 App 级回归，覆盖 cached 403 从 Catalog 同步到 App 清理登录态的完整链路。

### 4. 登出与并发本地 App 生命周期存在逃逸竞态

- 已修复。scoped registry 为账号增加 `session-ending` 门禁，`stopAccount` 在任何异步等待前同步关闭新 Catalog RPC，并复用同一账号的并发清理任务。
- 安装、启动、停止、重启、更新、卸载、日志和批量状态等操作均按账号跟踪；清理会取消安装、等待已有操作及 manager 创建静止、重新扫描持久化 scope，再停止该账号全部进程。
- 清理失败返回 `STOP_FAILED`，账号继续保持关闭门禁且凭据不会删除；只有新的可信登录通过 `resumeAccount` 重新开放。
- Admin 登出、认证失效和通用登出链路均不再吞掉本地清理错误。
- 新增新 scope 竞态、慢安装取消与清理等待、慢启动与登出竞态、停止失败保留凭据/门禁及可信重登恢复回归。

### 5. 满载目录替换会丢失撤下 App 元数据

- 已修复。Catalog cache schema 升级到 v3，将最多 10,000 个当前可见 App 与最多 10,000 个撤下 tombstone 分开持久化；撤下元数据不再占用可见目录容量。
- 满载目录替换时优先保留本次新撤下记录，并继续保留有界历史 tombstone；授权拒绝会同时把可见与撤下记录标记为不可用。
- 首页和运行状态读取统一合并两类元数据，因此已安装、运行中或最近使用的撤下 App 仍可显示原因，但主进程拒绝新增启动。
- 增加浏览器安全的 Catalog 投影视图模块，renderer 不会因读取 tombstone 引入 Node 文件系统缓存实现。
- 新增 10,000→10,000 替换、满载撤下一项后读回/deny、UI 可见和启动拒绝回归。

### 6. 安装阶段文案未优先使用实际 progress phase

- 已修复。卡片先根据 `progress.phase` 显示 downloading、verifying、extracting、preparing，再回退到顶层安装状态和更新安装状态。
- 新增 `extracting` 国际化文案并补齐全部现有 locale。
- 新增 `status=installing + phase=verifying/extracting` 卡片回归，确认慢校验和解压阶段可见。

### 7. Catalog 授权键函数缺少业务语义

- 已修复。`key` 重命名为 `createAppCatalogAccessKey`，所有读写调用同步更新。

## 关键文件

- `packages/shared/src/admin/types.ts`
- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/app-catalog-access.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/admin/app-catalog-view.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/auth.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/renderer/lib/organization-storage.ts`
- `apps/electron/src/renderer/hooks/useOrganizationContext.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `packages/shared/src/i18n/locales/*.json`
- 对应的 shared、server-core、main 和 renderer 回归测试文件

## 自测结果

- `bun run test`：通过。普通套件 4,780 pass、19 skip、0 fail、11,106 次断言；随后全部 18 个 `*.isolated.ts` 文件通过、0 fail。
- `bun run typecheck:all`：通过。
- `bun run electron:build`：通过；main、preload、renderer、resources 和 assets 均成功，仅有既有 Vite chunk size warning。
- `bun run lint:electron`：通过，0 error、126 warnings；warnings 为仓库既有规则提示及测试中的 localStorage 提示。
- `bun run lint:i18n:parity`：通过，6 个非英文 locale 与英文基线均为 1,703 keys。
- `bun run lint:i18n:sorted`：通过。
- `bun run lint:i18n:coverage`：通过。
- `git diff --check`：通过。
- 四个核心定向测试文件：55 pass、0 fail，其中 Admin Client 30、Catalog cache 8、scoped registry 11、Organization App 卡片 6。
- 关键 isolated 回归：`admin.isolated.ts` 34 pass、`useOrganizationContext.isolated.ts` 13 pass、`useAppCatalog.interaction.isolated.ts` 7 pass、`App.organization-deep-link.interaction.isolated.ts` 3 pass、`local-apps.isolated.ts` 8 pass，均为 0 fail。

## 遗留问题

- 未连接真实 POL-52 服务和生产签名 Bundle 做外部端到端联调；本轮问题已通过主进程 RPC、renderer 交互、缓存迁移、全量测试、类型检查及生产构建覆盖。
- Electron lint 保留仓库现有 warnings，本轮无 lint error。
- 工作树中的三份未跟踪规格文档为本轮开始前已有文件，本轮未修改、未纳入提交。
