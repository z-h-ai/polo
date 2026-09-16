父任务：POL-105

## 目标

实现 ProductSpace-aware 的成员 Skill enablement 入口，让成员能在 Polo 客户端内看到企业已分发、但本人未启用的 Skill 实例并完成本人启用；同时发布版本化深链，使企业概览（POL-105）能把成员精确引导到该入口。本卡是 POL-105 验收标准 5「成员 Skill 启用恢复轴」在客户端侧的闭环承接卡：POL-105 裁决已选 expand_polo_client_enablement，本卡完成并 release、契约回登记后，web 概览面板升级为可执行入口。

## 权威输入

- polo-admin 仓库 `docs/polo-client-deep-links.md`（深链契约与变更规则：客户端 release 先注册 → 契约表登记参数 schema → web 消费方才可升级；在此之前不得发明参数语义）
- POO-48 助手会话、附件、Skills 与执行上下文的 ProductSpace 隔离
- POO-43 成员首页统一 Catalog 与安装
- 既有 enablement API：`PUT /product-spaces/{productSpaceId}/skills/{artifactInstanceId}/enablement`（business-session bearer-only；语义见 polo-admin `src/lib/product-spaces/enterprise-skill-enablement.ts`：分发归管理员、启用归成员本人，enable 失败须 fail closed，disable 幂等收敛为 off）

## 前置依赖

- POO-48 完成 Skills 的 ProductSpace 隔离。
- POO-41 UI v1 已冻结。
- 基线分支：`integration/pol68-g5-client`，本卡分支从该基线派生。

## 范围

- 企业 ProductSpace 内「已分发未启用」Skill 实例的客户端投影（名称、实例标识），仅成员本人视角。
- 成员本人的启用/停用控件：以 business-session bearer 调用既有 enablement PUT，不新增、不放宽边界。
- ProductSpace-aware 深链 route：携带或安全解析 ProductSpace 与待启用实例，落地到可见且可执行的本人 enablement 控件；无有效上下文时不得落到错误的 workspace。
- 深链参数 schema 版本化：release 注册后回登记到 polo-admin 仓库契约文档 `docs/polo-client-deep-links.md`，作为 web 消费方升级的前置锚点。

## 非目标

- 不实现管理员分发管理（admin 侧已有）。
- 不实现 web 端概览消费升级（POL-105 侧，待契约回登记后进行）。
- 不展示其他成员的启用状态、成员用量或任何财务信息。
- 不改变 bearer-only enablement 边界，不以 enterprise_session 调用 enablement。
- 不改变 POO-41 冻结的交互与文案基线。

## 验收标准

1. 成员在客户端内可见本人在该企业 ProductSpace 下已分发未启用的 Skill 实例清单（含名称与实例标识）。
2. 成员本人可启用/停用实例，命令走既有 PUT，重复启用幂等；停用遵循「收敛为 off、不因不可分发而失败」的既有语义。
3. 深链携带 ProductSpace/实例上下文精确落到本人 enablement 控件；缺少上下文或实例不在本人范围时 fail closed（不落错误空间、不假成功）。
4. 深链参数 schema 随 release 登记，polo-admin 仓库契约文档同步更新；web 侧升级不在本卡。
5. 正常、空、加载、失败、实例被撤销或空间受限状态符合 POO-41 UI v1。

---

## 实现 Plan

状态：`awaiting-upstream-repin`  
生成日期：2026-09-08  
顺序与基线确认：已确认 `POO-47 → POO-44 → POO-48 → POO-52 → POO-49`，POO 基线为 `integration/pol68-g5-client`  
负责人确认：依赖顺序与基线已确认；需等 POO-48 集成后重建干净执行分支并裁剪历史 WIP

### 1. 输入、基线与执行闸门

- 本卡正文是成员本人 Skill enablement 与版本化深链的需求权威；本计划基于卡片 rev `201051dd1347400bc264491aa73228e40c1a16a908a24efaf383aaa05c8b80ec`。
- 权威 POO 基线已核验为 `integration/pol68-g5-client@6cbdf573961776c4e69a9d990fd943d418a9b71d`，且本地与远端一致。当前基线只有 `createSkillEnablementPath()`，尚未包含 enablement Admin client/RPC/preload/UI/版本化深链。
- POO-52 现有 worktree 不是可直接续做的基线：`POO-52/feat/productspace-skill-enablement@86be8e63333842efeb050b6e2be226d69850bec3` 含多轮旧提交及 18 个 tracked 未提交文件；旧 Ultra 终态 failed，虽然 5484 tests、typecheck、build 曾通过，但视觉 desktop `0.058052`、mobile `0.095668` 高于 `0.03`，未 push/未集成。这些只算可回收的实现证据，不算交付。
- POO-48 尚未完成。开工闸门：POO-43、47、44、48 按顺序进入 `integration/pol68-g5-client`；先不可逆地保全旧分支/WIP，再从最新集成 SHA 建干净 POO-52 worktree，逐项语义移植。禁止直接 rebase 脏 worktree，禁止整段 cherry-pick 旧的 23 个任务提交，也禁止把与本卡无关的 startup/window/security hardening 带回。
- 客户端 release 前只维护 client-side 契约；release identifier 与支持版本明确后，才把 schema 回登记到 polo-admin 的 `docs/polo-client-deep-links.md`。该文档当前只在 POL-105 分支历史可见，不在本卡 admin 基线中，因此属于外部 `upstream-expected`，不能提前假装已登记。

