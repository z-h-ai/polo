# POL-51 实现报告

## 变更摘要

- 新增组织 App Catalog 的客户端数据模型、严格响应校验、独立 `appConfigVersion` 比对和账号／组织隔离缓存。
- 新增 `admin:syncAppCatalog` RPC。登录后的首页启动及组织切换会同步当前组织目录；304 复用缓存，网络失败保留上次成功目录并展示非阻断告警，鉴权失败触发既有重新登录流程。
- 首页调整为「Recently used」「当前组织 Apps」「External apps」三段式信息架构，保留内置 App 和现有个人 URL App 存储。
- 接入 POO-12 本地 Bundle 管理器，完成安装确认、进度轮询、取消、启动健康检查后打开 WebView、更新、停止、日志、重试及可选择保留数据的卸载流程。
- 增加平台／架构兼容判断；组织撤下的 App 保留本地元数据但标记不可用，禁止新增启动；登出、账号失效或禁用时停止已运行的本地 Bundle，保留安装和用户数据。
- 组织远程 URL App 直接打开 WebView，不进入本地安装流程；个人 Add app 文案改为 Add external app。
- WebApp 重复打开会激活已有标签页；本地服务重启后会用运行管理器返回的新 localhost URL 更新已有标签页。

## 关键文件列表

- `packages/shared/src/admin/types.ts`
- `packages/shared/src/admin/schemas.ts`
- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/shared/src/protocol/channels.ts`
- `packages/shared/src/protocol/routing.ts`
- `apps/electron/src/preload/admin-api.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/transport/channel-map.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/renderer/atoms/tab-browser.ts`
- `apps/electron/src/renderer/App.tsx`

## 自测结果

- `bun test`：全量测试通过，退出码 0。
- POL-51 定向测试：75 个测试通过，0 失败；覆盖 AdminClient Catalog 契约、304、缓存隔离与撤下状态、同步 RPC、缓存降级、Preload／Channel Map／IPC 注册、版本比较及重复标签激活。
- `bun run typecheck:electron`：通过。
- `bun run typecheck:shared`：通过。
- `cd packages/server-core && bun run tsc --noEmit`：通过。
- `cd apps/electron && bun run lint`：0 error；仓库既有 114 个 warning，本次新增文件无 lint warning。
- `bun run electron:build:renderer`：通过。
- `bun run electron:build:main`：通过。
- `bun run electron:build:preload`：通过。
- `git diff --check`：通过。

## 遗留问题

- 当前 worktree 没有可联调的 POL-52 polo-admin App Catalog 服务和真实发布 Bundle，因此未验证真实服务端 `GET /api/apps?organizationId=&version=`、签名下载 URL 以及完整真实 Bundle 下载／启动链路；本地已通过严格契约测试和 POO-12 既有运行管理器测试。
- 首页文案沿用当前 Tab Browser 的英文界面风格；后续若产品统一国际化，需要补充对应 i18n key。
