# POO-215 候选②③客户端线 Plan（代码级）

状态：实现中（②③线，tmux `POO-215-project-context-exec`）。
权威裁决：`spec.md` §4 Q5/Q7 + §4.1 U1–U4/U7。本文档是该裁决在客户端两仓面的代码级落地方案与状态回执载体。

## 0. 调研结论（2026-11-15，代码已核实）

### 现状注入链（候选③改造对象）

1. renderer send → RPC `sessions.SEND_MESSAGE`（`packages/server-core/src/handlers/rpc/sessions.ts:483`）；
2. `sessions.ts:509` 每次调用 `resolveSessionProjectContext`（`packages/server-core/src/project-context/service.ts:688`）：
   - `headerPromise`：1 次 `admin.summary` → 2 行头（`项目：N 个共享文件，其中 M 个已确认结论` + overview），service.ts:728-734；
   - `referencePromise`：逐个 @ 引用 `admin.getRead`，逐条落 outcome（ok/missing/stale/failed），service.ts:737-766；
   - 合成单块 `<project-context>`（service.ts:639 `buildProjectModelContextBlock`），总预算 4s（`PC_SEND_RESOLVE_TIMEOUT_MS`，:66），块 16KB（`PC_BLOCK_TOTAL_BYTES`，:69），单引用 4KB（:70），每 send 最多 10 引用（:73）。
3. `sendOptions.projectModelContext` → `SessionManager.sendMessage` stage 到 `managed.pendingProjectModelContext`（`packages/server-core/src/sessions/SessionManager.ts:1201`，仅在 create-new-message 分支 stage，:9603-9605；queue replay 不 stage）；
4. 一次性消费注入 `<system-reminder>`（SessionManager.ts:10104-10109，wrapper 文案 :1465 `buildProjectModelContextReminder`），块用完即弃、永不持久化。

### 关键事实（影响设计）

- **项目指令已有独立通道**：POO-205 C7a 的 `formatProjectContextSystemAppend`（`packages/shared/src/prompts/system.ts:368`）在 claude-agent.ts:3115 / pi-agent.ts:2346 每轮 non-mini turn 把 `<project_context>` + `<project_instructions>` 注入 **system prompt**。指令类内容（持续约束语义）的正确归所就是 system prompt。
- **`resolveSessionProjectContext` 目前零测试**：`packages/server-core/src/project-context/__tests__/` 5 个文件均未覆盖 send path。
- **内存 string 落库唯一现成通道**：`storeAttachment`（text 分支，`packages/server-core/src/handlers/rpc/files.ts:314/475-478`）→ 返回 `storedPath` → `prepareAssetUploadFile`（`apps/electron/src/renderer/components/project-context/asset-upload-prep.ts:86`，算 sha256/mime/size）→ `pcUploadFile`。`ShareToProjectDialog.tsx:276-303` 的 text 分支就是这么走的，沉淀流完全复用，**零新 RPC、零 admin 契约改动**。
- **confirmed 标签是 version-bound 受控标签**（`PC_CONTROLLED_TAG_ID='confirmed'`，`project-context-contract.ts:113`；`PcVersionDto.confirmedAt`，:245）：不能作为上传 tags 传入（renderer 已禁手打，ShareToProjectDialog addCustomTag 保留字校验），落库后须 `pcSetConfirmed({confirmed:true})` 单独设置。
- **agent 工具注册链**（新增工具改动清单，代码已核实）：`project-context-types.ts:40-46` facade 接口 + 叶子 schema（不能放 tool-defs.ts，防环）→ `handlers/project-context.ts` handler → `handlers/index.ts:53` 导出 → `tool-defs.ts`（TOOL_DESCRIPTIONS :1082 区 + SESSION_TOOL_DEFS :1142 + 可见性过滤 :1304）→ `index.ts` 导出 → `pi-agent.ts:1900` per-call 兜底拒绝 → server-core `tool-facade.ts:74` facade 实现。
- **工具结果渲染**：tool activity（`toolName/toolInput/content/status/toolUseId`）进 `packages/ui/src/components/chat/TurnCard.tsx`；「completed tool activity → 专属卡片」既有先例 = GenUICard（:2903-2914 数据 + :3193 渲染）与 GenUiAppCard（:2957-2982 + :3220-3231）；裸名与 `mcp__session__` 前缀双形态判定是 `genuiSkeleton.ts:55-64` 的明文要求。
- **设计系统 Skill 适用性**：`polo-client-design-system` 绑定模块为登录/外层顶栏/首页/圈子，**不含会话内沉淀卡**；卡片沿仓库既有 project-context 组件风格（BatchUploadView/ShareToProjectDialog 的原语组合），不触发基线再生流程。
- **i18n**：`projectContext.*` 七语言（en/de/es/hu/pl/ja/zh-Hans）扁平键、字母序、parity+sorted+coverage 三校验；`share.*` 段现用「分享到项目」措辞（en "Share to project" 等）。

