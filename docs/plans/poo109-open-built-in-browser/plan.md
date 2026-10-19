# Plan: POO-109 内置浏览器的打开与触发 — 借鉴 ZCode Browser use 的迭代方案

Status: **draft-v1（待与 kimi cli 讨论达成共识；POO-110 落地后补充集成章节）** · Date: 2026-10-19
依据: 2026-10-19 两路只读调研（polo 现状 + ZCode browser-use 全量研究）
前置依赖: **POO-110（应用与 Skill 上传 + 内置 Skill 打包分发）完成后，基于其落地面迭代**（用户指令 2026-10-19）

---

## 0. 回答任务卡原始问题：现状基线

> 现在内置浏览器是怎么打开？怎么触发的？然后它会出现在哪里？

### 0.1 三条互相独立的「浏览器」实现

| 线 | 技术 | 位置 | 定位 |
|---|---|---|---|
| A. BrowserPaneManager | 独立 chromeless `BrowserWindow` + 3 层 **`BrowserView`**（已废弃 API）+ CDP | `apps/electron/src/main/browser-pane-manager.ts` | **AI 主力通道**，几乎只有 AI 能打开 |
| B. tab-browser | 主窗口内 React tab + **`<webview>`** 标签 | `apps/electron/src/renderer/components/tab-browser/` + `context/TabShellContext.tsx` | app 启动器 + webapp 标签（POL-47） |
| C. GenUI canvas 卡片 | 转录内联 `<webview>`，临时 partition `genui-app-<sessionId>` | `packages/ui/src/components/chat/GenUiAppCard.tsx` | 沙箱化生成 UI，与 A/B 隔离 |

### 0.2 怎么打开（入口盘点）

1. **AI agent 的 `browser_tool` `open`/`navigate`** —— 唯一常规活入口（`packages/session-tools-core/src/tool-defs.ts:909-958`，工具实现 `packages/shared/src/agent/browser-tools.ts`，主进程绑定 `packages/server-core/src/sessions/SessionManager.ts:5740-5860`）
2. 浏览器窗口空状态页的示例 prompt 按钮（`apps/electron/src/renderer/browser-empty-state.tsx:14-24`，在主窗口发起会话）
3. 输入框工具栏状态条点击 —— 仅**聚焦**已绑定的浏览器窗口，不能创建（`ToolbarStatusSlot.tsx:66-70`）
4. `handleNewBrowserWindow`（`AppShell.tsx:1907-1919`）—— **死代码**，全仓库零调用点；i18n `browser.newWindow` 残留无消费
5. 菜单/快捷键 **没有**内置浏览器项：`menu.ts:111-124` 的 Cmd+N / Cmd+Shift+N 都只建主窗口
6. 所有外链（window.open、will-navigate、`OPEN_URL` RPC、会话分享链接）**一律丢系统浏览器**（`window-manager.ts:304-324`、`packages/ui/src/lib/open-external-url.ts:27-60`）

### 0.3 怎么触发（主链路，AI tool call）

```
模型发 browser_tool(open/navigate/…)
→ 工具解析（browser-tool-runtime.ts，19 个 legacy 别名归一 browser-tool-names.ts:8-25）
→ SessionManager 绑定的 BrowserPaneFns（SessionManager.ts:5740+，openPanel 隐式建窗）
→ BrowserPaneManager.createInstance（browser-pane-manager.ts:365-520）
   session.fromPartition('persist:browser-pane') → BrowserWindow(1200×900, frame:false, show:false)
   → addBrowserView(pageView/overlay/toolbarView) → loadToolbarPage + loadEmptyStatePage
→ emitStateChange → IPC BROWSER_PANE_STATE_CHANGED → 渲染层 jotai（atoms/browser-pane.ts:8-24）
→ ToolbarStatusSlot 展示「浏览器已打开」状态
```

用户可感知面：一个**独立无边框原生窗口**（顶部 48px 工具栏 view + 页面 view + agent 控制时 overlay view），agent 控制期间 overlay 标注 + 禁止 resize。