### 2. 文件清单与归属

| 分类 | 文件 | 计划用途 |
|---|---|---|
| existing | `packages/shared/src/product-spaces/paths.ts` | 复用既有 bearer-only enablement endpoint builder；不新增第二个 URL 语义 |
| existing | `packages/shared/src/product-spaces/schemas.ts`、`packages/shared/src/protocol/{channels,dto,routing,types}.ts` | 增加最小 typed enablement command/result 与可信 Catalog projection；通道仍由主 renderer 调用 |
| existing | `packages/shared/src/admin/client.ts` | 用 business-session bearer 调用既有 PUT；请求前后校验 ProductSpace、artifact instance 与 catalog tuple |
| existing | `packages/server-core/src/handlers/rpc/product-space.ts`、`packages/server-core/src/handlers/rpc/__tests__/product-space.isolated.ts` | 从 Main-owned active context 派生 scope，代理 list/set；await 后拒绝 stale account/ProductSpace generation |
| existing | `apps/electron/src/preload/admin-api.ts`、`bootstrap.ts`、`shared/types.ts`、`transport/channel-map.ts` | 暴露最小 enablement API，保持 channel parity，不开放任意 Admin client |
| existing | `apps/electron/src/main/deep-link.ts`、`index.ts`、`window-manager.ts` | 解析并可靠投递版本化 `poloai://product-spaces/v1/skill-enablement?productSpaceId={ProductSpaceId}&artifactInstanceId={ArtifactInstanceId}`；绑定受信 renderer，启动前到达时有界排队 |
| existing | `apps/electron/src/main/__tests__/deep-link-routing.test.ts` | 覆盖合法/非法 schema、编码、冷启动、重复投递、错误窗口和日志脱敏 |
| existing | `apps/electron/src/shared/routes.ts`、`route-parser.ts` | 把外部 v1 schema 转成 typed Skills detail；内部 generation 只用于 stale delivery fence，不成为外部参数 |
| existing | `apps/electron/src/renderer/App.tsx`、`contexts/NavigationContext.tsx` | 消费深链、验证目标 ProductSpace 可见后请求 trusted switch；切换失败不落错误空间 |
| existing | `apps/electron/src/renderer/components/app-shell/SkillsListPanel.tsx`、`MainContentPanel.tsx` | 在助手 Skills 内呈现本人 enablement list/detail，不创建顶层 App/Tab |
| new-by-this-task | `apps/electron/src/renderer/components/product-space/SkillEnablementPage.tsx` | 显示企业当前空间已分发的 Skill 实例与本人 enabled 状态，支持本人幂等切换 |
| new-by-this-task | `apps/electron/src/renderer/components/product-space/__tests__/SkillEnablementPage.interaction.isolated.tsx` | ready/empty/loading/failed/revoked/restricted/wrong-space/stale-response/移动布局矩阵 |
| new-by-this-task | `apps/electron/src/renderer/components/app-shell/__tests__/product-space-skill-enablement-architecture.test.ts` | 钉死入口只在 Skills 内、无 admin/enterprise_session 边界、无其他成员/财务字段 |
| new-by-this-task | `docs/polo-client-skill-enablement-deep-link.md` | client release 的 schema、最小支持版本、失败语义和例子；作为跨仓回登记输入 |
| existing | `packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,zh-Hans}.json` | enablement 状态与无障碍文案，保持 locale parity/sorted |
| existing | `apps/electron/resources/release-notes/next.md` | 按该目录 AGENTS 只追加 next.md，不猜版本文件；最终提交 hash 明确后补引用 |
| upstream-expected | POO-48 最终 Skill/ProductSpace scope token、renderer generation fence 与隔离测试 harness | re-pin 后改为真实 existing 路径并直接复用 |
| upstream-expected | polo-admin `docs/polo-client-deep-links.md` 所在的可集成分支 | client release 后登记 v1 schema 与最小客户端版本；POL-105 再消费 |

旧分支中 `initial-deep-link-replay.ts`、`renderer-client-binding.ts`、`secure-browser-window.ts`、`webview-security-bootstrap.ts` 等候选只有在新基线仍存在本卡可复现缺口时才纳入；否则明确排除，避免把历史审查修复扩成 POO-52 所有权。