## 1. 候选③：项目头首条注入收敛（U7 + Q7）

### 1.1 设计

**原则：契约不动、stage 槽不动、@ 引用链路不动；只改 header 的产出条件与内容。**

1. **首条判定**（service.ts `resolveSessionProjectContext` 内）：
   - `await deps.sessionManager.getSession(sessionId)`（async、返回含完整 messages 的 Session，`session-manager-interface.ts:53`）；
   - `isFirstProjectHeaderTurn = !messages.some(m => m.role === 'user')`。
   - 时序正确性：RPC handler 在 `sessionManager.sendMessage` **persist 消息之前** await 本函数（sessions.ts:509），首条 send 时 messages 尚无任何 user message → 判定为首条 ✅；queue replay 时消息已 persist → 不再判定为首条，且 replay 分支本就不 stage（SessionManager.ts:9601-9605）✅；会话重启恢复（messages 从 JSONL 重建）→ 首 user message 已存在 → 不再注入，符合 Q7「新建会话首条消息注入一次」语义 ✅；agent 实例重建不影响 messages ✅。
2. **header 产出条件化**：仅 `isFirstProjectHeaderTurn` 时跑 `headerPromise`；后续轮次 headerLines 恒为 `[]`。`referencePromise`（@ 引用逐条解析 + chip persist）**每 send 照旧**——引用 chip 状态不受本次收敛影响（任务约束原文）。
3. **U7 概况升级**（首条 headerLines 内容）：
   - 资产统计：`admin.summary` 的 `assetCount/confirmedCount/overview`（现状 2 行保留，措辞微调）；
   - **确认/置顶摘要**：新增 1 次 `admin.listAssets({ view:'active', pinned:'true', limit: 8 })`（`ProjectContextAdmin.listAssets` 已存在，admin-client.ts:55；PinPane 同参数先例 ProjectPinPane.tsx:61-73）→ 列置顶资产名+版本（前 8 个，超出以「等 N 个置顶」计数行收尾）；confirmed 维度沿用 summary.confirmedCount；
   - **项目指令：不进 PC header**。理由：POO-205 C7a 已把 `<project_instructions>` 注入每轮 system prompt（持续约束的正确通道），PC header 再注入一次是双通道重复、白耗 token 且两个通道的截断/中和行为不一致。U7 三维度落点 = 资产统计+置顶摘要+overview 走首条 header，项目指令维持 system prompt 通道。此结论即为任务要求的「PcProjectModelContextSchema 契约是否随首条化演进」关联裁决的组成部分。
4. **契约演进结论（PcProjectModelContextSchema）**：**不演进**。`{block, docs, bytes}` 是 internal-only、runtime-only 的注入封套（`packages/shared/src/protocol/project-context.ts:354-359`），语义完全由 block 文本承载；首条/后续的差异是产出条件变化，不是载荷形状变化。不拆字段（无第二消费方，扩协议面无收益）、不持久化、不加版本标记。
5. **wrapper 文案**（SessionManager.ts:1465）：改为兼容两种形态的中性表述，不再断言「本项目共享文件区的内容摘录」总在场：
   `以下是本项目共享文件区的上下文：首轮含项目概况；其余为本轮 @ 引用文件的正文（检索于发送时）。@ 引用的文件若标注未成功读取，请如实说明而不是假设其内容。` 同时在 block 尾部（首条时）附一行工具指引：`更多信息用 project_context_search / project_context_read 按需检索。`