### 0.4 出现在哪里

- **A 线：独立原生窗口**，不嵌主窗口、不分栏、无窗口内多 tab；多实例 = 多窗口，全部共享 `persist:browser-pane` cookie 池；workspace 隔离只是渲染层展示过滤（`atoms/browser-pane.ts:31-51`）
- **B 线：主窗口内 tab**（`App.tsx:3329-3433` 挂 TabShell），webapp tab 是 `<webview>`，new-window 事件直接丢系统浏览器（`WebAppView.tsx:99-104`）
- 多窗口 tab 条 `BrowserTabStrip.tsx` **已写完但只在 playground 挂载**（`playground/registry/browser-ui.tsx:898`），生产无宿主

### 0.5 现状缺口（结论）

1. **用户打不开内置浏览器**：无菜单项、无快捷键、无右键入口、无设置项
2. **内嵌/外跳无分流**：入口决定一切，没有 URL 维度的判断，也没有用户偏好
3. **两套体系不互通**：B 线的弹窗/外链进不了 A 线；A 线的 URL 也进不了 B 线 tab
4. **渲染载体老化**：`BrowserView` 已被 Electron 废弃（本仓库 Electron 39，`WebContentsView` 已稳定）；手写 setAutoResize/层序管理
5. **会话隔离粗**：所有窗口共享一个 cookie 池；无浏览器历史
6. **AI 能力强、UI 弱**：快照/截图/evaluate/下载等待都在（`browser-pane-manager-interface.ts:213-278`），但用户可视面只有 48px 工具栏
7. **权限治理缺失**：webview-security.ts 只有 attach 认证门 + 权限 allow 集，没有请求级 fail-closed 治理

---

## 1. ZCode 借鉴研究结论（与本题相关子集）

> 完整研究材料：ZCode 仓库 `docs/browser-use/`（20+ spec）、`.agents/skills/agent-browser/`、`apps/zcode-cli/packages/browser-use-plugin/`、`packages/desktop/src/main/browserView/`（15.6k 行）。以下只列对 polo「打开/触发/出现位置」直接有用的。

### 1.1 ZCode 最重要的先导结论

ZCode 有两条浏览器路线，**刻意只把一条做成产品**：
- `agent-browser` CLI（`.agents/skills/agent-browser/`）——外部 CLI + 自有 Chrome，模型走 Bash 调用。**无 UI 联动**，只用于开发仓库自用。
- `browser-use-plugin`（产品）——内嵌 `<webview>` + main 进程 CDP-on-guest，模型通过对象图 API 驱动。**用户看得见、能接管、共享登录态、权限可治理**。

**启示：polo 的 A 线（BrowserPaneManager）在架构定位上已等价于 ZCode 的产品路线**（内嵌视图 + CDP + AI 驱动），缺的不是能力而是「打开/触发/出现位置」的产品化。ZCode 的 `agent-browser` CLI 路线不值得抄。

### 1.2 渲染载体的历史教训（ZCode 走过弯路）

- v1 用 main 进程 `WebContentsView` → v2 **回摆到 renderer `<webview>` + CDP-on-guest**（`2026-07-08-webview-cdp-on-guest-pivot-spec.md`）。
- 回摆原因：WebContentsView 是 native 层，**永远合成在 renderer DOM 之上**，菜单/下拉/tooltip 全被遮住，z-index 无法修复。
- 解法核心：executor 作用在 `ControlledView` 抽象 `{webContents, cdp}` 上，与载体解耦；截图走 CDP `Page.captureScreenshot` 绕开 webview.capturePage 的崩溃。
- ⚠️ 注意：ZCode 的 webview 嵌在**主窗口侧边栏**里所以受 DOM 遮挡问题支配；polo A 线是**独立窗口**，BrowserView 的遮挡缺陷在独立窗口内影响小得多。**polo 不必照搬回摆**，但「executor 与载体解耦」值得立即采纳。

