# WS-LOGIN 跨工作流诉求台单

分支 `ws-login` 随分支提交；主 agent 集成时统一收口。

## 对 ws-shared（components/hifi / tokens.css）

1. **HifiButton（g4 `.button`）晋升共享 kit**
   - 现状：hifi kit 没有 button 原语；本 WS 在
     `apps/electron/src/renderer/components/system/primitives.tsx` 用 `--hifi-*`
     token 等价实现了 `HifiActionButton`（default/primary/quiet，g4
     `.button` 规格：min-h 32 / quiet 28、radius-md、border+fg-5 hover、
     primary=accent/on-accent、disabled opacity .48）。
   - 诉求：收口为 `components/hifi/Button.tsx`（或等价名），各 WS 的 state
     actions 统一引用；本 WS 届时替换 import 即可（API 已对齐 g4 语义）。

2. **InlineAlert（g4 `.inline-alert`）晋升共享 kit**
   - 现状：同上，本地实现于 `system/primitives.tsx`（info/bad 两调性、
     role=status/alert）。登录取消/过期、表单错误都用它做内联提示。
   - 诉求：并入 hifi kit（ws-space 的切换确认、ws-home-apps 的卡片内联
     说明大概率同需）。

3. **SystemProgressBar（g4 `.system-progress`）晋升共享 kit**
   - 现状：升级下载进度条（CONTRACT-DL）本地实现；g4 还有 `.progress-track`
     同族样式，ws-space 空间切换进度也会用到。
   - 诉求：一并收口（bar + label 或 track + summary 两种规格）。

4. **StateCard facts 值列支持 ReactNode 已可用**（现状即支持，无需改动）；
   REVOKE/REOPEN-RECOVERY 的 facts 值里嵌 `StatusPill` 工作正常，仅备案。

## 对 ws-home-apps

- `components/system/BlockedStateCard.tsx`（g4 `.app-workspace`）已导出，
  可在 app 页面/inspector 复用做「作品阻断状态卡」：withdrawn/expired/
  version/offline-running 四态直接传 eyebrow/title/description/actions。
  demo 见 playground `login-flows` 的 P-M11-BLOCKED-* / OFFLINE-RUNNING 变体。

## 对主 agent（集成阶段）

- `hooks/useAuthFlow.ts` 的 adapter 接口是 App.tsx 启动状态机的接入点：
  `loginWithPassword` / `sendLoginCode` / `verifyLoginCode` 对应
  onboarding/PhoneAuthStep 用的 phone-auth RPC；`prepareWorkspace` 对应
  个人空间 bootstrap。默认 `DEMO_AUTH_FLOW_ADAPTER` 永不 resolve（demo 保屏），
  真实接线时必须显式传入 adapter。
- LoginScreen 的协议勾选默认未勾选并 gate 提交（与既有 PhoneAuthStep 行为
  一致；原型 demo 值是已勾选，属演示数据差异，见 done 报告）。
- P-M11-REAUTH 按规格表以 SystemStatePage（登录后回上次空间与页面）交付；
  原型同名 scene 的视觉（login-split + 过期提示）由 P-M01-REOPEN 变体覆盖。
