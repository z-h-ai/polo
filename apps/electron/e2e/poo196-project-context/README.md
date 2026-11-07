# poo196-project-context（POO-196 真机体验评审 harness）

真实 Electron + 生产 renderer 模块的体验评审钉子。仿既有配方 `apps/electron/e2e/product-closure-20261027/`。

## 运行

```bash
node apps/electron/e2e/poo196-project-context/run.mjs
# 退出码 0 = 全部检查通过；证据落 /tmp/poo196-experience/evidence/
```

可调环境变量：`POO196_BUILD_DIR`（默认 /tmp/poo196-experience/build）、`POO196_EVIDENCE_DIR`（默认 /tmp/poo196-experience/evidence）、`POO196_SCENARIOS=S13,R3`（逗号分隔前缀过滤，调试/复验用）。

当前场景基数 **29**：`S0–S21`（POO-196 首轮 + R2 追加轮的 23 个既有场景）+ `R3-01–R3-06`（POO-196 R3 新增六场景）。每场景 check 数随运行输出（`SCENARIO ok <名称> checks=<n>`），报告总数来自当次运行，不写死。另有 D12 规划的 `R3-07…R3-14` 八个场景以 TODO 骨架（空实现+内容说明）保留在 main.ts 末尾，未注册、不计入本次运行。

## R3（redesign-r3，裁决 D11/D12）新增面

- `fixture-data.ts`：`pmListProductSpacesR3` 夹具（严格 v1 list + 逐 enterprise summary：`enterpriseKind: organization|project`、`purpose`、**无 `activeMemberCount`**——人数未知省略不伪造 0；organization 聚合列出不渲染卡）、D4 协作名册（`totalActiveMembers` 服务端总数 + `isSelf`，无联系/治理字段）、D3 同事目录（`projectState` 服务端判定、无源 `none` 为成功空态）、项目进入会话种子（`sess-r3-*`：同工作区多项目作用域过滤 + 更新的跨项目 decoy）、D13 空态/故障模式（`setR3SessionsMode recent|empty|fault`）、按次生成的全新 created-space id（与生产「每个项目全新 id」一致，避免创建对话框 auto-enter memo 误跳过）。
- `pages/host.tsx`：`?mode=home` 挂载生产 HomePage（生产 TabShell + MemberCatalog 注入契约——catalog 是 IPC 数据边界，夹具注入空实例，页面仍是生产源码）；space 上下文**真实提交**切换（active space + contextVersion bump，`onRequestSwitch` 可观测 `request:/committed:`，`onSelectProductSpace` 记 `select:`）；`currentAdminUser` 在 AppShell 边界内可编程（D7 ownerNeedsInput 两态）；`navigate()` 事件、`createSession`/visit-order（按账号，内存缓存用生产 `__resetProjectVisitsForTests` 清）全部可观察；入口发送门经全局 `projectEntryPendingAtom` 探针。
- `preload.ts`：新增 `pmListProductSpacesR3 / pmListCollaborationRoster / pmListColleagueOptions / pmCreateColleagueInvitation / pmQueryColleagueInvitation`（同一 coded-error 桥）。
- 新六场景（D12 编号）：`R3-01` 首页项目目录（区域顺序/organization 不出卡/未访问名称+ID 稳定排序/当前标识唯一/应用搜索不越界/同名 twin 按 ID）、`R3-02` 容量与排序（0/1/超两行边界、展开搜索收起、唯一创建入口、成功进入才写 visit、账号切换隔离）、`R3-03` 加载与撤权（骨架、error face 非空态 P4、versionUnsupported 无重试、撤权后卡与 summary 同步消失）、`R3-04` 最小创建与身份（唯一入口、表单字段可见性、责任勾选门、空介绍以合法空串穿透真实命令、129/128·513/512·65/64 DOM 边界、显示名缺失→「你的姓名」补全框+同步提示、创建成功经 onRequestSwitch 进入）、`R3-05` 直接进入与最近会话（request→committed 两段事务、fresh getSessions 后按 productSpaceId 选最近会话、无历史零写入、发送门 pending 期间拒绝+toast scopeChanged）、`R3-06` 成员面板形态（push/drawer 按 D8、名册/服务端计数/搜索、drawer role=dialog+aria-modal+backdrop、member 共享名册无管理动作）。
- **已知的 D12/实现差异（以生产代码为准）**：`useProjectEntry` 的空态进入走 `navigate(allSessions, { skipAutoSelect: true })`，但 NavigationContext 的 `NAVIGATE_EVENT` 处理只透传 `newPanel`（选项在事件边界被丢弃），自动选择会把 lastSelected 会话拉回——`project-entry-empty` 空态面在当前生产接线下不会经首页直接进入出现。`R3-05` 已按生产现实钉（零写入意图 + 落回 lastSelected 的观察钉）；空态组件自身的零写入/首发送语义由 C-UI 的 `ProjectConversationEmptyState.isolated.ts` 覆盖。`home-project-stale` testid 生产侧暂无写入方（钉子保留为假态断言）。

