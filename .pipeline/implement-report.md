# POL-51 实现报告

## 变更摘要

- 完成 Reviewer 第二轮安全收口：Catalog Bundle 安装参数完全由主进程当前授权缓存构造，renderer 不能篡改版本、下载地址、校验和、大小、平台或架构；远程 URL、缺失 Release、无效 SemVer、伪造或缺失 scope 全部 fail closed。
- 将 Catalog 业务 ID 与 POO-12 内部运行 ID 完全分离。`accountId + organizationId + catalogAppId` 生成固定 SHA-256 `runtimeAppId`，业务 ID 支持大写、Unicode 和 512 字符，并通过独立 `expectedManifestAppId` 校验 Bundle manifest。
- 将认证会话结束清理移到主进程可信链路。Admin 登出、通用登出和明确 401/403/Token 撤销会先按可信 token 中的 `accountId` 取消安装并停止该账号实例，再清除凭据；renderer 不再暴露 `stopAccount` RPC。
- 增加受限离线启动：网络错误、5xx 和 token 刷新网络失败保留最近验证身份与授权缓存，只允许启动已经安装且环境准备完成的 Bundle；安装、更新和依赖下载保持禁用。明确失权会批量标记该账号全部缓存目录为不可用。
- 增加 10,000 项强类型批量状态 RPC。一次读取并校验当前组织授权缓存，I/O 并发限制为 8；未安装 App 不创建 manager、目录或持久化记录，1,001 项以后不再静默丢弃。
- renderer 的状态、操作互斥、busy 轮询、Tab 和最近使用 key 全部改为完整 scope key；所有异步提交校验组织上下文和 generation，组织/账号切换后丢弃旧响应。
- 版本更新由主进程和 renderer 使用 SemVer 2.0 判断，兼容前导 `v` 与 prerelease；第四段和其他无效版本显示国际化警告，并保留最后可信更新信息，不折叠为“无更新”。
- 补齐全部现有 locale 的离线安装和无效版本文案；Admin mock-heavy 测试改为 isolated 运行，避免全量测试中的模块 mock 污染。

## 关键文件列表

- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/local-app-runtime/manager.ts`
- `apps/electron/src/main/local-app-runtime/manifest.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/renderer/App.tsx`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/auth.ts`
- `packages/shared/src/admin/app-catalog-access.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/credentials/manager.ts`
- `packages/shared/src/protocol/local-apps.ts`
- `packages/shared/src/protocol/channels.ts`
- `packages/shared/src/i18n/locales/*.json`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`

## 自测结果

- `bun run test`：通过；普通测试与所有 `*.isolated.ts` 测试均为 0 fail。
- `bun run typecheck:all`：通过。
- `bun run lint:electron`：通过，0 error；保留仓库既有 114 个 warning。
- 对本任务修改的 shared 文件执行 ESLint：通过，0 error。
- `bun run lint:i18n:parity`：通过；英文基线及 6 个其他 locale 均为 1689 keys。
- `bun run lint:i18n:sorted`：通过。
- `bun run lint:i18n:coverage`：通过。
- `bun run electron:build:main`：通过。
- `bun run electron:build:preload`：通过。
- `bun run electron:build:renderer`：通过；仅有 Vite 既有 chunk size warning。
- `git diff --check`：通过。

新增回归覆盖包括：

- 主进程绑定授权 Release，拒绝篡改字段、remote URL、缺失 Release 和缺失 scope。
- 已登录跨账号、已登出跨账号、正常登出和明确 Token 撤销的可信账号清理。
- 有效 token 离线、过期 token 刷新网络失败和明确 401/403 冷启动。
- 大写、Unicode、128～512 字符业务 ID 与内部安全运行 ID 的跨层隔离。
- 1,000、1,001、10,000 项批量状态读取、单次缓存读取、不物化未安装目录和重复 scope 单 manager。
- 同 appId 跨组织并发、乱序响应和操作中切换组织。
- SemVer prerelease、前导 `v`、第四段、两侧无效版本，以及 UI 保留可信更新信息。

## 遗留问题

- 未连接真实 POL-52 服务和生产签名 Bundle 做端到端联调；当前通过 mock Catalog、临时安装目录、主进程 RPC、renderer 交互测试和三端生产构建验证。
- 仓库级 `bun run lint:shared` 仍被本任务未修改文件中的 5 个既有 `craft-shared/no-inline-source-auth-check` 错误阻断；本任务修改的 shared 文件单独检查通过。
- `package.json` 的 `lint:i18n:strings` 指向仓库中不存在的 `scripts/lint-i18n-strings.sh`；可执行的 parity、sorted、coverage 检查均已通过。
