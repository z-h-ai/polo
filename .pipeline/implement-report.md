# POO-21 Implement Report

## Change Summary
- Fixed the merged-worktree Electron Creator Skill install path so the real download fetch uses the current Admin auth token instead of relying on a stale credential cache.
- Normalized the Admin download origin check so `localhost` and `127.0.0.1` loopback URLs share the same authenticated fetch path.
- Added a live-token bridge from the Electron E2E harness into the server-core runtime via `PlatformServices.getAdminAccessToken`.
- Kept the shared Admin safety-status fix from the prior commit so the client now derives safety from the published artifact detail contract.

## Key Files
- `packages/server-core/src/handlers/rpc/skills.ts`
- `packages/server-core/src/runtime/platform.ts`
- `apps/electron/e2e/creator-skill/main.ts`
- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/__tests__/client.test.ts`

## Self-Test Results
- `bun test packages/shared/src/admin/__tests__/client.test.ts` passed.
- `bun test ./packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts` passed.
- `bun run scripts/electron-creator-skill-e2e.ts` passed against a real isolated Admin server.
- Final E2E evidence: `creator_skill_e2e_pass` with `progressStages: ["download","validate","prepare","commit","refresh"]`, `skillsChangedCount: 3`, and `backupsCount: 2`.

## Verification Environment
- Admin server: `bun run dev` in `/Users/wow/project/z-h-ai/polo-admin-dir/dev`
- Admin DB: `postgresql://postgres:postgres@localhost:5432/polo_admin_test`
- Admin secret: `JWT_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
- DB reset/seed commands:
  - `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/polo_admin_test bun run scripts/reset-test-db.ts`
  - `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/polo_admin_test bun run scripts/seed-test-db.ts`

## Remaining Issues
- None for POO-21 in this worktree.

---

# POL-51 实现报告

## 变更摘要

- 实现组织 App Catalog 同步、版本化缓存与失权/撤回 tombstone：登录及已登录启动会同步当前组织目录；网络失败保留上次成功缓存；登出、组织失权和目录撤回会立即关闭新的交付/启动能力，同时保留已安装 Bundle 的停止、卸载和受限日志管理闭环。
- 将组织目录与个人外部 URL 应用分离：首页按最近使用、当前组织应用和外部应用展示；个人外部应用继续复用 `tabBrowser:getApps` / `tabBrowser:saveApps`，组织下发的远程 URL 由可信目录解析后直接在 WebView 打开。
- 接入本地 Bundle 生命周期：安装前确认受信任的 Release 元数据和权限，安装/取消/重试/更新/卸载调用本地运行管理器；启动必须通过健康检查并返回 localhost 地址后才创建或激活 WebView 标签页。
- 补齐跨账号、跨组织及异步竞态防护：Catalog scope 以完整账号、组织和 App ID 隔离；过期确认、过期启动、迟到日志、被撤回的 App、离线缓存和大目录批量状态查询均 fail closed，且不泄漏被拒绝目录的 Release/运行时元数据。

## 关键文件列表

- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/protocol/local-apps.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/renderer/components/tab-browser/AddAppDialog.tsx`

## 自测结果

- `bun run test`：通过；基础测试及仓库内全部 `*.isolated.ts` 测试均通过。
- POL-51 定向测试：通过。
  - `local-apps.isolated.ts`：22 pass。
  - `admin-local-app-session-ending.isolated.ts`：23 pass。
  - `useAppCatalog.interaction.isolated.ts`：29 pass。
  - `HomePage.offline-start.interaction.isolated.ts`：1 pass。
  - `HomePage.round2.interaction.isolated.ts`：14 pass。
- `bun run typecheck:all`：通过。
- `bun run electron:build`：通过（main、preload、renderer、resources 和 assets）。
- `bun run lint:electron`：通过，0 errors；输出 120 个既有 warnings。
- `git diff --check`：通过。

## 遗留问题

- 本任务范围内无已知功能性或安全遗留。
- 现有 Electron lint warning 与两个 React 测试环境 warning（`act(...)` / Radix ref）未由本次变更新增，未阻断测试和构建。
