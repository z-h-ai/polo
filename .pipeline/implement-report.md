# POL-51 实现报告

## 变更摘要

- 完成首页「最近使用 / 当前组织应用 / 外部应用」分区与组织 App 卡片状态、安装确认、进度、启动失败、日志、更新和卸载交互。
- 接入组织 Catalog 启动/登录同步与本地缓存；网络故障沿用最近一次授权结果，403、账号禁用、成员移除等明确失权结果会将缓存标记为不可用并禁止安装、更新和新增启动。
- 为 Catalog Bundle 引入 `accountId + organizationId + catalogAppId` 强类型 scope，使用稳定的文件系统安全 key 隔离安装记录、版本、用户数据、日志和运行实例，同时保留 POO-12 原有 legacy 调用。
- 登出和认证失效仅停止当前账号 scope 下的本地实例；组织切换不停止其他组织已经运行的实例。
- 将 500ms 状态刷新限制为最多 32 个忙碌 App，初次批量状态加载限制为 1000 个 App，并使用最多 8 路并发；非忙碌 App 仅在初次加载和操作完成后刷新。
- Release 更新判断改用 SemVer 2.0，兼容前导 `v` 和 prerelease；第四段及其他无效版本返回稳定的 `invalid_semver` 结果，不误判为相等或可更新。
- 首页、组织 App 卡片、添加外部应用及相关弹窗新增文案全部接入 i18n，并补齐、排序全部 7 个 locale。

## 关键文件列表

- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/renderer/components/tab-browser/AddAppDialog.tsx`
- `apps/electron/src/renderer/App.tsx`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/protocol/local-apps.ts`
- `packages/shared/src/i18n/locales/*.json`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`

## 自测结果

- `bun test`：通过，4785 pass、19 skip、0 fail（4804 tests / 363 files）。
- `bun run typecheck:all`：通过。
- Electron ESLint：通过，无 error；保留仓库既有 warning。
- i18n parity：通过，7 个 locale 均为 1686 keys。
- i18n sorted：通过。
- i18n coverage：通过。
- `bun run electron:build:main`：通过。
- `bun run electron:build:preload`：通过。
- `bun run electron:build:renderer`：通过；仅有 Vite 既有的 chunk size warning。
- `git diff --check`：通过。

覆盖的新增回归场景包括：

- 已有缓存后收到 403 时 fail closed，并在后续成功同步后恢复授权。
- 同一 Catalog App 在不同账号/组织中的安装目录和运行实例隔离。
- 登出只停止指定账号实例。
- Bundle manifest 的业务 `appId` 仍校验 `catalogAppId`。
- 忙碌状态轮询数量、初次加载数量和并发上限。
- SemVer prerelease、前导 `v`、第四段版本和无效版本。

## 遗留问题

- 未连接真实 POL-52 服务和生产签名 Bundle 做端到端联调；当前通过 mock Catalog、临时安装目录、IPC/协议测试和三端生产构建验证客户端行为。
- 依赖 POO-12 提供的实际下载、校验、运行时准备、进程生命周期、日志和回滚能力；本任务只增加 Catalog scope 隔离、授权门禁和客户端交互。