### 3. 冻结技术决策

1. **外部深链 schema**：沿用已实现并记录的 v1 契约 `poloai://product-spaces/v1/skill-enablement?productSpaceId={ProductSpaceId}&artifactInstanceId={ArtifactInstanceId}`，不得重新发明 path 或参数。只接受两个 opaque ID 与可选 `window`；未知版本、缺失/重复/未知参数、空值、前后空白和 account/member/workspace selector 全部拒绝。renderer generation 是本地投递 fence，不出现在公开契约。
2. **精确但不越权**：深链只表达期望目标。Main/renderer 必须用当前 business session 重新取得可见 ProductSpace 与 Catalog；若空间不可见、非 enterprise、受限、实例未分发或不是 Skill，则显示通用拒绝/受限状态，不泄露对象是否存在，也不 fallback 到当前 workspace。
3. **本人 enablement**：唯一命令仍是 `PUT /product-spaces/{productSpaceId}/skills/{artifactInstanceId}/enablement`，使用 business-session bearer。客户端不接受 enterprise_session、不传 memberId、不允许选择其他成员。重复 enable 幂等；disable 按服务端契约收敛 off。
4. **Catalog 是可执行投影**：列表只用当前 trusted Catalog 中的 Skill instance；展示 name + artifactInstanceId + 本人 enabled。服务端撤销后，当前 action 失败并刷新投影；UI 不用旧缓存宣称成功。
5. **状态与竞态**：请求捕获 accountId/ProductSpace/context generation/artifact tuple；任何 await 后 scope 变化都丢弃结果。深链在 renderer ready 前有界 FIFO；每个受信窗口一次投递，重复 OS event 去重，无法安全投递就保留/拒绝，不广播给任意 webContents。
6. **入口位置**：页面是助手 Skills navigator 的 detail，复用 POO-44 真组件与 POO-48 隔离；不创建首页卡片、独立 App 或全局设置入口。
7. **跨仓发布顺序**：client 实现+Acceptance → release 生成真实版本 → 本地契约文档落定 → polo-admin 契约表登记 → POL-105 才升级为可执行入口。任何前置阶段只可显示能力受限说明，不能声称精确跳转已可用。

### 4. 实施顺序

1. **保全与 re-pin**：为旧 `86be8e63` 和 18 文件 WIP 建只读 rescue ref/提交证明；从 POO-48 已集成的新基线创建干净分支。用 `range-diff` 和文件职责表识别可移植行为，不把旧分支当 merge source。
2. **共享契约/API**：先在 product-space schema、protocol 和 Admin client 增加 typed list/set；测试 bearer-only、URL encoding、trusted tuple、response mismatch、revoked instance、stale account response。
3. **server-core/preload**：handler 从当前 trusted context 取 owner，不信任 renderer account；调用前后复验 generation。补 channel map、preload surface 和 IPC parity。
4. **版本化深链**：在 Main 严格解析 `product-spaces/v1/skill-enablement` 及两个 query ID，拒绝未知版本、缺失/重复/未知参数、空白和非法编码；冷启动先排队，renderer 安全 ready 后投递到正确窗口。日志只记 route kind/version，不记完整 ID 或 URL。
5. **typed 内部路由**：`routes.ts`/`route-parser.ts`/NavigationContext 使用结构化 detail；收到目标后先确认 ProductSpace 可见，再走 POO-48 trusted switch。失败保持原空间并渲染 wrong-space/restricted，不把目标标成 active。
6. **Skills 页面**：`SkillsListPanel` 提供入口，`MainContentPanel` 渲染 `SkillEnablementPage`。页面按当前空间加载 Catalog，保留 service order 或明确稳定排序；toggle 期间锁单行，成功后校验回包 tuple 并更新，失败刷新事实。
7. **旧 WIP 语义裁剪**：逐项对照 tests 移植 stale response、revoked tombstone、cold-start queue、renderer binding；与 POO-48/新基线重复的 ProductSpace shell/security hardening全部舍弃。
8. **发布与登记**：通过门禁后更新 `release-notes/next.md` 和 client 契约文档；release 后在 polo-admin 正确集成分支更新 `docs/polo-client-deep-links.md`，登记 URI、参数、最小版本、fail-closed 和 fallback，给 POL-105 明确消费 SHA。

### 5. 验证与完成证据

