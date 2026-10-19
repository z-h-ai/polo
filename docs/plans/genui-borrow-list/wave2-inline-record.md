# GenUI Wave-2 内联卡片侧执行记录（P0-1b 扩展 + P1-1 schema 瘦身）

Date: 2026-10-19 · Branch: `iter/genui-wave2-inline`（基线 dev@a80431cb，含 Wave-1 全部成果）
执行者: coder（GLM-5.3-Flash）· 本文件是执行记录；`plan.md` 由另一位并行 coder 独占，未触碰。

## Commits

| hash | 标题 | 内容 |
|---|---|---|
| `c1ce757c` | feat(genui): client-side chart legend toggle + range filter (P0-1b) | GenUiChart 图例 toggle + x 轴区间筛选（纯客户端），交互纯函数 + 单测，7 locale i18n |
| （本 commit） | perf(genui): slim render_ui tool schema via describe dedup + constraint sinking (P1-1) | render_ui schema/describe/catalog/system.ts 四处去重 + 约束下沉，bench 前后对比 |

---

## Task 1 · P0-1b 图表联动（客户端闭环）

### 实现

- **图例筛选**：多系列 bar/line 用点击式 series chips 替换 recharts `<Legend>`（与 datatable 列筛选同一 chip 家族；`aria-pressed`，pressed=可见；隐藏态 muted+line-through）。色点按声明序取 `GENUI_CHART_SERIES_COLORS` 槽位——隐藏邻居不会让可见系列换色。pie/funnel 保留只读 Legend（其图例项是 slice 不是 series，不适用"toggle 该 series"语义）。
- **区间筛选**：recharts `<Brush>`（低成本方案），仅在**纵向** bar/line 且 `rows.length >= 8`（新常量 `GENUI_CHART_RANGE_MIN_CATEGORIES`）时出现；横向排名变体与 pie/funnel 无从左到右的类目轴，不提供。筛选只裁剪视图渲染（recharts 内部切片），不回模型、不进 schema、不持久化。
- **Reset 供给**：Brush 内部窗口是 recharts 非受控状态，Reset 通过 remount nonce 重建图表子树（同时清空 store 窗口），不伸手进 recharts internals。
- **Payload 内容键 remount**：`InteractiveChartBody` 以 `JSON.stringify(component)` 为 key——同 id 卡片更新（新 payload）连带重置 ephemeral 视图状态与 recharts 内部窗口；无关的父级 re-render 保留用户筛选。
- **边界契约**：两交互零 action/send-message、零持久化；工具描述 view-state 行同步扩为 "(filter/sort/group, chart legend/range) … by the cards"（随 Task 2 的描述重写落地）。
- **测试**：`genui-chart-viewstate.test.ts`——`genUiChartRangeFilterEnabled` / `resolveGenUiChartRange`（钳制/反转/垃圾输入/缩数据降级）/ `toggleGenUiChartSeriesHidden`（纯度）/ `visibleGenUiChartSeries`（顺序保持、plan 不可变）+ view-state 边界断言。既有 `genui-chart.test.ts` 原样全绿（replay 语义不变）。
- **i18n**：新增 2 键 × 7 locale（en/es/zh-Hans/pl/hu/ja/de）：`genui.chart.filterStatus`（"Showing X of Y categories"）、`genui.chart.resetFilters`（"Reset"）。locale-parity 回到基线（29 pass / 5 个既有 productSpaceSkills 缺失 fail，stash 对照证实）。

### 偏离与决策

1. **交互单测为纯函数层**（任务卡要求"交互单测"）：packages/ui 无 React-mount 测试设施，且 bun test 全仓库共享单进程——electron 侧的 happy-dom GlobalRegistrator 模式会把 `window` 全局泄漏给同进程其它包的测试（electron 测试文件内注释即为此警告）。交互层完全由导出纯函数决定（与该文件既有"plan 决定一切绘制"同一学说），故测纯函数。chips 为声明式渲染，无分支逻辑。
2. Brush 阈值 8 类目：低于此全图已可读，brush 是噪音。
3. lint:ui 3 错为存量（TurnCard 1501 inline boxShadow 等），未新增、未顺手修。

---

## Task 2 · P1-1 render_ui schema 瘦身（重估 → 有限执行 → 复测）

### Before / After（双后端逐字节同值，与 P2-2a 结论一致）

