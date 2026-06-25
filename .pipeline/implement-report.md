# POL-48 实现报告

## 变更摘要

- 移除 Settings 中的 AI 页面注册、导航入口、图标映射和路由详情占位，`settings/ai` 现在 fallback 到 App settings。
- 删除用户手动配置 AI 的页面与聊天输入入口，包括 `AiSettingsPage.tsx` 和 `CompactModelSelector.tsx`。
- 移除聊天输入区域的模型/连接切换 UI 与 Thinking Level 选择 UI，ChatPage 不再向输入组件传递模型、连接、Thinking 切换回调。
- 调整 onboarding：首次启动不再因本地 LLM 未配置进入 LLM 配置向导；OnboardingWizard 不再渲染 Provider/Credentials/Local Model 步骤，保留 admin 登录与 Git Bash/完成流程。
- 保留后端 IPC、storage、admin 同步链路和 LLM 运行时读取逻辑未改动。

## 关键文件列表

- `apps/electron/src/shared/settings-registry.ts`
- `apps/electron/src/shared/menu-schema.ts`
- `apps/electron/src/shared/route-parser.ts`
- `apps/electron/src/renderer/pages/settings/settings-pages.ts`
- `apps/electron/src/renderer/pages/settings/AiSettingsPage.tsx`
- `apps/electron/src/renderer/components/app-shell/input/CompactModelSelector.tsx`
- `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx`
- `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`
- `apps/electron/src/renderer/pages/ChatPage.tsx`
- `apps/electron/src/renderer/components/onboarding/OnboardingWizard.tsx`
- `apps/electron/src/renderer/hooks/useOnboarding.ts`
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/shared/__tests__/route-parser-settings.test.ts`

## 自测结果

- `bun install --frozen-lockfile`：通过，用于补齐当前 worktree 缺失的 `node_modules`。
- `bun run typecheck:electron`：通过。
- `bun test apps/electron/src/shared/__tests__/route-parser-settings.test.ts apps/electron/src/shared/__tests__/route-parser-automations.test.ts apps/electron/src/shared/__tests__/ipc-channels.test.ts apps/electron/src/renderer/hooks/__tests__/useOnboarding.test.ts`：通过，37 pass。
- `bun test apps/electron/src/main/handlers/__tests__/registration.test.ts apps/electron/src/main/handlers/__tests__/registration-profiles.test.ts`：通过，4 pass。
- `bun run electron:build:renderer`：通过，Vite production renderer build 成功。
- `rg "settings\\('ai'\\)|settings\\(\\\"ai\\\"\\)|poloai://settings/ai|settings:ai|AiSettingsPage|CompactModelSelector" apps/electron/src packages -S`：无残留匹配。

## 遗留问题

- `ProviderSelectStep.tsx`、`CredentialsStep.tsx`、`APISetupStep.tsx`、`ApiKeyInput.tsx` 等底层组件/类型仍保留，用于避免扩大到后端/凭据 helper 清理；当前主 onboarding 与 settings/chat UI 已不再调用它们。
- `config.json` 中既有用户自建连接、workspace 旧覆盖字段、IPC handler 和 storage 字段均按需求保留，未做迁移或清理。