- API：business bearer 成功；enterprise_session/匿名/跨空间/其他成员选择全部失败；enable 幂等、disable 收敛 off、回包 tuple mismatch 拒绝。
- 深链：running/cold-start/single-instance；重复 event；未知版本；缺失/重复/未知 query、空白/非法编码；不可见/受限/已撤销空间；实例不在 Catalog；深链到达与空间切换竞态；任何失败不落错误 workspace。
- UI：已分发未启用、已启用、空、加载、失败、撤销、受限、wrong-space；只显示名称、实例标识和本人状态，不显示其他成员、余额或用量。
- 隔离：personal 与 enterprise 同名 Skill、相同 artifact display name、旧 generation 响应；新空间不得闪现旧列表/成功 toast。
- 视觉：POO-41 三视口 1440×900、1024×768、390×844 parity。旧视觉 diff 仅作回归线索，不能复用为通过证据；必须在新基线重新截图并达到门禁阈值。
- 仓库门禁：targeted tests 后运行 `bun run typecheck:all`、`bun run lint`、i18n parity/sorted/coverage、`bun run test`、`bun run electron:build`。
- 交付链：实现 Acceptance、commit、push/远端相等、集成、release artifact/identifier、client 契约、polo-admin 契约登记、POL-105 handoff 分别留证；缺任一项不得宣称完整交付。

### 6. 风险、回滚与非范围

- **最大风险是历史 WIP 污染**：旧 76 文件差异混入通用 security/startup 工作。推荐从新基线重新实现狭窄 file set，只把失败测试能证明仍必要的行为移植。
- **跨仓契约风险**：任务正文引用的 admin 文档不在当前 admin 基线。推荐 release 后在文档真实 owner 分支登记；若该路径仍不存在，暂停由 owner 决定创建位置，不能在客户端仓库伪造同名权威。
- **深链竞态风险**：例：深链指向 enterprise-B，同时用户正在从 personal-A 切换；只有 B 成功 commit 且 generation 仍一致才显示控件，否则留在 A 并明确失败。
- **视觉风险**：旧实现功能门禁通过但 parity 失败，说明 DOM/布局变化不能以“功能正确”豁免。优先复用 POO-41 token/布局，不改全局 shell。
- 回滚可独立关闭 v1 route 与 Skills detail，不回滚 POO-48 隔离；服务端 endpoint/客户端 parser 对未知版本继续 fail closed。
- 非范围：管理员分发、其他成员状态、财务、POL-105 Web UI、全局 Browser/窗口安全重构、POO-49 积分恢复。

### 7. 被否决方案与自检

- 否决继续在当前脏 worktree直接编码或强行 rebase：会丢 WIP或把旧基线污染带入。
- 否决整段 cherry-pick POO-52 历史：提交包含超出本卡的安全/启动修复。
- 否决 `poloai://skills` 通用入口冒充精确 enablement：不能满足 ProductSpace/instance 定位。
- 否决把 memberId、payer、workspace 放进深链：这些必须由当前受信会话解析。
- 否决用 enterprise_session 代成员调用 PUT，或在 UI optimistic success 后不校验回包。
- 自检问题：外部 schema 是否真实版本化？冷启动是否可靠且只投给受信 renderer？每次 action 是否以当前 ProductSpace/Catalog重新授权？旧 WIP每个移植文件是否在任务范围？release 与 admin 登记是否有真实 SHA/版本？任一答案为否，计划不可接受。

### 8. Re-pin 清单

- [ ] POO-48 已 Acceptance、commit/push 并集成到 `integration/pol68-g5-client`。
- [ ] 旧 POO-52 HEAD 与 18 文件 WIP 已有可恢复证明，未丢失、未作为新基线。
- [ ] 新 POO-52 worktree 从最新集成 SHA 派生且干净。
- [ ] POO-48 的 Skill scope/generation API 已从 `upstream-expected` 改为真实 `existing` 路径。
- [ ] 外部 v1 URI/schema、最小版本和 POL-105 fallback 已由 owner确认。
- [ ] 新基线重新跑过功能、隔离、视觉和 full gates，旧 failed 结果不被当作通过。
- [ ] re-pin 后文件清单获负责人接受，状态才可改为 `accepted`。

## 2026-09-09 Scope 拆分与执行入口

状态：`coordination-only`。本卡保留原始 Intent、Spec、历史失败/WIP 与条件 Plan，但不再拥有新的产品代码 commit、实现 worktree或 Ultra 执行；旧 WIP 只作可恢复参考，不得成为子卡基线。

### 子任务与显式依赖

- POO-63：实现成员 ProductSpace Skill 启用入口；依赖 POO-62 完成 Acceptance、push 并集成。
- POO-64：发布成员 Skill 启用版本化深链；依赖 POO-63 完成 Acceptance、push 并集成。

### 协调完成条件

- POO-63、POO-64 均完成 Acceptance、commit/push、远端相等和集成证明后，本协调卡才可完成。
- POO-64 唯一拥有公开 v1 URI、客户端 release identifier、minimum version 与 polo-admin 权威文档/POL-105 fallback 回登记；不得重新发明 URI。
- POO-49 的实现入口必须等待 POO-64 集成。