### 1.3 值得借鉴的横切设计（按与本题相关度排序）

| # | 设计 | 解决什么 | ZCode 证据 |
|---|---|---|---|
| B1 | **双 registry + claim 接管**：AI 开的 tab 与用户开的 tab 严格分离，`user.openTabs()` 只列不控、`claimTab()` 显式接管 | 「AI 开的浏览器」与「用户浏览器」同一套 UI 两种所有权，用户可旁观可接管，agent 不能静默操控用户页面 | `docs/tab-claiming-iab.md`、`browserGuestManager.ts:2651-2681` |
| B2 | **同站复用而非堆叠**：`open(url)` 同 hostname 复用现有 tab、激活并原地导航 | AI 反复开同站制造 tab 洪水 | `2026-08-24-browser-open-reuse-tab.md` |
| B3 | **权威在 main，renderer 订阅不 gating**：可见性与订阅解耦；「面板不可见就取消订阅」会让 tab 创建超时误删 | 任何覆盖层（设置页等）打开都会让浏览器静默失灵 | `2026-08-18-browser-view-event-subscription-visibility-spec.md` |
| B4 | **tab 生命周期 = 进程内持久资源**：turn 结束不关 tab；显式关闭只有 4 个 authority；LRU 硬上限 + 保护 lease（截图/下载/录屏中不可淘汰） | 防数据丢失（真实事故驱动）+ 防内存耗尽 | `2026-07-12-browser-tab-process-lifetime-spec.md`、`2026-07-31-browser-tab-residency-budget-spec.md` |
| B5 | **权限治理 fail-closed 四级漏斗**：无害白名单 → 同意记录 → 弹窗（20s 超时拒绝）→ 未知权限一律拒绝 + 审计日志；「面板不可见时弹窗不可交互 → 天然拒绝」 | Electron 默认自动批准所有权限请求（摄像头/剪贴板/地理位置/设备）；CNVD 中危报告驱动 | `2026-10-08-embedded-browser-permission-governance-spec.md` |
| B6 | **视口双轨制**：human tab 持久化显示偏好；agent surface 不读不写偏好、固定 1280×720；claim/navigate 不重置 | 用户与 agent 共用组件时显示配置互相污染 | `2026-07-15-responsive-browser-viewport-spec.md` |
| B7 | **轮尾自动截图**：本轮用过浏览器 API → 轮次完成后自动截当前 tab，作为持久化展示事实（不回灌模型上下文） | 模型操作了页面但用户看不到结果 | `2026-07-15-browser-turn-final-screenshot-spec.md` |
| B8 | **skill 化的能力分发**：control-browser SKILL.md 把触发条件、list→observe→get 三段式纪律、截图节流写进模型可读文档；guidance + capability manifest + 运行时对象图作为**有版本的发布单元** | 模型行为纪律无法靠 tool description 承载；文档与能力漂移 | `skills/control-browser/SKILL.md`、`browser-use-plugin-version-0-4-2-spec.md` |
| B9 | **list→observe→get 三段式 tab 选择**：第一批操作必须先返回完整 tabs.list()；禁止位置猜测；goto 后必须显式 waitForLoadState | 多 tab 场景模型选错 tab 是最高频失败模式 | `2026-07-12-browser-tab-selection-activation-spec.md` |
| B10 | **subagent 归属显式 tabOwner**：`forChildSession({tabOwner:'parent'|'child'})`，不根据 session id 形状猜父会话 | subagent 开的 tab 成为看不见的孤儿 | `2026-07-16-subagent-browser-unavailable-spec.md` |

---

## 2. 迭代方案（draft v1）

### 2.1 目标

把内置浏览器从「只有 AI 能打开的实现细节」升级为「用户与 AI 共用的一等公民」：**用户打得开、链接进得来、AI 开的用户看得见管得着**。

### 2.2 Wave-1：用户侧打开入口与出现位置（本次核心，纯客户端）

