# POL-47 Review Round 1 Fix Report

## Issue 1

处理结果：已修复。

- 在 `apps/electron/src/main/handlers/tab-browser.ts` 导出 `HANDLED_CHANNELS`。
- 在 `registration.test.ts` 和 `registration-profiles.test.ts` 的期望 GUI channel 集合中加入 tab browser channels。

## Issue 2

处理结果：已修复。

- 在 `apps/electron/src/shared/__tests__/ipc-channels.test.ts` 的 wire-format snapshot 中加入：
  - `tab-browser:getApps`
  - `tab-browser:saveApps`
- 该测试的 `EXPECTED_COUNT` 由数组长度推导，更新列表后实际计数为 319。

## Issue 3

处理结果：已修复。

- 在 `AddAppDialog.tsx` 中添加图标文件大小限制：超过 256 KB 会清空 file input 并提示错误，不再读取为 data URL。

## Issue 4

处理结果：已修复。

- 从 `WebAppView.tsx` 的 `<webview>` 上移除 `allowpopups={false}`。
- 弹窗拦截继续由 main process `setWindowOpenHandler` 执行。

## Issue 5

处理结果：已修复。

- 将 `webpreferences` 改为 Electron 文档风格的 comma-only 字符串：
  `contextIsolation=yes,nodeIntegration=no,sandbox=yes`。

## 自测结果

- `bun test apps/electron/src/main/handlers/__tests__/registration.test.ts apps/electron/src/main/handlers/__tests__/registration-profiles.test.ts`：通过，4 pass。
- `bun test apps/electron/src/shared/__tests__/ipc-channels.test.ts`：通过，5 pass。
- `cd apps/electron && bun run typecheck`：通过。
- `cd packages/shared && bun run tsc --noEmit`：通过。
- `cd apps/electron && bunx eslint <本轮变更文件>`：通过。
- `bun test`（项目根目录）：已运行，结果为 4607 pass / 18 skip / 8 fail。失败项为既有 auth setup 断言和 i18n locale key 排序断言，未命中本轮修改文件：
  - `packages/shared/src/auth/__tests__/state.test.ts`
  - `packages/shared/src/i18n/__tests__/locale-parity.test.ts`