## 夹具边界（窗口管理 / IPC / 登录态为桩，其余生产源码）

- `pages/host.tsx`：以生产 Provider 栈（Jotai / Theme / Focus / EscapeInterrupt / Dismissible / Modal / Navigation / ProductSpace / TabShell / MemberCatalog / AppShell / Tooltip）挂载**生产 ChatPage / HomePage / ProjectConversationEmptyState / CreateProjectDialog**——由此组合出 ProjectContextTabs / ProjectFileLibrary / AssetRow / 上传与替换弹层 / ProjectPinPane / ProjectTrashView / AssetMentionPopover / ProjectAssetChip / ChatDisplay / FreeFormInput / ProjectMembersPanel / PanelHeader 成员入口。会话 fixture 经生产 atom 写入路径（`replaceLoadedSessionAtom`）预置；home 模式在入口落地后按 MainContentPanel 同一规则切换表面（details→ChatPage；已提交项目无 details→空态）。
- `preload.ts`：electronAPI 中 15 个 `pc*` 方法与 10 个 `pm*` 方法转发主进程可编程 fixture（`fixture-pc` / `fixture-pm`），并按生产 `build-api.ts` codedErrors 的方式桥接编码错误（code 随 message 过桥，`readRpcErrorCode` 解码）；`getSessions` / `getSessionMessages` / `openFileDialog` / `readFileBinary` / `getHomeDir` / `productSpaceList` 等按场景应答；其余 renderer 用到的 electronAPI 方法以中性值应答（不透传调用参数，避免不可克隆负载）。注意：**不能用 Proxy 兜底**——contextBridge 无法克隆 Proxy，会导致整个 preload 加载失败。
- `main.ts`：fixture 状态机（资产/能力/搜索索引/延迟/故障注入/文件对话框队列/预览授权 HTTP 服务/R3 目录·会话·名册·同事夹具）+ 29 个评审场景编排 + console 观测（自首个 webContents 起）+ 截图（BrowserWindow.capturePage，1440×900）+ runtime.json / pc-calls.json 留痕。可编程通道见下方 `fixture-program`。
- `fixture-data.ts`：真实感中文项目内容（需求文档 v2.3、设计稿-首页、会议纪要-1030、原型演示-首页.html 等；indexed/processing/failed/unsupported 多状态、已确认/未确认、pinned、trashed、多版本、多上传者、de 长名资产）+ R3 目录/名册/同事/进入会话夹具。

## 可编程通道（fixture-program）

场景运行中可注入：`setFault`（按方法注入 `pc_*` 错误码，支持 once）、`setPmFault`（`pm_*` 同理，含无码传输丢失 `plain`/`lost`）、`setLatency`、`setCapabilities`、`setDegraded`（搜索降级）、`queueFileDialog`、`indexAsset` / `bumpAssetVersion`（模拟他人并发变更）、`add100Assets`、`resetAssets`、`pcCallStats`、`setPmCreateScript` / `setPmInviteScript` / `setPmEmailDelivery` / `setPmReceiptState` / `resetPm` / `pmCallStats`；R3 追加：`setR3DirectoryScript`（ok/empty/one/version/fault/revoked）、`setR3SessionsMode`（recent/empty/fault）、`setR3RosterRole`（名册 viewerRole 是 live authority，member 面需按 member 应答）、`setColleagueScript`（available/none/ambiguous/fault——none/ambiguous 是成功空来源态）、`setColleagueInviteScript`、`resetR3`、`r3Stats`。

## 驱动方式

`executeJavaScript` 探针 + `webContents.sendInputEvent`（真实 char/key/mouse 事件）+ 生产 `craft:submit-input` 事件（模拟按下发送）。Radix 触发器/菜单优先走生产键盘路径（focus + Enter，与浮层提示「↑↓ 选择 · Enter 确认」一致），合成 pointer 作备选——合成 pointerdown 在 Radix 触发器上不稳定；受影响时以生产同通道兜底（如创建表单以 `#create-project-form` 的 submit 事件驱动，与浏览器 Enter 提交同一 onSubmit）。成员面板为 R3 push 形态（非模态）：Esc 步退仅在焦点位于面板内时生效（生产用户点入面板后的真实路径），面板关闭走面板自身关闭按钮。