**P1-1 恢复用户入口（打开方式）**
- 把死代码 `handleNewBrowserWindow` 接上真实入口：
  - 应用菜单 File → 「新建浏览器窗口」（`menu.ts` 新增项 + `CmdOrCtrl+Shift+B`）
  - 修 i18n：`browser.newWindow` 已存在，补 `browser.newWindowShortcutHint` 等缺失键
- 触发链路复用现有 RPC（`RPC_CHANNELS.browserPane.CREATE` → `handlers/browser.ts:30` → `BrowserPaneManager.createInstance`），**不新增主进程能力面**——链路②本来就在，只是没有调用方。

**P1-2 链接分流（触发方式）**
- 新增「在内置浏览器打开」右键菜单项（链接右键 / 会话分享链接），与现有 `sessionMenu.openInBrowser`（系统浏览器）并存并改名区分：
  - `sessionMenu.openInBrowser` → `sessionMenu.openInSystemBrowser`（存量 key 语义纠正，文案同步）
  - 新增 `sessionMenu.openInBuiltInBrowser` → 新 IPC `browserPane.openUrl`（复用 CREATE + NAVIGATE，或 instance 复用语义：已有同站实例则 navigate）
- 分流策略默认保守：**不自动改写现有 window.open/will-navigate 行为**（那是独立决策，见 P1-3）。

**P1-3 内嵌偏好设置（可选闸门，默认关闭）**
- 设置项 `browser.embeddedLinksPolicy`: `system`（默认，现行为）| `built-in`（http/https 外链进内置浏览器）
- 落点：`window-manager.ts:304-324` 的 setWindowOpenHandler 分支 + `open-external-url.ts`；策略读取复用 config.json 模式（`storage.ts` 现有 `browserToolEnabled` 同款）
- ⚠️ 会签项：改变全局链接行为，涉及安全面（外部 URL 进入 persist partition 后的 cookie/凭据暴露面），需技术负责人确认后再启用非默认值。

**P1-4 出现位置：短期维持独立窗口 + 把 BrowserTabStrip 修上生产**
- 维持「一个浏览器实例 = 一个窗口」（与 ZCode 侧边栏形态不同，但符合 polo 已有 A 线投资与「多窗口共享 cookie 池」现状）
- `BrowserTabStrip`（多实例 tab 条，已写完）挂载到浏览器窗口自身工具栏或主窗口 TopBar，提供多实例切换——解决「多实例 = 多窗口用户找不到」的问题
- 不做：单窗口多 tab（那是渲染载体重构的前置，见 Wave-3）

### 2.3 Wave-2：AI 与用户共用浏览器的接管语义

**P2-1 双 registry（借鉴 B1）**
- BrowserPaneManager 实例加 `origin: 'agent' | 'user'`；`openPanel`（AI 路径）= agent，P1-1/P1-2 用户路径 = user
- agent 侧新增「接管用户窗口」语义：agent 可 list 用户窗口，navigate 前若目标是 user 实例需显式 claim（绑定所有权转移），避免静默操控用户正在看的页面
- 渲染层 `ToolbarStatusSlot` / BrowserTabStrip 按 origin 区分图标与文案

**P2-2 同站复用（借鉴 B2）**
- `browser_tool open/navigate` 与 `openUrl` 共用复用规则：同 hostname 已有实例 → 激活 + navigate，不新建
- 边界：`origin: 'user'` 的实例默认**不**被 agent 复用（除非 P2-1 claim 过）

**P2-3 轮尾自动截图（借鉴 B7，低成本高感知）**
- 本轮会话内 browser_tool 成功执行过 → turn 完成后自动截当前绑定实例页面，作为会话转录的展示事实（不回灌 provider context）
- 复用现有 `screenshot` 能力（`browser-pane-manager-interface.ts`），失败静默 + 日志

**P2-4 agent 控制期间的用户逃生门**
- 现状已有 overlay + resize 锁；补「用户点击 overlay 即中断 agent 控制」（对应现有 `release` 命令的 UI 化）

### 2.4 Wave-3：渲染载体与会话隔离（中期，独立任务排期，本轮不动）

