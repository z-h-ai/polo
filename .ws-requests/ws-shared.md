# WS-F（ws-shared）跨工作流诉求台单

分支：`ws-shared` · 基础：`POO-70/docs/client-journey-policy-interview`（e69c3f03）

## 1. → ws-home-apps：HomePage 挂载两个可选 slot

已交付 `apps/electron/src/renderer/context/HomeSurfaceSlotsContext.tsx`：

- `HomeSurfaceSlotsProvider({ slots?, children })` — 默认全空（不传 slots 即空实现）
- `useHomeSurfaceSlots(): { circlesEntry?, creditsBlockingBanner? }` — 值为 `() => ReactNode` 的惰性渲染器

请求：在 HomePage 既定锚点调用这两个 renderer；返回 undefined / 未提供时**不渲染任何占位**。
provider 的接线位置（App 根部）也归 ws-home-apps / 集成时收口。

## 2. → 集成（主 agent）备注，无需动作

- `apps/electron/src/renderer/index.css` 仅新增一行
  `@import "./components/hifi/tokens.css";`（紧跟 tailwindcss import），无既有规则改动；
  合并时若多分支都动 index.css，保留该行即可。
- `--hifi-shadow-*` token 仅作为 CSS 变量存在（craft-styles 阴影白名单约束组件类用法），
  组件阴影一律用白名单类（本分支组件用 `shadow-modal-small` / `shadow-middle` / `shadow-minimal`）。

## 3. i18n 决策记录

- `hifiShared.retryNow` **未新增**：`common.retry`（"Retry"）已可表达。
- `hifiShared.stayHere` 已新增（7 locale 全量、真实翻译）。原型各场景按钮文案更具体
  （「留在我的空间」「留在晨星科技」「稍后再说」等），各 WS 优先在自己的命名空间
  （如 `spaceSwitch.*`）写场景级文案，`hifiShared.stayHere` 仅作通用兜底。
