父任务：POO-44

## 目标

在收窄后的 Polo 助手 App 外壳中，实现 Session、附件、Skills 与全部执行上下文不可变的 ProductSpace 归属和 fail-closed 隔离。

## 前置依赖

- POO-47（App Tabs、Runtime、运行中心、任务结果、文件与平台积分阻断）。
- POO-44 已完成真实助手组件嵌入和重复全局入口移交。

## 范围

- Session、消息、附件、恢复索引和后台执行状态绑定不可变 accountId + productSpaceId。
- Skills、Sources、Automations、Browser 及其权限、工具状态和执行上下文按 ProductSpace 隔离。
- 空间切换、旧 URL/ID、复制、续跑、附件恢复和后台状态全部 fail closed。
- personal 与 enterprise 的会话、Skills、附件、索引和执行状态完全分离。
- 显式导出文件不携带隐藏会话、Prompt、工具状态或其他上下文。

## 非目标

- 从零重做助手组件、消息 UI、输入框或导航。
- 客户端全局导航、Catalog、App Runtime 或运行中心。
- 助手积分不足文案、充值弹窗和恢复动作。
- 将 Skill 渲染为独立 App、首页卡片或 Tab。

## 验收标准

1. 跨空间 Session/附件/Skill/执行 ID 和 URL 一律 fail closed，不返回部分数据或存在性侧信道。
2. 同一本地 Workspace 下 personal/enterprise 显示两套独立会话，企业助手不能加载个人 Skill、附件或上下文，反之亦然。
3. 已开始执行绑定固定空间与启动版本；切换前必须安全终止，终止失败保持原空间。
4. Sources、Automations 和 Browser 只有助手内唯一入口，不复活全局或顶层入口。
5. 导出文件只包含用户显式导出的内容，不携带隐藏会话、Prompt、权限、工具状态或跨空间引用。
6. 停止、失败、离线、恢复和附件缺失状态不会跨空间回退或串读。

## 视觉验收

- 启用 parity 视觉门禁，视口为 1440×900、1024×768、390×844。
- 按 `POO-41` UI v1 验收真实助手组件和状态，并按 `POL-94` 客户端第二轮原型核对空间归属与恢复边界；只引用权威设计，不复制设计产物。

## 自动继续与暂停规则

Session 存储、索引、IPC 和附件路径实现由研发决定。只有需要跨空间共享上下文、改变 ProductSpace 归属或重复保留全局入口时暂停裁决。

---

## 实现 Plan

状态：`awaiting-upstream-repin`  
生成日期：2026-09-08  
顺序与基线确认：已确认 `POO-47 → POO-44 → POO-48 → POO-52 → POO-49`，POO 基线为 `integration/pol68-g5-client`  
负责人确认：依赖顺序与基线已确认；需等 POO-44 集成后锁定最终助手外壳与 runtime 契约

### 1. 输入、基线与执行闸门

- 本卡正文是助手 ProductSpace 隔离权威；本计划基于卡片 rev `cc7506cccf2518f32b6a90ca27313029254ecccc75ba17a0cd4e0d3359cb7bbe`。
- 已核验 `integration/pol68-g5-client@6cbdf573961776c4e69a9d990fd943d418a9b71d`。该基线已有 account + ProductSpace + workspace 的 trusted scope token、Session 大部分 RPC 的 await 前后 currentness 检查和持久化字段，因此本卡是“补齐全部助手域并统一 fail-closed”，不是重写 Session 系统。
- 已确认的基线缺口示例：`sources.ts`、`automations.ts` 主要只按 workspace path 读写；Browser pane identity/partition 主要只有 `workspaceId`；`skills.ts` 使用独立的 `requireTrustedSkillsScope()`；renderer 的 sessions/skills/sources/automations/browser atoms 仍需证明旧 scope snapshot 不会在切换后回填。
- POO-43 尚未集成、POO-47/44 尚未完成。因此本卡当前状态必须为 `awaiting-upstream-repin`。开工前先将 POO-43、47、44 依次集成到基线，再在 POO-48 分支记录新的 branch@sha、task rev 和上游契约；不得复制未集成工作树。
- 视觉权威：POO-41 `docs/DESIGN.md` 与真实助手 flow；POL-94 第二轮客户端原型只用于归属/恢复边界。安全隔离优先于任何“看起来继续可用”的跨空间 fallback。