| 测量项 | before chars | after chars | before bytes | after bytes | before est. tok | after est. tok |
|---|---:|---:|---:|---:|---:|---:|
| render_ui inputSchema（Pi/MCP = Claude，两路径同值） | 10,073 | 6,577 | 10,113 | 6,579 | ~2,519 | ~1,645 |
| render_ui 基础描述（TOOL_DESCRIPTIONS.render_ui） | 3,196 | 1,774 | 3,222 | 1,796 | ~799 | ~444 |
| render_ui 目录拼接节（builtin catalog） | 755 | 854 | 771 | 870 | ~189 | ~214 |
| render_ui 完整描述（base + catalog） | 3,953 | 2,630 | 3,995 | 2,668 | ~989 | ~658 |
| **render_ui 模型可见合计（schema+描述）** | **14,026** | **9,207** | **14,108** | **9,247** | **~3,507** | **~2,302** |
| generate_app 合计（未动，对照） | 2,557 | 2,557 | 2,577 | 2,577 | ~640 | ~640 |

（before = HEAD a80431cb 实测复跑；不是照抄 825742ab 基线——Wave-1 P0-1 给描述加过边界句，base 描述比 825742ab 的 3,046 chars 多 150。token 均为 chars/4 估算口径。）

**合计 −4,819 chars / −1,205 est. token（−34.4%）**；schema 单项 −34.7%，描述 −33.5%（目录节 +99 chars 是主动承接下沉语义）。

### 重估结论（先回答"值不值得做"）

- 原计划目标"4-6K → ≤2K token"建立在 15-25KB 的错误估计上；P2-2a 实测 13.9KB / ~3,469 tok（本轮 before ~3,507）后，"≤2K"意味着砍掉 ~60%，在"不动结构"约束下不可达——schema 的结构性成本（7 个 union 成员的属性名/枚举/嵌套）本身 ~1,645 tok。
- **实际执行 −34.4%（~2,302 tok）且零结构变化、全部校验契约保留（Zod 运行时校验照旧，双后端 wire 依旧逐字节一致）——值得做、值得保持。** 每会话每轮省 ~1.2K token 输入上下文；50 轮会话累计 ~60K token 的上下文占用差。
- 后续建议：
  1. **P2-2a 的 CI 阈值落地**（计划已列）：对 render_ui 合计加"超基线 +10% 报警"，守住本轮成果（本轮未入 CI，属 P2-2 范围）。
  2. 下一档瘦身必须动结构，两条候选（均超出 P1-1 边界，需另立项）：(a) POO-104 的 `buildRenderUiJsonSchemaForComponentTypes` 已能出子集 schema——若模型侧按启用组件下发 wire schema，禁用成员的枚举/属性即消失；(b) schemaVersion 2 换更短字段名。DSL 化仍按计划拒绝。
  3. 错误率观测沿用 P2-3 的错误码计数，会话实测观察精简是否引发重试上升（本轮未做会话实测，属验收准备总表的"会话实测"项）。

### 有限执行明细

**语义归属（去重后每处语义只有一个家）：**

| 语义 | 唯一家 | 说明 |
|---|---|---|
| 跨组件取值语义（percent semantics / stat format / goodWhen / badgeColors） | base 描述 **Value semantics** 节 | 4 条完整保留（tool-defs-genui-formatting 的描述 pin 依赖其中引号字段名）；160 字符目录帽装不下，不下沉目录 |
| 全局规则（4KB 上限 + chart 例外 / id 复用 / retry once / 显示 vs 行动 / view-state 边界） | base 描述 **Rules** 节 | "`chart` is the exception" 措辞被 tool-defs-genui-chart pin，原样保留；view-state 行按 P0-1b 扩为 "chart legend/range … by the cards" |
| 每类型索引 + 类型级用法 | 目录 one-liner（≤160 字符 sanitize 帽，零截断） | chart/data-table/action-buttons 三条承接被删 bullet 的用法语义（见下） |
| 结构邻接契约（插值占位、delta 小数、link 取值形态等 160 帽装不下的） | schema `.describe()`（保留少量短 describe） | 如 rowAction.promptTemplate "{{col.key}} → 该行值"、detailTemplate 预填不发送 |
| system.ts Interactive UI Cards 节 | 指针化 | 原组件清单**已过期**（缺 chart/form）且 5 条 Rules 全部与工具描述重复；现仅留一句使用时机 + 指向工具描述 |

