# POL-49 Implement Report

## 变更摘要

- 隐藏用户菜单中的 What's New / 最新动态 item，菜单现在仅保留 Profile、Settings、Logout 等入口。
- 收敛 `SidebarUserMenuConfig`，删除隐藏 item 专用的 `onWhatsNew` 和 `hasUnseenWhatsNew` 配置字段。
- 删除 `AppShell` 中仅服务 What's New 菜单入口的 release notes 未读检查、点击 handler 和 overlay 渲染，避免隐藏入口后继续执行无用户可见效果的启动检查。

## 关键文件列表

- `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`

## 自测结果

- `bun install --frozen-lockfile`
  - 结果：通过。当前 worktree 初始缺少 `node_modules`，先按 `bun.lock` 补齐依赖，未修改锁文件。
- `git diff --check`
  - 结果：通过。
- `bun run typecheck:electron`
  - 结果：通过。
- `cd apps/electron && bunx eslint src/renderer/components/app-shell/AppShell.tsx src/renderer/components/app-shell/LeftSidebar.tsx`
  - 结果：通过退出码 0；仍有 `AppShell.tsx` 既有 react-hooks dependency warnings，非本次新增错误。
- `bun run lint:electron`
  - 结果：失败。阻塞错误来自既有文件 `apps/electron/src/renderer/components/app-shell/FabNewChat.tsx` 的 `craft-styles/no-nonstandard-shadows`，与本次改动文件无关。

## 遗留问题

- 全量 Electron lint 仍被既有 `FabNewChat.tsx` shadow 规则错误阻塞；本任务未修改该文件。