6. **失败语义**：首条 header 是 best-effort 一次——超时（4s 预算）或 admin 失败时本次不注入 header，**后续轮次不补注**（「一次性」语义不带回重试风暴）；agent 侧 `project_context_search/read` 按需工具是兜底（facade 每次 call 重授权，tool-facade.ts:74）。`PC_INJECT_MODEL_CONTEXT` 日志（SessionManager.ts:10108）保留，可从日志分辨 header 在场与否。

### 1.2 改动清单（候选③）

| 文件 | 改动 |
|---|---|
| `packages/server-core/src/project-context/service.ts` | `resolveSessionProjectContext`：+首条判定（getSession 读 messages）；headerPromise 条件化；首条 headerLines 组装升级（summary 2 行 + 置顶清单行 + 工具指引行）；新增 `buildProjectHeaderLines` 纯函数（可测） |
| `packages/server-core/src/sessions/SessionManager.ts` | `buildProjectModelContextReminder` wrapper 文案更新（:1465） |
| `packages/server-core/src/project-context/__tests__/send-injection.test.ts` | **新增**（send path 首个测试文件） |

### 1.3 测试（候选③）

新增 `send-injection.test.ts`（沿 `tool-facade.test.ts` 范式：`setProjectContextAdminForTests` + fence setters）：
1. 首条（messages 无 user）→ headerLines 含资产统计/置顶清单；admin.summary 与 listAssets 各被调 1 次；
2. 非首条（messages 已有 user）→ headerLines 空、admin.summary/listAssets **不被调**；@ 引用照旧解析（refs 落 ok）；
3. 非首条 + 无 refs → 返回 `undefined`（本轮零注入）；
4. 首条 + header 超时（`setSendResolveTimeoutMsForTests` 极小值 + 慢 admin）→ refs 仍逐条 persist、header 缺席；
5. 置顶超过 8 个 → 截断为前 8 + 计数行；
6. 非项目会话（无 projectId）→ undefined（回归门）。

## 2. 候选②：沉淀流（U1–U4）

### 2.1 总体链路

```
模型（回答收尾判断有结论性产物）
  └─ 调用 project_context_suggest({ entries:[{title, body, suggestedTags?}] })   ← 新 agent 工具，仅转交 UI，不落库
       └─ handler → facade.suggest()（仅做授权 pre-check：会话确实在授权项目内）→ 中文回执给模型
       └─ tool_result（JSON: suggestions[]）流回 renderer
            └─ TurnCard 识别 completed tool activity → 渲染 DistillSuggestionCard（U1 建议卡）
                 ├─ 批量勾选 + 单条展开预览（U3，勾选范式复用 BatchUploadView）
                 └─ 用户点「沉淀到项目」→ useDistillUpload 逐条串行：
                      storeAttachment(text) → prepareAssetUploadFile → pcUploadFile(source kind='session')
                        → pcSetConfirmed(true)   ← U2 默认 confirmed
                      失败继续下一条；逐条结果回填卡片
消息级手动入口（现状 ShareToProjectDialog）保留 = 双入口并存（U4），用语统一「沉淀到项目」
```

不做自动沉淀（Q5/§5 挂账）；工具调用即「模型建议」，用户确认才落库——建议与落库物理分离。

### 2.2 工具层（session-tools-core + server-core）

**Schema**（`packages/session-tools-core/src/project-context-types.ts`，叶子模块防环）：

```ts
export const ProjectContextSuggestArgsSchema = z.object({
  entries: z.array(z.object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(20_000),          // markdown 正文
    suggestedTags: z.array(z.string().min(1).max(64)).max(4).default([]),
  })).min(1).max(5),
}).strict()
```

