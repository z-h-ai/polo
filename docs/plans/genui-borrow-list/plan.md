# Plan: GenUI 对比评审可借鉴清单 — 逐项实施方案（P0-1 ~ P2-3）

Status: accepted（第 1 波执行锁定；第 2/3 波保持 draft） · Date: 2026-10-18
Reviewed by: 工程师评审（本会话，对照 genui/impl@4b07b30c 只读核验） · Accepted by: 用户指令 2026-10-18「完善计划，然后开始迭代」（含 P0-2/P1-3 两个 ⚠️ 会签项的开工授权；P1-3 属第 2 波，本轮不动）

## Wave-1 执行锁定（2026-10-18）

- **范围**：P2-2a（schema-size 实测脚本）、P2-3（错误码 taxonomy）、P0-1（客户端筛选 + 边界契约）、P0-2（骨架流式预览）。第 2/3 波不在本轮。
- **工作树**：`../genui-wave1`，分支 `iter/genui-wave1`，基线 `genui/impl@825742ab`（比调研基线 4b07b30c 多一个 iter/chart 提交：chart 组件+懒加载 recharts 已落地，本轮四项目标文件未被触及；**P1-2 已被部分抢先实现**，第 3 波剩余工作改为"对照已落地实现查漏"，执行前需重估）。
- **流程**：normal-coding-task-flow（实现 → review 循环 → 视觉验收 → E2E → 清理 → 汇报）。
- **模型分工**：coder GLM-5.3-Flash · reviewer GLM-5.3 · 视觉验收 GLM-5.3-Flash。
- **P0-2 安全锚（不可协商）**：先写"协议页收不到 tool_input_delta"的失败测试再实现；事件仅对 render_ui 发射、250ms 节流、累计 8KB 即停；骨架只认完整闭合的 type/title 键值对、不含业务数据。
- **验收**：`bun test`（genui 相关套件）+ `bun run typecheck:all` + `bun run lint` 全绿；本文件随实现偏离同步更新。

方案依据：`docs/reports/2026-10-18-genui-vs-openui.html`（OpenUI vs genui/impl 对比评审，含 §5 可借鉴清单）
变更分级：**混合** — P0-1/P2-2/P2-3 为例行工作；P0-2/P1-3 涉及协议事件与 webview 数据推送（安全面），需技术负责人会签；P1-2 涉及 schema 版本首次演进。

## Baseline and upstream anchors

| 锚点 | 修订/基线 | 确认依据 | 执行依赖或集成条件 |
|---|---|---|---|
| 当前代码 | `genui/impl@4b07b30c`（基线 `genui/baseline` = dev@e7c0e6bd） | 2026-10-18 两路只读调研（报告 §8 来源清单）+ 本计划撰写时补充核验（dto.ts:309-310、unified-network-interceptor.ts:520-600、MarkdownDatatableBlock.tsx:432-498） | — |
| 对比评审报告 | docs/reports/2026-10-18-genui-vs-openui.html | 本仓库文件（本次会话产出） | 无 |

补充核验结论（影响下述方案的关键事实）：
1. SessionEvent 联合中工具相关事件仅 `tool_start`（携带**完整** `toolInput`）与 `tool_result`（`packages/shared/src/protocol/dto.ts:309-310`）——**没有部分输入事件**。
2. `input_json_delta` 在 SSE 层存在且流向 SDK 消费者（`packages/shared/src/unified-network-interceptor.ts:533-546`：拦截器只对带 `_intent` 元数据的 tracked block 缓冲、`content_block_stop` 时重发整块；非 tracked 的增量原样透传）——Claude 路径的增量**原料是现成的**，缺的是到 renderer 的协议事件。
3. `MarkdownDatatableBlock` 已有客户端 `sortKey/sortDir/groupKey`（`MarkdownDatatableBlock.tsx:432-498`）——排序+分组已在客户端闭环，P0-1 是扩展而非新建。

---

## P0-1 · 纯视图交互客户端闭环（generate vs execute 分离）

**目标**：把"视图态"操作（筛选、下钻、列选择）留在客户端完成；语义动作保持走聊天回路。形成明确的视图态/语义边界并写进模型可见的契约。

**优化点（量化）**：
- 查看类交互延迟：一轮会话往返（数秒~数十秒）→ 毫秒级本地响应；
- 模型费用：查看类点击 × 每轮全量输入 token 的乘积项归零；
- 边界制度化后，模型不再为"换个筛选"生成 send-message 按钮。

### Files that change
| 状态 | 文件 | 动作 | 为什么 | 执行前核对 |
|---|---|---|---|---|
| existing | `packages/ui/src/components/markdown/MarkdownDatatableBlock.tsx` | 修改 | 在既有 sortKey/groupKey 之上加列筛选 chips（文本列 = 值去重多选；数值列 = 区间），全部本地 React state | sortKey/groupKey 实现位于 :432-498 |
| existing | `packages/ui/src/components/chat/GenUICard.tsx` | 修改 | DataTableView 透传筛选 props；无 schema 变化 | DataTableView :560 |
| existing | `packages/session-tools-core/src/tool-defs.ts` | 修改 | render_ui 描述追加一句边界契约："view-state operations (filter/sort/group) are client-side; reserve action-buttons for semantic follow-ups" | BASE_DESCRIPTIONS.render_ui :741-764 |
| existing | `packages/shared/src/prompts/system.ts` | 修改 | Interactive UI Cards 节同步该边界（并顺手修 §已知的 "no host bridge" 口径漂移） | :1097-1119 |
| new-by-this-task | `packages/ui/src/components/chat/__tests__/genui-datatable-viewstate.test.ts` | 新增 | 筛选/分组交互单测（纯函数部分） | 父目录与既有测试命名一致 |

### Order of work
1. 先写边界契约文本（工具描述 + system 节）——一行字定义"什么算视图态"，避免实现跑偏；
2. MarkdownDatatableBlock 列筛选（文本列 chips + 数值列区间）；
3. GenUICard 透传 + 测试。

