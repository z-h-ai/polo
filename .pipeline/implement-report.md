# POO-1 实现报告

## 变更摘要

- 完成 `poloai://` 双向协议主链路：解析合法 `callbackId`、登记来源 `webContents.id`、通过 `window.postMessage` 回传 `poloai:ack` / `poloai:error` / `poloai:event`。
- 新增 `send-message/{sessionId}` 多轮 action，并在主进程按同一 webContents 创建的协议会话做归属校验。
- 主进程桥接 session 事件并只转发白名单事件；`tool_start` / `tool_result` 只保留 `toolName`，不转发工具输入或结果详情。
- `new-session` 带 `callbackId` 时默认 `permissionMode: safe`，`allow-all` / `execute` 静默降级为 `ask`；无 `callbackId` 的旧 URL 路径保持原行为。
- 纳入并扩写了现场已有未跟踪文档 `docs/spec-poloai-protocol-bidirectional.md`，补充 Web App 接入指南；新增内置测试页 `poloai-protocol-test.html` 并加入 renderer 构建入口。

## 关键文件列表

- `apps/electron/src/main/deep-link.ts`
- `apps/electron/src/main/deep-link-callback-bridge.ts`
- `apps/electron/src/main/browser-pane-manager.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/renderer/contexts/NavigationContext.tsx`
- `apps/electron/src/preload/bootstrap.ts`
- `packages/shared/src/protocol/channels.ts`
- `packages/shared/src/protocol/dto.ts`
- `packages/shared/src/protocol/routing.ts`
- `apps/electron/src/renderer/poloai-protocol-test.html`
- `docs/spec-poloai-protocol-bidirectional.md`

## 自测结果

- `bun test apps/electron/src/main/__tests__/deep-link-routing.test.ts apps/electron/src/main/__tests__/deep-link-callback-bridge.test.ts apps/electron/src/main/__tests__/browser-pane-manager.test.ts apps/electron/src/shared/__tests__/ipc-channels.test.ts apps/electron/src/transport/__tests__/channel-map-parity.test.ts packages/shared/src/protocol/__tests__/routing.test.ts`：通过，103 tests。
- `cd packages/shared && bun run tsc --noEmit`：通过。
- `bun run typecheck:electron`：通过。
- `bun run electron:build:main`：通过。
- `bun run electron:build:preload`：通过。
- `bun run electron:build:renderer`：通过，确认输出包含 `poloai-protocol-test.html`。
- `cd apps/electron && npx eslint ...` 针对本次改动文件检查：0 errors；保留 4 个既有 warning（`browser-pane-manager.ts` 两个 unused eslint-disable、`NavigationContext.tsx` 两个 hook dependency warning）。

## 遗留问题

- 未做真实 Electron 手动流式验收；已提供内置测试页，可在开发态用标签页浏览器打开 `http://localhost:5173/poloai-protocol-test.html` 验证 ack、流式事件和多轮追问。