facade 接口（:40-46）加：`suggest(input: { entriesCount: number }): Promise<{ ok: boolean; error?: string }>`——**工具面只传计数不传正文**，facade 是授权门不是传输层，正文留在 tool_result 里给 renderer，避免正文双写。

**handler**（`handlers/project-context.ts`，沿 :43 null-facade fail-closed 范式）：校验 schema → `facade.suggest` → 成功回执（中文，工具输出硬编码中文是既有约定）：
`已向用户展示 N 条沉淀建议。仅在用户确认后才会写入项目共享文件区；请勿为相同内容重复建议。`
授权失败：`当前会话不在项目共享范围内，无法发起沉淀建议`。

**tool-defs.ts**：
- `TOOL_DESCRIPTIONS.project_context_suggest`（模型可见的触发约定，spec §7 误建议率阈值靠它收敛）：仅当本轮产出了明确值得团队复用的结论（决策/SOP/终稿/规范）时，在回答收尾调用一次；每轮最多 5 条；不要在用户明确拒绝沉淀后再次建议；正文须整理为自包含 markdown（标题+要点），不是聊天记录原文。
- SESSION_TOOL_DEFS 条目：`safeMode: 'block'`（写通道）、非 readOnly；
- `:1304` 可见性过滤加 `project_context_suggest`（与 search/read 同一个 `allowProjectContext` 开关，**不新增独立 flag**——cacheKey（session-scoped-tools.ts:303）与 Pi drift 重注册（pi-agent.ts:760-765）因此零改动）。

**pi-agent.ts:1900** per-call 兜底拒绝名单加同名。

**server-core `tool-facade.ts`**：suggest 实现 = 复用 :82-88 同步 pre-check（`isProjectSessionAuthorizedNow`）+ :97-102 每次重读 session 绑定；通过 → `{ok:true}`；不通过 → `{ok:false, error:'not_authorized'}`（handler 折叠为中文回执）。**无 admin 调用**。

### 2.3 UI 层（packages/ui + electron renderer）

**新组件 `packages/ui/src/components/chat/DistillSuggestionCard.tsx`**（纯 UI，不碰 electronAPI）：
- props：`suggestions: DistillSuggestion[]`（title/body/suggestedTags）、`onConfirm(entries)` → `Promise<DistillEntryResult[]>`、`busy/results` 状态由组件内管理（onConfirm 期间禁用）；
- 交互（U3）：默认全选；逐条 checkbox（范式对齐 `useBatchUpload.ts:218-243` 的 guard + toggleAll，无反选）；单条可展开预览 markdown 正文（新交互，BatchUploadView 没有——U3 明文要求）；底部「沉淀到项目」主按钮 + 选中计数；逐条结果徽标（成功 ✓ / 失败 + 原因）；确认成功后卡片收敛为「已沉淀 N 条」态；
- markdown 预览用仓库既有渲染原语（实现时比对 ShareToProjectDialog/其他卡片的现成用法，无则 `<pre class="whitespace-pre-wrap">` 降级——v1 接受）。

**TurnCard.tsx 接线**（GenUI 先例复制）：
- 谓词 `isDistillSuggestToolName(name)`：`name === 'project_context_suggest' || name === 'mcp__session__project_context_suggest'`；
- turn 级 useMemo（:2903 区旁）：filter `type==='tool' && 谓词 && status==='completed'` → `parseDistillSuggestions(a.content)`（JSON 解析，失败跳过该条——畸形输出不出卡）；
- 渲染分支（:3193 区后）：有建议则出卡；
- 新 prop `onDistillConfirm?: (entries) => Promise<DistillEntryResult[]>`（沿 onBranch 复杂回调先例）；prop 缺省（WebUI/非项目会话）时卡片不出或按钮禁用；
- `formatToolInput`（:593-609 先例）对该工具抑制默认 JSON 摘要行；`getToolDisplayName`（`packages/shared/src/utils/toolNames.ts`）加友好名。