### Risks and mitigations
| 风险 | 影响 | 缓解 | 验证 |
|---|---|---|---|
| 视图态与持久化卡片回放混淆 | 回放语义漂移 | 筛选状态一律 ephemeral React state，**不进 schema、不持久化**（与既有 confirm-flow 门链同一原则） | replay 测试不变绿 |
| 筛选后行数与导出/行操作不一致 | 行为分裂 | rowAction/detailTemplate 基于筛选后的可见行（用户所见即所得）；导出按钮如引入则走全量并注明 | 单测覆盖筛选×行操作组合 |

### Proof
- 单测：`genui-datatable-viewstate.test.ts`（筛选纯函数）+ 既有 `genui-datatable-rows.test.ts` 全绿；
- `bun run typecheck:all`、`bun run lint`。

### Explicitly out of scope
- 不做跨组件联动（chart 联动等 P1-2 之后再说）；不改 action 语义；不加新 schema 字段。

### Alternatives rejected
- **全面 $var 响应式运行时（OpenUI 式）** — 需要引入表达式求值层，爆炸半径与收益不匹配；我们的组件是受控 JSON 不是 DSL，本地 state 直接够用。拒绝。

---

## P0-2 · render_ui 骨架流式预览 ⚠️需技术负责人会签（协议面）

**目标**：模型生成 render_ui payload 期间，先显示"组件类型 + 标题"级骨架卡；工具调用完成后过 Zod 校验替换正式内容。**骨架不含业务数据**，保住"用户永不看到无效 UI"底线。

**优化点（量化）**：
- 首卡可见时间：从「工具调用 completed」提前到「type+title 键值生成完毕」，按 60 tok/s 与 1-4KB payload 估计提前 1-4s；
- 骨架解析只认完整键值对，失败静默——不新增任何用户可见错误面。

### 方案（含关键架构决策）
1. **新协议事件 `tool_input_delta`**：`{ type:'tool_input_delta', sessionId, toolUseId, toolName, delta: string(单块 ≤2KB), seq: number }`。
   - **只对 `render_ui` 发射**（emission 点按 toolName 过滤）——不给所有工具开闸，事件量与安全面最小化；
   - 发射点节流：每 toolUseId 每 250ms 最多 flush 一次，累计 ≥8KB 即停（后续靠 completed 全量）；
   - **不加入 tab 协议页的 handleSessionEvent 白名单**（与 POO-103 把 `ui_state` 排除在 SessionEvent 联合外的同一纪律——本事件是 renderer 内部通道，不外送协议页）。
2. **Claude 路径发射**：`claude-agent.ts` 消费 SDK 流的 tool input 增量（核验结论 2：原料现成）。
3. **Pi 路径降级**：子进程代理若无增量事件则维持现状（completed 后渲染），不阻塞本项——graceful degradation。
4. **Renderer 骨架**：TurnCard 按 toolUseId 累积 delta → 纯函数扫描器提取**完整的** `"type":"data-table"` / `"title":"…"` 键值对 → 骨架卡（图标+类型+标题+spinner）。completed 到达后走既有 `mergeGenUiComponents` 路径替换。

### Files that change
| 状态 | 文件 | 动作 | 为什么 | 执行前核对 |
|---|---|---|---|---|
| existing | `packages/shared/src/protocol/dto.ts` | 修改 | 新增 `tool_input_delta` 事件类型 + 常量（上限/节流参数） | SessionEvent 联合位置 :309-310 |
| existing | `packages/shared/src/agent/claude-agent.ts` | 修改 | SDK 流 → 事件发射（toolName=render_ui 过滤 + 节流） | 工具流消费点 |
| existing | `packages/server-core/src/sessions/SessionManager.ts` | 修改 | 事件扇出（保持 tab 协议页隔离） | 事件扇出白名单处 |
| existing | `packages/ui/src/components/chat/TurnCard.tsx` | 修改 | delta 累积 + 骨架渲染 + completed 替换 | activity 解析点 :2911-2920 |
| new-by-this-task | `packages/ui/src/components/chat/genuiSkeleton.ts` | 新增 | 容错扫描纯函数（只认完整键值对，无 autoClose） | 引用点 TurnCard |
| new-by-this-task | `packages/ui/src/components/chat/__tests__/genui-skeleton.test.ts` | 新增 | 截断 JSON 各形态单测 | — |

### Risks and mitigations
| 风险 | 影响 | 缓解 | 验证 |
|---|---|---|---|
| 事件量放大（每 250ms×每会话） | 渲染进程压力 | 仅 render_ui、累计 8KB 即停、seq 乱序丢弃 | dto 常量 + 发射单测 |
| 部分输入泄露给协议页/被持久化 | 安全面 | 不进 SessionEvent 联合外送白名单；ephemeral，不落盘（对齐 ui_state 纪律） | 事件过滤测试（参照 genui-ui-event.test 的写法） |
| 骨架与最终不一致（模型改了 type） | 观感 | completed 全量替换本就支持（id 合并语义）；骨架明示"building" | 单测：delta 与 completed 冲突用例 |

### Proof
- `genui-skeleton.test.ts`（截断/转义/嵌套字符串里出现 `"type":` 的反例）；
- 发射侧：claude-agent 流测试（fake SDK 流注入 input_json_delta）；
- 事件隔离：SessionManager 扇出测试断言协议页收不到 `tool_input_delta`。

### Explicitly out of scope
- 不做"边流边渲染真组件/真数据"（OpenUI 式）；不动 generate_app（HTML 增量流式无意义且危险）；Pi 路径增量发射。

### Alternatives rejected
- **renderer 轮询 / activity pending 态直接渲染 partial toolInput** — activity 管线当前无 partial 概念，改 activity DTO 比加一个窄事件面更大。拒绝。
- **逐 chunk 全量重解析（OpenUI 式）** — 对 Electron 渲染进程不友好且我们只需骨架级信息。拒绝。