### 2. 文件清单与归属

| 分类 | 文件 | 计划用途 |
|---|---|---|
| existing | `packages/server-core/src/handlers/rpc/trusted-product-space-account.ts` | 复用完整 immutable scope token 与 currentness；必要时抽出通用于助手资源的断言，不建立第二套信任源 |
| existing | `packages/server-core/src/handlers/rpc/sessions.ts`、`packages/server-core/src/sessions/SessionManager.ts` | 审计 list/create/send/cancel/respond/search/files/watch/export/import/branch/resume 的入口、await 和发布边界 |
| existing | `packages/server-core/src/handlers/rpc/skills.ts`、`sources.ts`、`automations.ts` | 所有读写/凭证/权限/执行/历史统一绑定完整 trusted scope，并在异步返回前复验 |
| existing | `packages/server-core/src/handlers/browser-pane-manager-interface.ts`、`apps/electron/src/main/browser-pane-manager.ts`、`apps/electron/src/main/handlers/browser.ts` | Browser instance、partition、下载、截图、console/network、bind/focus/destroy 绑定 immutable owner scope |
| existing | `packages/shared/src/product-spaces/context-key.ts`、`packages/shared/src/product-spaces/ids.ts`、`packages/shared/src/product-spaces/types.ts` | 复用版本化 JSON tuple，定义助手资源 owner key；不使用分隔字符串 |
| existing | `packages/shared/src/sessions/types.ts`、`storage.ts`、`session-storage.ts`、`jsonl.ts` | 持久化 accountId/productSpaceId/workspaceId，导入/恢复/导出时严格校验和脱敏 |
| existing | `apps/electron/src/renderer/atoms/sessions.ts`、`skills.ts`、`sources.ts`、`automations.ts`、`browser-pane.ts` | snapshot/cache 以 committed scope generation 为 owner；切换即失效，迟到响应拒绝回填 |
| existing | `apps/electron/src/renderer/context/ProductSpaceContext.tsx`、`AppShellContext.tsx`、`SessionListContext.tsx` | 将已提交 scope/generation 传到助手真实组件，pending target 不得提前成为数据 owner |
| existing | `apps/electron/src/renderer/hooks/useAutomations.ts` 及 Sources/Skills/Session hooks | 入口捕获一次 scope token，返回时核对 generation；旧 ID/URL 不做模糊回退 |
| existing | `packages/server-core/src/sessions/assistant-scope-persistence.test.ts`、`packages/server-core/src/handlers/rpc/__tests__/product-space.isolated.ts` | 扩展跨域隔离、重启恢复和切换竞态矩阵 |
| upstream-expected | POO-47 runtime/文件 projection 与普通终止契约 | 助手执行、附件和显式导出只接入最终 owner；路径/API 待 re-pin |
| upstream-expected | POO-44 固定助手 App/Tab 挂载与入口所有权 | 作为 renderer 真实交互入口；不得把已移交的全局入口复活 |
| new-by-this-task | `packages/server-core/src/handlers/rpc/assistant-resource-scope.isolated.ts` | Sources/Skills/Automations/Browser 共用负向矩阵，覆盖跨空间 ID 与迟到响应 |
| new-by-this-task | `apps/electron/src/renderer/components/app-shell/__tests__/assistant-scope-switch.interaction.isolated.tsx` | 真实组件切空间时清空、拒绝 stale publish、终止失败保持原空间 |
| new-by-this-task | `packages/shared/src/product-spaces/__tests__/assistant-scope-keys.test.ts` | tuple 防碰撞、personal/enterprise、workspace 独立与 legacy 缺字段拒绝 |

Re-pin 后若 POO-47 已提供可复用 scope projection/test harness，扩展它而不保留重复新文件；所有 `upstream-expected` 必须改为实际 `existing` 路径后才可接受计划。

### 3. 冻结技术决策