**electron 接线**：
- `ChatDisplay.tsx`：新 prop `onDistillConfirm` → TurnCard；
- `ChatPage.tsx`：实现 handler（仅 `isProjectSession` 时传，:391-397 判据复用）：`useDistillUpload(sessionId, projectScope).confirm(entries)`；
- **新 hook `apps/electron/src/renderer/components/project-context/useDistillUpload.ts`**：逐条串行（BatchUploadView 范式的简化版）：
  1. `window.electronAPI.storeAttachment(sessionId, {type:'text', path:'', name: `${title}.md`, mimeType:'text/markdown', text: body, size})` → `storedPath`（ShareToProjectDialog.tsx:276-289 同款）；
  2. `prepareAssetUploadFile(storedPath, maxUploadBytes)`（maxUploadBytes 先 `pcListCapabilities` 取一次缓存）；
  3. `pcUploadFile({mode:'create', tags: suggestedTags 过滤 preset 白名单, source:{kind:'session', note}, ...})`；
  4. `pcSetConfirmed({assetId, input:{confirmed:true}})`（U2 默认 confirmed）；
  5. 单条失败记录原因**继续下一条**（对齐 useBatchUpload.ts:249-296，而非 ShareDialog 的整批中止）；全部结束后回填逐条结果；
  6. source note 默认 `sessionTitle` 存在时取 `projectContext.share.sourceNote` 同款插值。

### 2.4 i18n（U4）

- `projectContext.share.*` 文案措辞「分享到项目」→「沉淀到项目」（`share.title/share.submit/share.entryTitle/toast.shared` 等涉「分享」语义的键，七语言同步）；
- 新增 `projectContext.distill.*` 段：卡片标题/说明/全选/展开预览 aria/确认按钮/逐条状态/失败原因/已沉淀回执/能力不可用降级文案；
- 三校验（sorted+parity+coverage）必须全绿。

### 2.5 测试（候选②）

| 层 | 文件 | 覆盖 |
|---|---|---|
| session-tools-core | `tool-defs-project-context.test.ts` 扩展 | suggest 注册（allowProjectContext 三态）、null facade 拒绝、schema 边界（>5 条/超长 body 拒绝）、成功回执文案含计数 |
| server-core | `__tests__/tool-facade.test.ts` 扩展 | suggest 授权 pre-check：项目会话 ok / 非项目 fail-closed |
| renderer | `__tests__/DistillSuggestionCard.isolated.ts` **新增** | 默认全选、勾选 guard、展开预览、确认回调载荷、逐条结果回填 |
| renderer | `__tests__/useDistillUpload.isolated.ts` **新增** | 串行顺序（storeAttachment→prepare→upload→setConfirmed）、单条失败继续、confirmed 必调、tags 白名单过滤 |

## 3. 实现顺序与提交切分

1. **候选③**（独立小改动）：service.ts + SessionManager 文案 + send-injection 测试 → commit；
2. **候选②工具层**：session-tools-core 三件 + pi-agent 兜底 + tool-facade + 两层测试 → commit；
3. **候选②UI 层 + i18n**：DistillSuggestionCard + TurnCard 接线 + ChatDisplay/ChatPage + useDistillUpload + 七语言 → commit。

每步跑定向 typecheck + 新增测试，全绿才 commit；不 push。

## 4. 边界与风险

- **误建议率**：由 TOOL_DESCRIPTIONS 约定收敛（spec §7 挂账项）；验收阈值属 e2e/验收阶段，本 Plan 不设自动阈值。
- **建议卡确认状态不持久化**：确认结果只存在组件内存态；刷新/重启后卡片回到未确认态，再次确认会产生重复资产。v1 边界（持久化需新增存储面，挂账不做）。
- **首条 header 失败不补注**：一次性语义，兜底是 search/read 工具（§1.1.6）。
- **markdown 预览**：若仓库无轻量现成渲染原语则 `<pre>` 降级，视觉打磨不属本期裁决范围。
- **收尾卡 ≠ 真正「会话结束」检测**：U1 的「会话收尾」落为「模型在回答收尾调用」（工具描述约定），不引入 turn-end 检测器。
- **候选①依赖**：U5/U6（解析反馈、上传格式预期两档说明）属候选①客户端跟进面，归 admin 线契约冻结后处理，本 Plan 不做。