---

## P1-1 · 工具 schema 瘦身（先实测再动手）

**目标**：render_ui 工具定义的模型可见 token 从估算 4-6K 降到 ≤2K，方法是对齐 OpenUI 的"签名式"效率：schema 只保结构，语义进目录一行式描述。

**优化点（量化）**：每会话每轮输入省 est. 2-4K token（全量会话全量轮次累计）；6 组件的描述成本从"比对方 40+ 组件还贵"回到同量级。

### Order of work（第一步是尺子）
1. **实测脚本**（兼作 P2-2a）：`scripts/genui-bench/schema-size.ts` — 对 `RenderUiSchema` 分别走 Claude `.shape` 序列化与 `getToolDefsAsJsonSchema()` 输出，量字节与 token（tiktoken 可用则用，否则 chars/4 标注口径），并把基线数字写进本 Plan 修订；
2. 描述去重：schema 内 `.describe()` 与 system.ts 节、目录 one-liner 三处重复的语义只留一处（结构必需的留 schema，用法性的进目录）；
3. 约束精简：非功能性 min/max 字符约束改为目录描述一句话（Claude 原生路径以 Zod 校验兜底，模型侧少付 token）；
4. 复测 + 记录前后对比。

### Files that change
| 状态 | 文件 | 动作 | 为什么 | 执行前核对 |
|---|---|---|---|---|
| existing | `packages/session-tools-core/src/tool-defs.ts` | 修改 | describe() 精简、约束下沉 | :155-478 |
| existing | `packages/session-tools-core/src/genui-catalog.ts` | 修改 | 目录 one-liner 承接下沉语义（160 字符 sanitize 信任边界不变） | :47-85 |
| existing | `packages/shared/src/prompts/system.ts` | 修改 | 三处重复去一 | :1097-1119 |
| new-by-this-task | `scripts/genui-bench/schema-size.ts` | 新增 | 实测尺子（P2-2a） | scripts/ 目录约定 |

### Risks and mitigations
| 风险 | 影响 | 缓解 | 验证 |
|---|---|---|---|
| 精简后模型生成错误率上升 | 重试轮次增加 | 分批精简（每批复测）；错误率用 render-ui handler 的重试计数观测（P2-3 落地后有错误码可量） | 基准前后对比 + 会话实测 |
| 两后端序列化差异 | 一处瘦身另一处不瘦 | 脚本同时量两条路径 | 脚本输出双列 |

### Proof
- `schema-size.ts` 输出前后对比表贴回本 Plan；既有全部 genui schema 单测（tool-defs-genui-*.test.ts）不变绿即回滚。

### Explicitly out of scope
- 不改输出格式（DSL 化明确拒绝，见报告 §6）；不动 generate_app schema。

---

## P1-2 · chart 组件重启（ADR 0021 条件 a 已满足）

**目标**：重开 ADR 0021，经 render_ui registry 缝新增 `chart` 卡类型（bar/line 起步），数据文件化（复用 src 语义与 containment 校验）。**这是 schema 版本的首次真实演进（schemaVersion 1→2），顺带激活 POO-104 预留的快照回放机制。**

**优化点（量化）**：chart 场景从"整页 512KB HTML"回到"≤4KB payload + 数据文件"——输出 token 与首卡延迟双降；中间层表达力补齐。

### Order of work
1. **决策先行**：新 ADR（supersede 0021 的 P1 决定，引用其预设缝"render_ui registry 新卡类型"与重启条件 a：POO-103 已落地 + schemaVersion=1 已冻结）；渲染方案限定 ADR 0021 自己划的范围——**无 CDN、无运行时加载、无共享包重依赖**：自研极简 SVG（bar/line，~1-2KB 逻辑，无轴库）；
2. schema：`chart` 加入 `GENUI_COMPONENT_SCHEMAS`（字段：series 文件 src + 每系列 {label, xKey/yKey} + type: bar|line + 可选 yFormat）；`GENUI_RENDER_UI_SCHEMA_VERSION` 1→2；注册 v1 快照（首个真实消费者：旧 v1 卡片按 v1 回放校验）；
3. 目录 one-liner + 交互性标注（false）；
4. 渲染：`ChartCardView` 注册进 `GENUI_COMPONENT_REGISTRY`；
5. P1-1 的 schema 尺子复测（chart 的加入量）。

### Files that change
| 状态 | 文件 | 动作 | 为什么 | 执行前核对 |
|---|---|---|---|---|
| new-by-this-task | `docs/adr/00NN-add-chart-component-for-genui.md` | 新增 | supersede 0021 P1 决定 | docs/adr/ 编号顺延 |
| existing | `packages/session-tools-core/src/tool-defs.ts` | 修改 | chart 组件 schema | :155-478 |
| existing | `packages/session-tools-core/src/genui-schema.ts` | 修改 | SCHEMAS map + 版本 1→2 + v1 快照注册 | :31-135 |
| existing | `packages/session-tools-core/src/genui-catalog.ts` | 修改 | 描述符 | :47 |
| existing | `packages/ui/src/components/chat/GenUICard.tsx` | 修改 | ChartCardView + registry | :1043 |
| existing | `packages/session-tools-core/src/handlers/render-ui.ts` | 修改 | src containment 校验复用（data-table 同一路径） | :97-131 |
| new-by-this-task | `packages/session-tools-core/src/tool-defs-genui-chart.test.ts` 等 | 新增 | schema/快照回放/渲染单测 | 既有 -genui-*.test.ts 命名 |

### Risks and mitigations
| 风险 | 影响 | 缓解 | 验证 |
|---|---|---|---|
| schemaVersion 演进破坏持久化卡片 | 旧会话回放 | v1 快照按生成时版本校验（POO-104 机制首次实战，fail-closed 只读视图兜底） | 快照回放单测（v1 payload 不含 chart） |
| 视觉质量（自研 SVG 无轴库） | 观感 | bar/line 两型起步，网格线+数值标签最小集；视觉验收走真实截图 | visual 检查（见验收表） |

