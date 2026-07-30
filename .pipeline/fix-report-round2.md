# POL-51 第 2 轮 Blocking Issue 修复报告

## Issue 处理结果

### Renderer 误引入 Node-heavy shared config barrel

- 新增 browser-safe leaf export `@polo-ai/shared/config/home-recent`，集中提供 Home 最近应用类型及长度常量。该模块不依赖 Node API、配置持久化实现或 Claude Agent SDK。
- Renderer 的最近应用运行时代码与相关类型引用均改为从安全 leaf 导入，不再经过 `@polo-ai/shared/config` 聚合入口。
- Node 侧配置实现继续从同一 leaf 复用类型和边界常量，并从原聚合入口重导出类型，保持既有服务端调用兼容。
- 新增真实 browser bundle 边界测试：使用 esbuild 打包 `home-recent-apps.ts`，断言依赖图包含安全 leaf，同时不包含 config barrel、preferences 实现或 `@anthropic-ai/claude-agent-sdk`。
- 完整 `bun run electron:build` 已通过，main、preload 和 renderer production bundles 均构建并完成资源校验。

## 关键文件

- `packages/shared/src/config/home-recent.ts`
- `packages/shared/src/config/home-recent-limits.ts`（由安全 leaf 替代）
- `packages/shared/src/config/index.ts`
- `packages/shared/src/config/preferences.ts`
- `packages/shared/src/config/validators.ts`
- `packages/shared/package.json`
- `apps/electron/src/renderer/lib/home-recent-apps.ts`
- `apps/electron/src/renderer/lib/__tests__/home-recent-browser-boundary.test.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/shared/types.ts`
- `packages/server-core/src/handlers/rpc/settings.ts`

## 实际运行的测试与结果

- `bun run electron:build`：通过；main、preload、renderer production build 及资源复制/校验全部成功，renderer 共转换 5,582 个模块。
- `bun test apps/electron/src/renderer/lib/__tests__/home-recent-browser-boundary.test.ts packages/shared/src/config/__tests__/home-recent-apps.test.ts`：3 pass、0 fail。
- `bun test ./apps/electron/src/renderer`：479 pass、0 fail。
- 对 `apps/electron/src/renderer` 下所有 `*.isolated.ts` 逐文件执行 `bun test`：全部通过、0 fail。
- `bun run typecheck:shared`：通过。
- `bun run typecheck:electron`：通过。
- `packages/server-core` 执行 `bun run tsc --noEmit`：通过。
- Electron 本轮变更文件定向 ESLint：通过。
- shared 本轮变更文件定向 ESLint：通过。
- `git diff --check`：通过。

## 遗留问题

- 本轮 blocking issue 无遗留。
- worktree 原有的 `.pipeline/fix-report-round3.md`、`.pipeline/fix-report-round4.md` 删除状态，以及 `design-demos/` 和 3 个未跟踪的 `docs/spec-home-app-admin-config*.md` 均保持不动，不纳入本轮 commit。