## 5. 状态回执（2026-11-15 收尾）

### 5.1 交付内容（三批提交，全部在 `POO-215/feature/project-context` 分支，未 push）

**批次 1 · 候选③项目头首条注入收敛（14fb477a）**
- `packages/server-core/src/project-context/service.ts`
  - 新增 `PC_HEADER_PINNED_LIST_MAX = 8`；纯函数 `buildProjectHeaderLines`（统计行 + 置顶列表 + overview，置顶超 8 条标「未列全」）
  - 新增 `hasEarlierUserTurn`：messages 权威 role==='user' 或 preview 懒加载签名双信号
  - `resolveSessionProjectContext`：`getSession().catch(() => null)` + `isFirstProjectHeaderTurn`（**fail-closed：getSession 失败视为非首条，老会话永不重注**）；非首条 header 槽置空 `Promise.resolve([])`（refs 检索照旧）；首条时 summary（digest 失败降级统计行）+ `listAssets({ pinned:'true', limit: 9 })`
- `packages/server-core/src/sessions/SessionManager.ts`：`buildProjectModelContextReminder` wrapper 文案改为「首轮含项目概况，其余为本轮 @ 引用文件的正文；需要更多用 project_context_search/read」
- **不演进 PcProjectModelContextSchema**：{block,docs,bytes} 是 runtime 封套，首条化只是产出条件变化（§0 已裁决）
- 项目指令不进 PC header：POO-205 C7a `formatProjectContextSystemAppend` 每轮已注入 system prompt，避免双通道重复
- 新增 `send-injection.test.ts`（12 tests）：首条注入/后续零调 admin/无 refs undefined/preview 懒签名/getSession 失败 fail-closed/超时 refs 照旧/非项目回归门/置顶截断/空置顶/digest 降级/纯函数

**批次 2 · 候选②工具层（7f136a37）**
- `packages/session-tools-core/src/project-context-types.ts`：facade 加 `suggest()`；`ProjectContextSuggestArgsSchema`（entries 1–5、title≤120、body≤20000、tags≤4、strict）；`PC_DISTILL_RESULT_MARKER`
- `handlers/project-context.ts`：`handleProjectContextSuggest`（null facade fail-closed → schema → facade.suggest 门 → marker JSON envelope，编号 s1…sN + 等待用户处置回执）
- `tool-defs.ts`：TOOL_DESCRIPTIONS（严格触发约定收敛误建议率）+ DEFS 条目（safeMode:'block'、readOnly:false）+ :1304 可见性过滤
- `packages/shared/src/agent/pi-agent.ts` :1900 per-call 兜底名单加名（同一 allowProjectContext 开关，cacheKey/Pi drift 零改动）
- `tool-facade.ts`：suggest 只做重读绑定 + `isProjectSessionAuthorizedNow` 授权门，零 admin 调用（工具面只回执，正文走 tool_result envelope）
- 测试：`tool-defs-project-context.test.ts` 新 describe（注册三态/schema 边界/envelope 断言/gate/facade 异常，共 24 pass）；`tool-facade.test.ts` 追加 suggest gate（14 pass）