### Proof
- 快照回放单测；`schema-size.ts` 复测；GenUICard 渲染单测 + 截图。

### Explicitly out of scope
- pie/scatter/双轴、图例联动（P0-1 扩展项）、Mermaid xychart 下线决策（保留并存观察）。

---

## P1-3 · 画布应用增量编辑（数据/结构分离） ⚠️需技术负责人会签（webview 数据推送面）

**目标**：把画布应用的"可变状态"从 HTML 里分离到会话 data/ JSON；迭代只更新数据文件并推送给已挂载卡片，结构变化才走 `updateOf` 全量重写。

**优化点（量化）**：数据类迭代从 512KB HTML 全量重发（模型逐 token 生成，数十秒+高成本）→ 一个小 JSON 文件 + 一次 ui_state 推送（秒级）；version 噪声减少。

### 方案（复用既有围栏，零新信任根）
1. **声明**：bundle 以 `<meta name="polo-app-data" content="data/state.json">` 声明数据依赖——capability 提取同款模式（attach 时 Main 亲自读 meta，`extractPoloBridgeCapabilities` 旁扩展）；
2. **初始注入**：did-attach 时 host 读取声明文件（realpath 限制在会话 data/、≤1MB，全部既有常量）经 `postUiStateToCard` 推给该卡——解决 file: 下 fetch 不可用的死结；
3. **新 session 工具 `update_app_data`**：`{appId, dataSrc, }` 校验 appId 存在 + containment → 原子写文件 → 对已挂载卡推 ui_state；未挂载则仅落盘（下次 attach 注入）。工具注册条件同 generate_app（canvas 资格矩阵复用）；
4. **模型侧契约**：generate_app 工具描述追加引导——"keep mutable state in a data/ JSON declared via polo-app-data; iterate data with update_app_data, reserve updateOf for structural changes"。

### Files that change
| 状态 | 文件 | 动作 | 为什么 | 执行前核对 |
|---|---|---|---|---|
| existing | `packages/session-tools-core/src/tool-defs.ts` | 修改 | 新工具定义 + generate_app 描述更新 | :497-511, :765-786 |
| new-by-this-task | `packages/session-tools-core/src/handlers/update-app-data.ts` | 新增 | 工具 handler（containment + 原子写 + 通知） | handlers/index.ts 注册模式 |
| existing | `apps/electron/src/main/ui-card-registry.ts` | 修改 | attach 时读 polo-app-data meta + 初始注入 | capability 提取 :233 |
| existing | `apps/electron/src/main/handlers/genui.ts` | 修改 | 通知桥接（复用 postUiStateToCard 通道） | — |
| existing | `packages/shared/src/protocol/dto.ts` | 修改 | 常量（meta 名、大小上限复用 payloadSrc 1MB） | :813-866 |
| new-by-this-task | `packages/session-tools-core/src/handlers/__tests__/update-app-data.test.ts` 等 | 新增 | handler/注入/围栏单测 | — |

### Risks and mitigations
| 风险 | 影响 | 缓解 | 验证 |
|---|---|---|---|
| meta 声明文件路径逃逸 | 安全面 | realpath 限定会话 data/（与 payloadSrc 同一校验函数）；大小 ≤1MB；fail-closed | 围栏单测（仿 webview-genui-partition.isolated.ts） |
| 数据推送被滥用为持久通道 | 语义混淆 | ui_state 本就 ephemeral（永不持久化）；声明文件数 ≤3/卡 | 常量 + 单测 |
| 模型仍习惯全量重写 | 采用率 | 工具描述明确引导 + system.ts 画布节同步（修口径漂移） | 会话实测观察采用率 |

### Proof
- 围栏单测（路径逃逸/符号链接/超限）；attach 注入单测；端到端：update_app_data → 挂载卡收到新 ui_state。

### Explicitly out of scope
- 文件变更自动刷新/轮询（= P2-1，本项只做模型驱动的显式更新）；多文件数据集（≤3 个声明文件封顶）。

#### P1-3 Wave-2 执行记录（2026-10-19，commit 8c6fef51 + 92bde273）

**做了什么**（方案四步全部落地）：
1. **声明**：shared dto.ts 新增 `GENUI_APP_DATA_META_NAME`（'polo-app-data'）、`GENUI_APP_DATA_MAX_FILES_PER_CARD`=3、`GENUI_APP_DATA_MAX_FILE_BYTES`=1MB（复用 payloadSrc 常量值）、`parseGenUiAppDataDeclaration()`（空白/逗号分词、去重、超 3 封顶、含 NUL 整体作废）。Main 侧在 ui-card-registry.ts 的 `extractPoloBridgeCapabilities` 旁新增 `extractPoloAppDataDeclarations(src)` / `extractPoloAppDataFromDocument(doc)`（与 capabilities 共用同一 `readAttachedDocument` 读文档脚手架——data: URL 与 ≤2MB file: 读入）。
2. **初始注入**：新模块 `apps/electron/src/main/genui-app-data.ts`；did-attach 时 webview-security 把（sessionId, guestId, hostId, validated src）交给观察者，读取声明 → `readGenUiAppDataFile`（payloadSrc 同款围栏：realpath 后必须仍在会话 data/ 内、≤1MB stat+读后双检、JSON 解析）→ 经 `DeepLinkCallbackBridge.postUiStateToCard` 推给该卡。
3. **update_app_data 工具**：`UpdateAppDataSchema`（tool-defs.ts）+ 新 handler `handlers/update-app-data.ts`（appId 存在性 + generate_app 同款 id pattern；dataSrc 用 `isPathWithinDirectoryForCreation` 符号链接感知 containment；1MB 序列化上限；temp+rename 原子写；写后 containment 复检）+ handlers/index.ts 注册模式导出；注册条件同 generate_app（`allowGenerateApp` 一个门控两个工具，getSessionToolDefs/getToolDefsAsJsonSchema/Pi 调用时守卫三处同步）。
4. **模型侧契约**：generate_app 描述追加 polo-app-data 声明 + "iterate data with update_app_data; reserve updateOf for structural changes"；新工具描述完整；system.ts Canvas Apps 节同步改写（92bde273，修"全量重写"口径漂移——plan 风险表缓解项）。

