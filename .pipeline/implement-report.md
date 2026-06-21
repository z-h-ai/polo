# POL-33 实现报告

## 变更摘要
- 在聊天输入区上方新增状态 Banner，支持未配置 AI 服务、额度用完、在线账号被禁用三种阻断状态。
- Banner 使用 info/destructive 主题色、AlertTriangle 图标和 slideUp 进入动画；阻断状态下同步禁用输入框。
- 未配置 AI 服务由 LLM 连接列表为空推导；账号在线被禁用在下一次发送前通过 admin validate 延迟检测；额度用完在发送失败返回 quota/429 等错误时进入阻断状态。
- admin validate 将 ACCOUNT_DISABLED 纳入结构化 auth failure，方便 renderer 稳定识别。

## 关键文件列表
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/renderer/pages/ChatPage.tsx`
- `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`
- `apps/electron/src/renderer/components/app-shell/input/ChatInputZone.tsx`
- `apps/electron/src/renderer/context/AppShellContext.tsx`
- `apps/electron/src/renderer/index.css`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/shared/src/i18n/locales/*.json`

## 自测结果
- `bun install`：通过，用于补齐当前 worktree 缺失的 `tsc` 可执行依赖。
- `bun run typecheck:all`：通过。
- `bun run lint:i18n:parity`：通过。
- `bun run lint:i18n:sorted`：首次发现新增 locale key 顺序不符合要求，执行 `bun run sort-locales` 后复跑通过。

## 遗留问题
- 未做真实 Electron UI 手动点验；本次以类型检查和 i18n 检查验证。三种状态的真实展示依赖运行时对应条件或后端返回码触发。
