# WS-CIRCLES-ACCOUNT 跨工作流诉求台单

分支：`ws-circles-account` · 基础：集成分支 154ded3b（已含 ws-shared）

## 1. → ws-shared / 集成：hifi Button 原语收编请求

`components/hifi/` 尚无按钮原语。本轮在
`apps/electron/src/renderer/components/tab-browser/circles/flowButtons.tsx`
实现了 `FlowButton`（primary / quiet / danger 三变体，`--hifi-*` token +
`rounded-hifi-sm`，无硬编码 hex），circles 与 credits 两模块共用（credits
从 `@/components/tab-browser/circles/flowButtons` 跨目录 import）。

请求：收口时将其 hoist 为 `components/hifi` 的共享 Button 原语（其他 WS
大概率也各自内联了等价样式，统一收编可消除重复）。

## 2. → ws-home-apps：HomePage 挂载点与路由

- `HomeSurfaceSlots.circlesEntry` / `creditsBlockingBanner` 的真实接线
  （HomePage 锚点调用 renderer）按 ws-shared 台单仍归 ws-home-apps。
  两个 slot 的 demo 侧注入示例见 `playground/registry/circles.tsx`
  （circles-entry-card）与 `playground/registry/credits-flows.tsx`
  （credits-pre-block）。
- 「我的圈子」列表/详情页面（`CirclesListPage` / `CircleDetailPage`）目前
  只有组件 + playground demo；产品内路由（个人空间稳定导航，与「全部
  Apps」并列，D-PC-07）需要 ws-home-apps / 集成时接入 tab-browser 导航。
- 作品去重目录侧渲染归 ws-home-apps；圈子侧数据形状
  `CircleSourcedApp { appId, name, iconUrl?, sources: {circleId, circleName,
  creator, valid}[] }` 已从 `@/components/tab-browser/circles` 导出
  （types.ts 为约定唯一来源），冲突时主 agent 裁定。

## 3. → ws-home-apps / 集成：TabBar.account 透传新 props

`AccountMenu` 新增可选 props：`billing` / `onOpenBilling` / `admin` /
`onOpenEnterpriseAdmin` / `onOpenCreatorConsole`（P-M10-MENU 资格变体）。
未传时行为与 R9 完全一致（既有测试不变，新增
`AccountMenuAdminEntries.interaction.isolated.ts` 5 例全绿）。
`TabBar` 的 `account` prop 尚未透传这些字段——TabBar 属 ws-home-apps
范围，本轮未改；产品接线时需在 TabBar 的 account 类型上补透传
（playground demo 直接渲染 AccountMenu 绕过了 TabBar）。

## 4. → app-shell（会话核心所有方）：CreditsGate 真实挂载

`CreditsGate` 设计为 composer 上方横幅（chat input 区域文件不在本 WS
范围）。真实挂载：在 composer 容器内、输入框上方渲染
`<CreditsGate variant={...} />`；`creditsRules.ts` 提供纯状态机
（blocked → checking → not-arrived/arrived），到账只解除阻断、
`继续发送` 保持用户动作。浏览器打开动作走 `TopupHandoff`（SystemScreen
全屏态）或容器内嵌 HandoffCard，由集成决定呈现层级。

STREAM-CUT 的消息内行内标注：生成中断的消息在消息流内保留，已生成部分
尾部渲染行内说明，文案键 `credits.streamCut.inlineNote`
（zh-Hans「（生成中断，以上为已生成部分）」，7 locale 已备）。渲染位置在
assistant 消息气泡内（消息/turn 组件归 app-shell 所有方），本 WS 的
`StreamCutNotice` 只负责 composer 上方横幅；示意呈现见 playground
`registry/credits-flows.tsx`（credits-stream-cut demo）。另：
`TopupCheckFlow` 的 `phase` prop 已直接复用 `creditsRules` 的
`TopupCheckPhase`，arrived→resumed 的展示映射收在 `checkViewPhase`
（单一出处，app-shell 挂载时直接传规则机 phase 即可）。

## 5. → 集成（主 agent）备注，无需动作

- `AdminConsoleHandoff`（components/organization/，P-M10-ADMIN-BROWSER
  交接卡）为 AccountMenu 扩展的配套新文件，organization/ 目录下与
  AccountMenu 同域；返回后 toast 用 `accountSettings.adminReturnToast`
  （sonner）。
- M08 的 `FileMissingState`（components/files/）是唯一新增产品文件；
  会话文件列表其余复用既有 right-sidebar/SessionFilesSection 等。
- i18n：`circles.*` / `credits.*` / `accountSettings.*` / `files.missing.*`
  共 203 键 × 7 locale（zh-Hans 为基准，其余真实翻译），字母序保持。
- Playground：`registry/circles.tsx` / `session-files.tsx` /
  `credits-flows.tsx` / `account-settings.tsx` 四个新 registry 文件，
  index.ts 每文件一行 import + 一行 spread。分类复用既有 categoryOrder
  内的 'Browser' / 'Chat' / 'Agent Setup'（'Settings' 不在 categoryOrder，
  未新增分类）。