**与计划的偏离**（均已在代码注释注明）：
- **参数 `{appId, dataSrc}` → `{appId, dataSrc, data}`**：dataSrc 按本仓库语义（payloadSrc/render_ui src）只能是"路径"；"原子写文件"必须携带内容，plan 方案里的 `{appId, dataSrc, }` 悬尾逗号亦提示第三参数在斟酌中。`data` 为任意 JSON 值，序列化 ≤1MB。
- **postUiStateToCard 需要已注册 callbackId**：attach 时卡片尚未发过 ui-event，host 侧为每卡注册专用 state callback（`polo-data-<hex>`，符合 POLOAI_CALLBACK_ID_PATTERN）并 bind 到该 guest+session，之后每次推送前重申注册（桥 TTL 30 分钟会清理空闲 entry，幂等重注册兜底）——桥的 ownership 校验保持原样，只消费一个 per-page 槽位（≤8）。
- **注入时机 = attach 推送 + dom-ready 补推一次**：attach 时的 executeJavaScript 投递可能早于页面 message listener 注册；dom-ready 时同一份已校验内容再推一次，对应用幂等。
- **cardId/appId 在 attach 时的来源**：renderer 在 file: src 上追加 `?poloCard=`（GenUiAppCard 既有行为），Main 从已校验 src 的 query + `genui-apps/<appId>/index.html` 路径自行推导，绝不信任 RPC 声明。
- **推送链路**：handler 的 `ctx.notifyCanvasAppDataUpdated`（session-tools-core 新可选 seam）→ callback registry 懒 getter（session-self-management-bindings，Claude/Pi 两路径共用）→ SessionManager `setGenUiAppDataPushHook` 反转（与 setGenUiSessionTeardownHook 同款）→ genui-app-data `pushGenUiAppDataUpdate`（推送前同函数再过围栏）。CLI/无 canvas 宿主 = 仅落盘。
- **ui-card-registry 小重构**：`extractPoloBridgeCapabilities` 的文档读取抽为私有 `readAttachedDocument`，capabilities 行为不变（其 15 项既有单测不变绿）。

**数字证据**：围栏/注入/e2e 单测 36 pass / 0 fail（`genui-app-data.isolated.ts`：`..` 逃逸、深层 `..`、绝对路径逃逸、符号链接文件/中间目录、>1MB、坏 JSON、NUL、≤3 声明封顶、注入、跨卡/跨会话隔离、推送时逃逸拒绝、handler→ctx→push 全链 e2e）；handler 单测 20 pass / 0 fail（含 dataSrc 逃逸/符号链接 8 例）；shared 常量+解析 9 pass / 0 fail（含与 session-tools-core 1MB 上限的 parity guard）；工具门控新增 6 断言全绿（filtering 22 pass / 0 fail）；session-tools-core 全包 275 pass / 0 fail；typecheck:all exit 0。

### Alternatives rejected
- **HTML patch/diff 更新** — 给生成的 HTML 打结构 patch 复杂度高且易碎；数据/结构分离以 10% 的机制拿到 90% 的迭代收益。拒绝。
- **webview 内 fetch data/ 文件** — file: origin 下 Chromium fetch 不可靠且绕过 Main 校验。拒绝。

---

## P2-1 · 画布数据自动刷新（Query/轮询等价物）

**目标**：P1-3 的跟进项——声明数据文件变化时自动推送给已挂载卡片（等价 OpenUI `Query(refreshSec)`，但数据源限定会话 data/ 围栏内）。

**方案要点**：SessionManager 侧对声明文件注册 fs watch（会话删除/卡卸载即注销）；变更事件走既有 `postUiStateToCard` 点对点通道；防抖 ≥1s。**依赖 P1-3 落地，本项单独排期。**
**优化点**：画布应用从静态快照变为会话内活体；不新增任何越出 data/ 围栏的数据通路。
**Out of scope**：跨会话/网络数据源（明确不做——那会破坏围栏模型）。

#### P2-1 Wave-2 执行记录（2026-10-19，commit f91e0903）

**做了什么**（依赖 P1-3 通道，同一模块内实现）：
- **fs watch**：`node:fs` 的 `fs.watch`（仓库无 chokidar 依赖）挂在**声明文件的父目录**上而非文件本身——generate_app/update_app_data 均以 rename 原子换文件，文件级 watch 会脱钩旧 inode；每个目录一个 watcher，多卡共享按引用计数。只 watch realpath 后仍位于会话 data/ 围栏内的目录。
- **防抖**：trailing debounce，静默期 = `GENUI_APP_DATA_WATCH_DEBOUNCE_MS`（shared 常量 1000ms，测试注入 80ms）；抖动窗口内多次写折叠为一次推送；部分平台 filename 为 null 时退化为该目录全部被 watch 的 basename（推送路径本就重新校验）。
- **点对点路由**：变更经 `pushGenUiAppDataToDeclared(sessionId, path)`——先按声明匹配（realpath 对 realpath），只推给**声明了该文件**的卡，永不广播；读+校验+推与任务 1 注入共用同一 `readGenUiAppDataFile`/`pushDeclaration` 函数。
- **注销（泄漏=缺陷）**：卡片卸载（UNREGISTER_UI_CARD → `releaseGenUiAppDataChannel`）、guest 销毁（webview-security destroyed hook → `releaseGenUiAppDataForGuest`）、会话删除（既有 teardown hook 扩展 → `clearGenUiAppDataForSession`）三条路径全部释放该卡/会话的 watch 引用，最后一个引用释放即 `watcher.close()` 并清掉未决防抖 timer。watcher `persistent:false` + `unref`：应用关闭随进程消亡且不阻碍退出（另有 `disposeAllGenUiAppDataWatchers` 测试/关停 seam）。