1. **唯一 owner tuple**：每个 Session、消息、附件、Skill/Source/Automation 配置与授权、Browser instance、后台执行都由 `contractVersion + accountId + productSpaceId + workspaceId` 所有；资源自身 ID 追加在 tuple 后。account/ProductSpace 在创建时不可变，不能从活动窗口、路径或 URL 推断。
2. **一次捕获、全程复验**：RPC/renderer action 在入口捕获 complete trusted scope token；任何 await、磁盘读取、网络返回、事件发布和最终 commit 前验证 token/generation 仍 current。失效统一返回 typed scope refusal 或空投影，不泄露对象是否存在。
3. **存储隔离而非仅 UI 过滤**：workspace 根目录相同不能代表 scope 相同。Session metadata 继续带 owner；Sources/Skills/Automations/Browser 的可变状态要用版本化 owner key/受控 scope root 或带 owner 的记录隔离。只在 renderer filter 数据不合格。
4. **切换事务**：切换前 drain/stop 当前空间助手执行与 Browser ownership；全部确认后才提交新 ProductSpace。终止失败或 generation replacement 保持原 scope、原视图和可重试状态，不半切换。
5. **fail-closed 访问**：旧 Session/attachment/skill/source/automation/browser ID、旧深链、copy/resume/import/watch 回调只做 exact owner match；错误空间与不存在返回同类拒绝，不 fallback 到 personal、当前 workspace 或 display-name 匹配。
6. **显式导出是唯一跨边界**：导出 payload 只含用户明确选择的正文/文件；剥离 prompt、隐藏消息、tool state、permission/credential、绝对 owner path、session/runtime key。导入成为目标 scope 的新对象，不保留源 scope 可调用引用。
7. **Scope 与 UI 分层**：POO-44 的入口所有权不改变；POO-48 只让保留在助手里的 Sources/Skills/Automations/Browser 使用正确 scope，不新增顶层入口，也不把 Skill 变成 App。

### 4. 实施顺序

1. **建立覆盖矩阵**：列出 Session/消息/草稿/附件/索引/branch/resume、Skills、Sources、Automations、Browser、background execution 的 create/read/update/delete/watch/export/import，标记当前 scope capture、await revalidation、storage owner、renderer owner 和缺口。
2. **统一受信边界**：在 `trusted-product-space-account.ts` 复用/小幅泛化现有完整 token 断言；先扩展协议和 isolated tests，再逐个 handler 接入。禁止把 renderer 传入的 accountId/productSpaceId 当权限依据。
3. **补齐服务端资源隔离**：按 Sources → Skills → Automations → Browser 顺序改造。所有路径解析先验证 workspace 属于 token；credential key、permission path、history file、Browser partition/instance 必须含 owner scope。每个异步副作用前后都复验。
4. **审计 Session 全生命周期**：保留已正确实现的 token fence，只修矩阵中实际缺口；重点覆盖 branch/copy、resume、attachment hydration、search/watch、pending permission/question、background callback、cold restart 与 import/export。
5. **Renderer generation fence**：scope commit 时原子清空旧 atoms/query state；请求闭包携带 owner key + generation，迟到 promise/event 只能丢弃。pending switch 期间继续显示原 owner，不显示目标空间数据。
6. **切换与终止协同**：复用 POO-47 generation-safe terminate/drain；Browser/automation/session 均返回可判定的 settled/failed 集合。失败保持原空间，不清空到一个看似成功的新空间。
7. **导出/导入脱敏**：为显式导出建立 allowlist schema；测试 payload 中放入 canary prompt、权限、tool state、跨空间路径，证明全部被剥离。导入重新 stamp 当前 trusted owner。
8. **真实 UI 回归**：用 POO-44 已集成的真实组件跑 personal-A/enterprise-B，同 workspace、同 display name、复用 ID 的攻防矩阵；核对无全局入口回归。

### 5. 验证与完成证据

- 隔离矩阵至少覆盖：personal-A 与 enterprise-B；同 workspace；同 session/skill/source/automation/browser display name；伪造旧 ID；切换中迟到 list/detail/event；登出/换账号；重启恢复。
- Session：list/create/send/cancel/kill/respond/search/files/watch/notes/export/import/branch/resume 全部有正向与跨 scope 负向测试；跨空间拒绝不得透露存在性。
- Sources/Skills/Automations：读写、credential、permission、test/run/history/replay 都验证 owner；企业助手不能读个人资源，反之亦然。
- Browser：partition/cookie、instance list、bind/focus/destroy、console/network/download/screenshot 和 session control 均按 owner 隔离；切换失败不把旧 Browser 绑定给新空间。
- 导出：canary 扫描证明无隐藏 prompt/session/tool/permission/credential/owner key；导入对象只属于目标 scope。
- 视觉：1440×900、1024×768、390×844 验证 loading/empty/failure/offline/switch-failed/attachment-missing，安全拒绝不以旧数据闪回。
- 仓库门禁：相关 isolated tests 后运行 `bun run typecheck:all`、`bun run lint`、i18n parity/sorted、`bun run test`、`bun run electron:build`。
- 完成证据记录最终 baseline SHA、POO-47/44 集成提交、task rev、矩阵结果、full tests、视觉证据、commit/push/远端相等与集成证明；不把 Coding Pass 当交付。

