# POL-47 实现报告

## 变更摘要

- 将 Electron ready-state 改为标签页浏览器外壳：顶部固定 TabBar、Home 九宫格入口、Polo AI 常驻挂载、webapp 通过 `<webview>` 打开。
- 新增标签页状态模型和 Provider：内置 Polo 单例、webapp 多标签、关闭/激活/拖拽重排、快捷键切换、workspace 维度 localStorage 恢复。
- 新增 Add App 流程：名称/URL/图标输入，HTTPS 与内网 HTTP 校验，应用定义保存到 `~/.polo-ai/config.json`。
- 接入本地 RPC 通道 `tab-browser:getApps` / `tab-browser:saveApps`，扩展共享 config schema 与 routing。
- 启用 Electron `webviewTag`，为 `persist:browser-pane` 分区补权限、弹窗和非 HTTP(S) 导航拦截。
- 调整布局 CSS：新增 `--tabbar-height` / `--content-top-offset`，TopBar 下移到 TabBar 下方，macOS 交通灯留白转移到 TabBar。
- 补齐 `apps/electron/scripts/validate-assets.ts`，让 `apps/electron` 的完整 build 脚本可完成。

## 关键文件列表

- `apps/electron/src/shared/tab-browser-types.ts`
- `apps/electron/src/renderer/atoms/tab-browser.ts`
- `apps/electron/src/renderer/context/TabShellContext.tsx`
- `apps/electron/src/renderer/components/tab-browser/*`
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/renderer/index.css`
- `apps/electron/src/renderer/components/app-shell/TopBar.tsx`
- `apps/electron/src/main/window-manager.ts`
- `apps/electron/src/main/handlers/tab-browser.ts`
- `packages/shared/src/protocol/channels.ts`
- `packages/shared/src/protocol/routing.ts`
- `packages/shared/src/config/storage.ts`
- `packages/shared/src/config/validators.ts`

## 自测结果

- `cd apps/electron && bun run build`：通过。lint 仍有既有 warning，但无 error；main/preload/renderer/copy/validate 全部完成。
- `cd apps/electron && bun run typecheck`：通过。
- `cd packages/shared && bun run tsc --noEmit`：通过。
- `cd apps/electron && bunx eslint <本次 Electron 变更文件>`：通过。
- `cd apps/electron && perl -e 'alarm shift; exec @ARGV' 8 bun run dev`：Vite dev server 启动成功，输出 `http://localhost:5173/`，随后按测试超时终止。

## 遗留问题

- 未进行人工 Electron 窗口点击验收；当前只完成构建、类型、lint 和 dev server 启动验证。
- `apps/electron` 的 `bun run dev` 脚本当前是 Vite dev server，不是完整 Electron 启动脚本；完整 Electron dev 启动应使用仓库根脚本。
- 工作区进入本任务前已有 `.pipeline/fix-report-round1.md` 删除状态，未恢复也未纳入本次实现。