**批次 3 · 候选②UI 层 + i18n（本批）**
- `packages/ui/src/components/chat/DistillSuggestionCard.tsx`（新）：U1 建议卡——默认全选 + 逐条勾选（POO-210 批量范式）+ 逐条展开预览（U3）；确认前零落库（Q5 模型建议、用户处置）；settled 后 success 行锁死、failed 行保列 + 映射文案 + 单独重试；无 onConfirm 时 inert
- `TurnCard.tsx`：completed 的 suggest 调用经 `parseDistillSuggestions`（marker 校验，坏 envelope 渲染零卡片）成卡；`isDistillSuggestToolName` 兼容裸名 + `mcp__session__` 前缀；formatToolInput 抑制 JSON 噪音；`onDistillConfirm` prop 透传
- `packages/ui/src/components/chat/index.ts` + `packages/ui/src/index.ts`：导出卡组件与类型
- `apps/electron/src/renderer/components/project-context/useDistillUpload.ts`（新）：U2 落库链 `storeAttachment(text)` → `prepareAssetUploadFile` → `pcUploadFile(source.kind='session')` → `pcSetConfirmed(true)`——**零新 RPC 零 admin 改动**；串行队列单条失败继续；tags 收敛 preset 白名单 + 排除受控 `confirmed` id；标题过滤文件系统非法字符 + `.md` 后缀；scope/上限缺失 fail-closed 逐条报 `libraryNotReady`
- `ChatPage.tsx`：`useDistillUpload({ sessionId, scope: projectScope, sessionTitle: displayTitle })`；两处 ChatDisplay 调用点非项目会话传 undefined（卡片 inert）
- `ChatDisplay.tsx`：`onDistillConfirm` prop 声明 + 透传 TurnCard
- i18n 七语言：`projectContext.distill.*` 15 键/语言 + `turnCard.projectContextSuggest`；U4 用语统一——`share.*` 与 `toast.shared` 全线「共享/分享」→「沉淀」（en distill / de destillieren / es destilar / hu kivonás / ja 整理・保存 / pl zachowaj / zh-Hans 沉淀）
- 测试：`DistillSuggestionCard.isolated.tsx`（7 tests）、`useDistillUpload.isolated.ts`（5 tests，HappyDOM 加守卫避免同进程撞全局注册）

### 5.2 检查与结果计数

| 检查 | 结果 |
|---|---|
| `bun run typecheck:all`（9 包） | 0 错 |
| i18n sorted / parity / coverage | 全绿；parity 3359 键 × 7 语言 |
| 五个新改测试文件（send-injection + tool-facade + tool-defs + 卡片 + hook） | 62 pass / 0 fail |
| `packages/server-core/src/project-context/__tests__/` + `packages/session-tools-core/` 全套 | 372 pass / 0 fail |
| `packages/ui/src/components/chat/` 全套 | 259 pass / 0 fail |
| ChatDisplay 两个未受影响套件（follow-ups + jump-to-latest） | 26 pass / 0 fail |
| `packages/server-core/src/sessions/` 全套 | 475 pass / **29 fail（预存红）** |

预存红甄别：sessions 29 fail 全部集中在 assistant account/complete-scope（R32-2/R30-B/R33-1/R34-1/R35-1/R36-1）与 request_user_input 等 suite，与本次改动面无关；与 main（f7dbbda7）基线 30 fail 对照不增。`ChatDisplay.source-url-routing.isolated.ts` 与 `jump-to-latest` 同进程混跑 8 fail 为跨文件 mock 污染预存行为（HEAD 版两文件跑同样组合同样 8 fail，单独跑各自全绿）——与本改动无关。lint：electron 6 error / ui 3 error 均预存（onboarding/ProductSpaceSkillsDialog/block-markers/TurnCard:1536 等，本改动 diff 零引入；已用 `git diff | grep boxShadow = 0` 复核）。

### 5.3 剩余风险与边界（§4 全部仍然有效，补充两条）

- **建议卡确认状态不持久化**（§4）：刷新后回到未确认态，二次确认会产生重复资产——v1 挂账。
- **候选①界面未接**：`project_context_suggest` 工具已注册可用，但 U5/U6（解析反馈、上传格式预期）归 admin 线，本线未动。
- **e2e 链路未真跑**：模型侧建议率、卡片在真实会话流中的渲染（含 compact 后 envelope 存活性）需 e2e 验收阶段覆盖；本线以组件/hook isolated + 工具层单测为界。
- **spec.md / RESOURCES.md 未提交**：按派发约束留在任务目录，等用户授权。