**数字证据**：watch 注册/共享引用计数/变更推送/非声明文件零推送/防抖折叠/跨会话路由/guest 释放后停推且注销/会话删除注销——8 项单测全绿（含在 genui-app-data.isolated.ts 的 36 pass / 0 fail 内，真实 fs.watch + 80ms 注入防抖）；typecheck:all exit 0。

---

## P2-2 · 自有 token/延迟/有效率基准

**目标**：给 P1-1/P1-2 及未来一切格式实验提供尺子（对齐 OpenUI 两层方法论）。

**方案要点**：
- **a（先行，并入 P1-1 步骤 1）**：`scripts/genui-bench/schema-size.ts` — 工具定义双后端序列化 token 计数，可入 CI 做防回归阈值（超基线 +20% 报警）；
- **b（后置）**：payload 格式投影基准——同一组件集的 payload token 计数（当前 JSON vs 未来任何候选格式）；
- **c（stretch）**：真实生成基准（N 条用户措辞 prompt × 模型 × 4 次，量结构有效率/均值 token/首卡延迟）——需要模型预算与 fixture 会话，单独立项。
**优化点**：决策从拍脑袋变为有基线；CI 防回归守住瘦身成果。

---

## P2-3 · 结构化错误码 taxonomy

**目标**：render_ui 校验失败的 Zod issues → 稳定错误码（`unknown-component` / `missing-required` / `type-mismatch` / `payload-too-large` / `duplicate-id` …）→ 每码一句针对性修复提示，提升"fix and retry once"的一次成功率。

**方案要点**：`render-ui.ts` 的 issues 格式化处加一层映射（纯函数）；错误码同时进工具结果文本（模型可读）与本地计数（P2-2c 的错误率观测数据源）。**小改动，任意时点可做**；与 P1-1 的错误率观测天然配套。
**Files**：`packages/session-tools-core/src/handlers/render-ui.ts`（existing）+ `__tests__/render-ui-errorcodes.test.ts`（new）。

---

## 跨项执行顺序与依赖

```text
P2-2a(schema-size 实测) ──► P1-1(schema 瘦身) ──► P1-2(chart, 版本演进+复测)
P0-1(客户端视图闭环)   ─┐
P0-2(骨架流式)         ─┼── 三者缝隙互不重叠，可并行
P2-3(错误码)           ─┘
P1-3(画布增量编辑) ──► P2-1(自动刷新)
```

## 验收准备总表（任务 × 验收时机 × 检查类型 × 场景）

| 任务 | 验收时机 | 检查类型 | 场景 | 状态 |
|---|---|---|---|---|
| P2-2a | 实现后 | api/脚本 | 双后端 schema token 计数输出且入 CI 阈值 | scenario_defined |
| P1-1 | 实现后 | api + 会话实测 | schema token 前后对比；genui schema 单测全绿；错误率不升 | scenario_defined |
| P0-1 | 实现后 | browser | 数据表筛选/分组/行操作组合操作（真实会话卡片） | scenario_defined |
| P0-2 | 实现后 | api + browser | 假 SDK 流注入 → 骨架出现 → completed 替换；协议页收不到 delta 事件；真实会话观察首卡提前 | scenario_defined |
| P1-2 | 实现后 | api + visual | v1 卡片回放不破；chart 渲染截图对照（bar/line 最小集） | scenario_defined |
| P1-3 | 实现后 | api + browser | meta 声明→attach 注入；update_app_data→挂载卡更新；路径逃逸用例拒绝 | scenario_defined |
| P2-1 | P1-3 后 | api | 文件变更→防抖推送；会话删除即停 | scenario_defined |
| P2-3 | 实现后 | api | 每错误码映射与提示快照 | scenario_defined |

（集中验收：建议 genui 列表合并进 genui/impl 既有验收节奏；上表 browser/visual 项可组一张集中验收卡。）

## Explicitly out of scope（总）
- render_ui 输出 DSL 化；多框架渲染器；A2UI/email 导出；工具浏览器直连；40+ 组件扩张（详见报告 §6）。
- 本 Plan 不含任何编码动作；accepted 前不动 genui/impl。

## Alternatives rejected（总）
- **整体引入 OpenUI 作为渲染层** — 与工具调用协议、双后端、安全围栏模型三重冲突，替换成本大于借鉴成本。拒绝。
- **照搬 OpenUI 流式实现/组件规模** — 见报告 §4.3 与各分项 rejected 列表。

## 自我拷问
- **这个改动可能破坏什么？** 最险的是 P0-2 的新协议事件（事件量与泄露面）与 P1-2 的 schemaVersion 首次演进（持久化卡片回放）——两者都已给出围栏/快照缓解，且 P0-2 标注技术负责人会签。
- **放弃了哪些备选？** DSL 化、HTML patch、全面响应式运行时——理由见各分项与报告 §6。
- **最险的一步？** P0-2 的 SessionManager 扇出改动（触碰 POO-103 精心维护的事件隔离纪律），实现时必须先写"协议页收不到 delta"的失败测试再动手。

## Wave-1 执行记录（2026-10-18，分支 iter/genui-wave1）

四项全部落地，各自成 commit（78595a80 → 3afe7727 → a965bc30 → 2824db99）。针对性测试 509 pass / 0 fail（session-tools-core + ui/chat + 事件适配器 + 协议页隔离）；`bun run typecheck:all` 全绿。

### P2-2a 基线数字（完整表见 docs/reports/schema-size-baseline.md，commit 825742ab）