**撤下的非功能性字符串长度帽（wire + 运行时同时失效，按计划此为预期）：**
`GenUIBase.id` max64、`title` max120、stat-card `label` max80 / `value` string max40 / `unit` max12、column `key` max60 / `label` max80、alert `message` max500、progress `label` max120、button param options item max80、button `id` max64 / `label` max40、action `prompt`/`promptTemplate`/fill `text` max2000、form field `key` max60 / `label` max80 / options item max80、`submitLabel` max40。（所有 `.min(1)`、数组/数值界、枚举、`.strict()`、superRefine 全部未动。）

**保留的长度帽（行为测试把它们钉为校验契约，非"省事"）：**
chart 类目标签 max60 / series name max60 / series unit max12（tool-defs-genui-chart）；rowAction label max20 / promptTemplate max500 / detailTemplate max500（tool-defs-genui-datatable-rows）；stat-card `currency` max8（tool-defs-genui-formatting）；confirm message max300 / param key max40 / param label max60（tool-defs-genui-action-buttons）。

**目录 one-liner 文案变更（全部语义等价移动/承接，非新语义）：**
1. data-table：'sortable file-backed table … with optional per-row actions and source links' → 'file-backed table (rows via transform_data + "src", never inline), sortable/filterable, optional per-row actions and source links'（同义重排）。
2. chart：承接 base 描述 chart bullet 的选择指引与界限（'"chartType"' 措辞为 tool-defs-genui-chart 描述测试所需）；'bar/line/funnel/pie chart with inline categories…' → 'chart via "chartType": bar/line/funnel/pie over 2-24 categories, up to 3 series — …'。
3. action-buttons：承接 confirm/params 用法指引（'use confirm for high-stakes, params + {{key}} templates instead of hardcoding values'）。
4. stat-card / alert / progress / form：未动（stat-card 一行被 genui-catalog.test 原样 pin）。

**snapshot 更新清单：空。** 没有任何快照/文案类测试因本轮失败或被更新——唯一被逐字 pin 的 stat-card 一行原样保留；其余 pin（formatting/chart 的描述 needle）由保留的 Value semantics/Rules 节和承接后的 chart 行自然满足。

### 验证数字

- `bun test packages/session-tools-core`：249 pass / 0 fail（含全部 tool-defs-genui-*.test.ts、genui-schema、genui-catalog、render-ui handler）。
- `bun test packages/session-tools-core packages/ui` 合跑：708 pass / 0 fail。
- `bun test packages/shared` 全量：14 fail vs 基线 13（stash 对照）——**多出的 1 个是 creator-skills installer 的 fsync 时序 flake**：该文件本轮零改动，隔离重跑时基线反而 fail 2 个、带本改动 fail 1 个，且逐次失败用例名不同；与 poison-pill（esbuild metafile 环境问题）、managed proxy 并发、callback server 时序同属环境既存红。i18n parity 的 5 个 fail 与基线逐名相同（productSpaceSkills 既有缺失）。
- `bun run typecheck:all`：exit 0。
- `lint:shared`：0 错 / 20 警（与 Wave-1 基线逐项相同）；`lint:ui`：3 错（存量 inline boxShadow，数量未增）。
- 结构完整性抽查：序列化 JSON schema 的 7 个 union 成员、chart required、data-table `additionalProperties:false` 全部不变。

### 偏离点汇总

1. 去重实际涉及**四处**（schema describe / base 描述 / 目录 one-liner / system.ts 节），不止计划说的三处——base 描述（TOOL_DESCRIPTIONS.render_ui）是最大重复源，任务卡未单列但它正是 plan 步骤 2 的"三处重复"主体；归属表见上。
2. 约束下沉改为"约束删除"：目标语义家（目录一句话）只对 chart 数据界限成立（one-liner 里 2-24/3），其余被删长度帽的语义是"别写超长文本"类的常识，未逐条造目录句——避免为删 16 字节约束花 60 字节描述。
3. bench 脚本每次运行覆写 `docs/reports/schema-size-baseline.md`：本轮已 `git checkout` 还原该已提交基线文档，前后数字以本记录为准（脚本 stdout 原样核对过）。
4. `generativeUiInlineEnabled` / `generativeUiCanvasEnabled` 默认值未动（保持 false）；`plan.md` 未触碰。
