# POL-50 实现报告

## 变更摘要

- 删除独立的 `WebAppToolbar` 组件及其渲染路径，移除 hostname/favicon 地址栏展示和独占 toolbar 行。
- 在 `TabShellContext` 增加 webapp 导航控制注册机制，由 `WebAppView` 注册当前 webview 的后退、前进、刷新/停止能力。
- `TabBar` 右侧仅在活动 tab 为 webapp 时显示后退、前进、刷新/停止按钮；Polo/Home tab 下不渲染导航按钮。
- 移除 `TabBar` 右侧「+」按钮，保留 HomePage 的添加入口和 Cmd+T 切 Home 行为。
- 移除 webapp 内容区额外 36px 顶部偏移，内容统一从 TabBar 底边开始。
- 优化 HomePage/AppIcon 视觉样式：调整间距、卡片边框、阴影、hover 位移/缩放反馈，并将「Add app」入口改为协调的实线卡片样式。

## 关键文件列表

- `apps/electron/src/renderer/components/tab-browser/TabBar.tsx`
- `apps/electron/src/renderer/components/tab-browser/TabShell.tsx`
- `apps/electron/src/renderer/components/tab-browser/TabContent.tsx`
- `apps/electron/src/renderer/components/tab-browser/WebAppView.tsx`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/AppIcon.tsx`
- `apps/electron/src/renderer/context/TabShellContext.tsx`
- `apps/electron/src/renderer/index.css`
- `apps/electron/src/renderer/components/tab-browser/WebAppToolbar.tsx`（已删除）

## 自测结果

- `bun install --frozen-lockfile`：通过。用于补齐本地缺失的 `node_modules`，未修改 lockfile。
- `cd apps/electron && bunx eslint src/renderer/components/tab-browser/AppIcon.tsx src/renderer/components/tab-browser/HomePage.tsx src/renderer/components/tab-browser/TabBar.tsx src/renderer/components/tab-browser/TabShell.tsx src/renderer/components/tab-browser/WebAppView.tsx src/renderer/context/TabShellContext.tsx`：通过。
- `bun run typecheck:electron`：通过。
- `bun run electron:build:renderer`：通过。构建输出存在既有的 outDir/chunk-size warning，无新增失败。
- `rg` 检查 `WebAppToolbar`、webapp 36px 偏移、`TabBar` 添加按钮路径：未发现残留 toolbar 引用或 webapp 专属偏移。

## 遗留问题

- 未做 Electron 真实窗口手动交互验证；当前验证覆盖 TypeScript、Vite/Tailwind 构建与静态引用检查。
- `.pipeline/fix-report-round1.md` 在本次开始前已处于删除状态，本实现未恢复该文件。