| 测量项 | chars | UTF-8 bytes | est. tokens (chars/4) |
|---|---:|---:|---:|
| Pi/MCP 路径 render_ui inputSchema | 10,073 | 10,113 | ~2,519 |
| Claude 路径 RenderUiSchema → JSON Schema | 10,073 | 10,113 | ~2,519 |
| Pi/MCP 路径 generate_app inputSchema | 533 | 533 | ~134 |
| render_ui 基础描述（TOOL_DESCRIPTIONS.render_ui） | 3,046 | 3,072 | ~762 |
| generate_app 基础描述 | 2,024 | 2,044 | ~506 |
| 目录拼接节（builtin catalog） | 755 | 771 | ~189 |
| **render_ui 模型可见合计（schema+描述，两路径同值）** | **13,876** | **13,958** | **~3,469** |
| generate_app 模型可见合计 | 2,557 | 2,577 | ~640 |

token 均为 chars/4 估算口径（报告内已标注）。P1-1 瘦身以 render_ui 合计 ~13.9KB 为基数。

### 实现偏离与决策记录

- **P2-2a**：Pi 与 Claude 两路径的 schema JSON **逐字节相同**（getToolDefsAsJsonSchema 内部与 Claude SDK 走同一 zod-to-json-schema、同参数），"双列对比"退化为同值双列，脚本保留两列以备未来分叉。仓库内描述常量实际名为 `TOOL_DESCRIPTIONS`（session-scoped-tools.ts 中别名 BASE_DESCRIPTIONS），脚本按实际命名测量。
- **P2-3**：码集按建议落地；zod 4.3.5 实际 issue 形态为 `type:"array"`/`received:"undefined"`/`invalid_union_discriminator`（非 origin / message 内嵌 received），分类器按实测字段匹配并留 `schema-invalid` 兜底。修复提示改为惰性函数 `genUiErrorHint`：render-ui.ts ↔ tool-defs.ts 存在注册表环，模块级常量会在环上早初始化报 ReferenceError。按钮 param 的重复 key 与表单字段同契约，归入 `duplicate-form-field-key`。
- **P0-1**：system.ts Canvas Apps 节过期口径已按 generate_app 权威表述改写（唯一许可链接 poloai://action/ui-event/ + polo-bridge-capabilities meta）。新增 i18n 键补齐 **7 个** locale（en/es/zh-Hans/pl/hu/ja/de——计划只提了前 3 个，仓库实际有 7 个）。pl/hu/ja/de/es 各自既存的 productSpaceSkills.* 16 键缺失为基线遗留，未处理。
- **P0-2**：
  - 发射点落在 `ClaudeEventAdapter.adaptStreamEvent`（claude-agent 的 tool_start 发射路径实际在此适配器内，属"镜像 tool_start 路径"的字面落实）；`AgentEvent`（packages/core）联合同步加成员，否则 yield 链路类型不过。
  - render_ui 识别同时接受 `render_ui` 与 `mcp__session__render_ui`：Claude SDK 经 'session' MCP server 注册的会话工具在流里带 `mcp__session__` 前缀（SessionManager 侧 `mcp__session__call_llm` 判定为证），任务假设的"不带前缀"与实测不符。
  - 节流实现为"到点随下一条 delta 冲刷"（timerless）+ content_block_stop 尾冲；时钟经 `ClaudeAdapterCallbacks.now` 注入，单测无需 fake timer。累计 8192 chars 即静默，等 completed。
  - TurnCard 侧经模块级 ephemeral 累积器（useSyncExternalStore）读取：TurnCard 无 IPC 通道，由 App.tsx 的 onSessionEvent 拦截 tool_input_delta 喂入后即 return（纯处理器与协议页都见不到该事件）；骨架状态仅组件内订阅消费，activity 离开 in-flight 集合即清缓冲。
  - 隔离测试先红后绿：常量不存在时 import 失败为红；落地后 3 断言（常量值、扇出为 0、PoloaiProtocolEvent 编译期排除）长期守护。
  - Pi 路径未做（按任务说明 graceful degradation，代码注释注明）。

### 环境既存失败（基线即红，非本轮引入，均已用 stash 对照验证）

- `bun run lint`：`scripts/check-raw-sends.sh`、`check-task-tool-checks.sh` 在 HEAD 未跟踪，lint:ipc-sends / lint:tool-name-checks 127 退出。
- lint:electron 4 错（onboarding 阴影类）、lint:ui 3 错（block-markers/TurnCard 1501 既有 boxShadow）、lint:shared 0 错 20 警——均与本轮改动无关（含 my-files 定向核对）。
- 套件级：server-core 全量 47 fail、electron 全量 48 fail、shared 全量 13 fail（poison-pill esbuild metafile、callback server 时序、managed proxy 并发、i18n parity productSpaceSkills）——stash 前后失败数逐一相同；单文件重跑相关用例全绿。

### Wave-1 Review 修复轮（PASS-with-notes 处置，全部 fixed）

P1 + 6 项 P2 已全部修复（`fix(genui): address Wave-1 review findings`），门槛复跑全绿（session-tools-core + ui 689 pass / 0 fail，typecheck:all exit 0，lint 定向与基线逐项相同）。