### 6. 风险、迁移与回滚

- **兼容风险**：旧记录可能缺 accountId/productSpaceId。推荐行为是隔离到不可见 quarantine/迁移候选，不猜归属；只有拥有可证明来源的 deterministic migration 才自动 stamp。
- **路径风险**：现有 Sources/Automations 配置位于共享 workspace root。迁移必须 copy-verify-switch，写入 owner manifest 后再切读路径；失败继续使用原 scope 的旧读路径但绝不暴露给别的 scope。
- **竞态风险**：await 后的旧响应最容易回填新空间。例如用户从 personal 切企业时，personal 的 skills list 晚到；正确结果是按 generation 丢弃，而不是显示一帧再清空。
- **范围风险**：POO-42 已完成的 Session fences 很多，盲目重构会扩大回归。以缺口矩阵和负向测试驱动最小修改。
- 回滚按资源域独立进行，保留新 schema 的向后可读能力；不得通过关闭 scope 校验恢复功能。

### 7. 被否决方案与自检

- 否决只给 renderer list 加 `productSpaceId` filter：直接 RPC、迟到事件和磁盘读取仍泄露。
- 否决把 `workspaceId` 当 ProductSpace：同一 workspace 可被 personal/enterprise 共同使用。
- 否决遇到旧记录时归到当前空间：会把历史数据静默转让给错误 owner。
- 否决切换失败后继续显示目标空间 shell：这制造 split-brain。
- 否决在本卡顺手实现 POO-49 积分 UI或 POO-52 enablement。
- 自检问题：每个读写路径在哪里验证完整 owner？每个 await 后如何拒绝 stale token？每个本地路径/credential/Browser partition 如何隔离？错误空间与不存在是否同响应？导出 allowlist 是否可机器验证？有任一答案依赖“UI 不会调用”，计划不可接受。

### 8. Re-pin 清单

- [ ] POO-43、POO-47、POO-44 按顺序完成 Acceptance、commit/push 并集成。
- [ ] POO-48 从最新 `integration/pol68-g5-client@sha` 创建干净 worktree。
- [ ] scope 覆盖矩阵针对新基线重跑，已完成项删除、真实缺口保留。
- [ ] POO-47 runtime 和 POO-44 assistant shell 的 `upstream-expected` 路径全部解析为 `existing`。
- [ ] migration/quarantine 行为、导出 allowlist、切换失败语义未改变任务产品承诺。
- [ ] 负责人接受 re-pin 后最终文件清单和风险，再将状态改为 `accepted`。

## 2026-09-09 Scope 拆分与执行入口

状态：`coordination-only`。本卡保留原始 Intent、Spec、条件 Plan 与历史证据，但不再拥有产品代码 commit、实现 worktree 或 Ultra 执行。

### 子任务与显式依赖

- POO-59：隔离助手会话消息与附件上下文；依赖 POO-44 完成并集成。
- POO-60：隔离助手 Skills、Sources 与 Automations；依赖 POO-59 完成并集成。
- POO-61：隔离助手 Browser 与后台执行上下文；依赖 POO-59 完成并集成。
- POO-62：实现助手跨空间显式导出导入与旧数据隔离；依赖 POO-60、POO-61 全部完成并集成。

### 协调完成条件

- POO-59、POO-60、POO-61、POO-62 全部通过 Acceptance、commit/push、远端相等和集成证明后，本协调卡才可完成。
- POO-52 的实现入口必须等待 POO-62 集成；不得从本父卡旧 Plan 直接启动。
- 每张子卡在直接前置集成后分别 re-pin 并接受自己的 Plan；高风险切片需绑定 Plan hash 的技术会签。