- **P3-1** BrowserView → WebContentsView 迁移（Electron 39 下 BrowserView 已废弃；独立窗口形态下遮挡问题不阻塞，纯 API 换血 + 回归）
- **P3-2** session partition 按 workspace 派生（复用 `tab-browser-partition.ts` 的 scope 派生模式，替换「所有窗口共享 persist:browser-pane」）
- **P3-3** 权限治理 fail-closed 漏斗（借鉴 B5）：对 `persist:browser-pane` 注册 `setPermissionRequestHandler`/`setPermissionCheckHandler`/`setDevicePermissionHandler`，白名单 → 记录 → 弹窗 → 未知拒绝 + 审计
- **P3-4** 浏览器历史（内存环形缓冲已有 console/network/download，补 page 历史）

### 2.5 POO-110 集成点（**TBD — 等 POO-110 落地后回填**）

用户指令要求「基于 POO-110 的工作上迭代」。预期结合面（待 POO-110 实际落地后核实修订）：

1. **Browser use 能力 skill 化**（借鉴 B8）：把「内置浏览器的打开/触发/接管纪律」写成 polo 的内置 skill（触发条件 + 三段式纪律 + 截图节流），随客户端打包分发 —— 依赖 POO-110 的内置 Skill 打包机制
2. **skill 版本化**：browser-use skill 的 guidance 与 `browser_tool` 命令面作为一个有版本的发布单元 —— 依赖 POO-110 的 skill 版本/更新机制
3. **冲突面核查**：POO-110 任务卡明示「POO-109 内置 Skill 的实现可能冲突」——需在 POO-110 落地后对照其 skill 注册/分发路径，确认 P1-1/P1-2 的新增入口不与 skill 上传入口抢位

> ⚠️ 本节为占位。POO-110 完成前不启动 kimi 讨论，避免基于错误假设对齐。

### 2.6 验收标准

- Wave-1：
  - 菜单/快捷键可创建浏览器窗口并聚焦；空状态 → prompt → 会话链路不回归
  - 链接右键「在内置浏览器打开」可用；同站复用不堆叠实例
  - `browser.embeddedLinksPolicy` 默认 `system`，行为与今日完全一致（默认零回归）
  - `bun run typecheck:all` + `bun run lint` + 相关 bun test 全绿
- Wave-2：
  - agent 无法静默 navigate 用户窗口（需 claim）；用户可从 UI 分辨 agent/user 实例
  - 轮尾截图仅在轮内用过浏览器时出现，失败不阻塞会话
- 每波：`bun test` 相关套件 0 fail + 手动验收（Electron 真机，预览遵循「预览 Polo AI 默认启动 Electron」）

### 2.7 执行配置（用户指令锁定）

- 流程：`normal-coding-task-flow`
- coder: `claucom zhipu/glm-5.3-flash`
- reviewer: `claucom zhipu/glm-5.3`
- acceptor: `claucom zhipu/glm-5.3-flash`
- 完成后：产出 HTML 可视化改进（前后对比 + 架构图 + 能力清单），落 `docs/reports/`（沿用 `2026-10-18-genui-vs-openui.html` 惯例）

### 2.8 风险与边界

| 风险 | 缓解 |
|---|---|
| P1-3 改变全局链接行为，安全面扩大 | 默认关闭；单独会签；实现放 Wave-1 末位 |
| BrowserTabStrip 上生产牵出隐藏 bug（从未在生产跑过） | 先只读挂载 + feature flag；回归范围限定浏览器窗口 |
| 与 POO-110 的 skill 注册路径冲突 | 等 POO-110 落地后核查（§2.5）；Wave-1 纯客户端入口不依赖 skill 机制，可先行 |
| `browser_tool` 命令面变更破坏现有会话 | Wave-2 只加语义不改既有命令签名；legacy 别名归一已有测试 |
| Electron 39 BrowserView 废弃告警噪音 | Wave-3 才迁移，本轮不动 |