- **P1 标题配对错挂（fixed）**：扫描器从"type→其后最近 title"单向窗口改为**字符距离双向最近**归属（以相邻两个 type 为界不跨组件；tie 归后继 type——schema 字段序惯例；首 type 之前/末 type 之后的 title 归该端 type）。补回归：schema 字段序（id,title,type）多组件（即 reviewer 复现用例）、混合顺序四组件、title 前置单组件、同 type 双 title 取首个。
- **P2-1 th align-top（fixed）**：`align-top` 移入 `enableColumnFilters` 条件分支，markdown 富块路径（未开筛选）恢复与 Wave-1 前完全一致的 class 列表。
- **P2-2 封顶注释（fixed + recorded）**：dto.ts 常量注释改为如实描述——received ≥8192 即停、末次冲刷可超出一个缓冲块，非逐字节输出上限。另记偏离：plan P0-2 方案里 "delta 单块 ≤2KB" 规格未实现（实际单块 = 250ms 窗口内缓冲量，正常速率下远小于 2KB 但无硬保证）；不改实现。
- **P2-3 seq 乱序守卫（fixed）**：累积器实现 plan 风险表承诺的单调性守卫——每 (sessionId, toolUseId) 记 lastSeq，非严格递增即丢弃（丢弃也记录该 seq，重放同 seq 再拒）；App.tsx 传 `event.seq`；无 seq 调用向后兼容。补 4 个单测（乱序/重复/重放、clear 后重置、跨 toolUseId 独立、无 seq 兼容）。
- **P2-4 lockstep 双向（fixed）**：GenUICard 导出 `GENUI_COMPONENT_TYPES`（registry keys 派生），测试改为双向集合相等断言——registry 加渲染器不更新骨架白名单同样红。
- **P2-5 会话切换缓冲滞留（fixed）**：接上最小缝隙——ChatDisplay 既有的会话切换检测 effect（deps 含 `session?.id`）在切换时 `clearGenUiToolInputDeltasForSession(前一会话)`；TurnCard 的 per-toolUseId 清理仍兜底同会话内调用收尾。
- **P2-6 TurnCard 工具名（fixed）**：新增 `isRenderUiActivityToolName`（ui 侧，语义镜像发射侧 isRenderUiToolName：`render_ui` 与 `mcp__session__render_ui` 都认），TurnCard 的进行中筛选与 completed 卡片筛选两处统一走它；配正反单测。

## Wave-1 视觉验收与 E2E 结论（2026-10-19 收口）

- **视觉验收**：PASS-with-notes（0 V1 / 6 V2 建议）。验收形态为代码级设计合规审查（对照 polo-ai-design-system 通用 token/状态合同 + packages/ui 既有卡片家族惯例）；该 Skill 声明模块不含聊天卡片，故以仓库惯例为主要参照。V2 建议清单：Spinner 无效尺寸类改字号驱动、"No rows" 硬编码英文宜 i18n、非法数值输入加 aria-invalid 微提示、chips 圆角 4px vs 家族 6px 统一、全屏视图缺筛选状态条、chip 加 max-w truncate。均记录待下轮，不阻塞。
- **E2E 基线判定**：AGENTS.md 两套真实集成在本 worktree 环境为基线红——runtime 11 pass/10 fail、managed 1 pass/5 fail。**逐名比对证实 HEAD(5fcd866b) 与基线(825742ab) 失败集合完全相同**（SIGINT/SIGTERM/…stop 超时、owned-CLI Skills/HOME、empty provider stream、managed cancel/owner-death/desktop-death/quit/controlled 链路），属环境既有问题（含 bun install 时 @vscode/ripgrep postinstall 失败），与本轮改动无关；**Wave-1 新增 E2E 失败 = 0**。针对性 genui 套件 689 pass / 0 fail、typecheck:all exit 0、lint 无新增为本轮绿色证据。

## Wave-2 执行记录（2026-10-19，分支 iter/genui-wave2）

P1-3 + P2-1 两项全部落地（基线 dev@a80431cb；commit `8c6fef51` → `f91e0903` → `92bde273` → 本文档更新）。画布应用获得"数据/结构分离"的迭代通道：bundle 以 `<meta name="polo-app-data" content="state.json">`（会话 data/ 相对路径，≤3 文件/卡、≤1MB/文件）声明可变状态，Main 在 attach 时亲自读 meta、把当前内容以 ui_state 推给该卡；模型用 `update_app_data`（`{appId, dataSrc, data}`，原子写 + 实时推送，未挂载仅落盘）迭代数据，`generate_app + updateOf` 保留给结构变化（工具描述与 system.ts 画布节已同步该契约）；声明文件变化再由 ≥1s 防抖的目录级 fs.watch 自动推送——只推给声明了该文件的那张卡。全程零新信任根：所有读写经 payloadSrc 同款 realpath 围栏，state callback 由 Main 注册并绑定到 guest，ui_state 依旧 ephemeral 永不持久化。

- **测试**：针对性套件全绿——`genui-app-data.isolated.ts` 36 pass / 0 fail（围栏 16 + 注入/推送 10 + e2e 2 + P2-1 watch 8）、`update-app-data.test.ts` 20 / 0、shared `genui-app-data.test.ts` 9 / 0（含 1MB parity guard）、工具门控 filtering 22 / 0、session-tools-core 全包 275 / 0、shared protocol 34 / 0、prompts 6 / 0；electron 既有 genui 套件（ui-card-registry 15、genui-ui-event 23、webview-genui-partition 11、deep-link-callback-bridge 7、webview-security-logging 1）逐文件全绿不受影响。`bun run typecheck:all` exit 0。
- **环境既存噪音（stash 对照证实与本轮无关）**：`lint:ipc-sends` 127（缺 scripts/check-raw-sends.sh）；lint:electron 4 错（onboarding 阴影类，Wave-1 已记录）；shared/agent poison-pill 与 assistant-scope-persistence 32/7 失败集合与基线逐名相同；同进程合并运行多个 electron isolated 套件时 bun mock.module 注册表互扰（'shell' export 报错）为基线既有，逐文件运行即绿。
- **遗留风险**：(1) 初始注入依赖 dom-ready 补推兜底，极端慢加载页面上 ui_state 可能早于 listener——应用侧按"attach 后收到的 ui_state 即当前状态"消费即幂等；(2) state callback 占用每页 8 个桥槽位中的 1 个（TTL 内常驻，推送时幂等重注册）；(3) P2-1 目录级 watch 在声明文件被整目录替换（rename 目录）后失效——静默停推（fail-soft），下次 attach 重建；(4) 真机浏览器级验收（真实 webview 卡片收推送、fs watch 实时刷新）按验收总表仍属 browser 场景，本轮以隔离单测覆盖，未做真机会话实测。
