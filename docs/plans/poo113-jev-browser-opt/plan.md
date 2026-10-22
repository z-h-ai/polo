# Plan: POO-113-P1 浏览器操作快层（suggest 子命令 · 只读建议）

Status: accepted · Date: 2026-10-22
Reviewed by: Douglas（2026-10-22） · Accepted by: Douglas（2026-10-22，六项裁决见下）

方案依据：`docs/plans/poo113-jev-browser-opt/scheme.md`（§2 架构与决策规则、§2.3 快层 prompt、§2.4 接入点、§5/§6 实测结论与硬约束）

## 已裁决决策（2026-10-22，Douglas）

1. **数据外发**：快层外发页面快照与现有浏览器链路（主模型逐步决策）同构，属既有数据姿态，不新增用户知情/开关环节。
2. **快层模型与 key 来源**：走 polo 现有 LLM 连接体系，即**管理后台下发的托管配置**（与主模型同通道）——非用户自配、非环境注入。
3. **P2 放行策略（另卡生效）**：黑名单放行——危险动词（删除/支付/提交/发送等）需用户确认后才自动执行；**黑名单类目可配置**（同为管理后台下发），实现时提供默认类目表。
4. **4a** 配置走现有 LLM 连接；**4b** Mind2Web 离线回归为建议级（不强制）。
5. **评测资产**：`docs/plans/poo113-jev-browser-opt/` 全部入库提交。
6. **B 路模型可配置**：默认 glm-5.3-flashx，GLM-5.3-Flash 为降成本候选；配置由管理后台下发，非用户配置。

## 范围一句话

在 `browser_tool` 中新增 `suggest <子步骤>` 子命令：快层双模型（deepseek-flash + glm-5.3-flashx）对当前快照并行定位，返回**建议命令**（含一致性、危险标记、归一化），主模型自行决定是否采纳执行——**P1 不自动执行任何动作**。

## Baseline and upstream anchors

| 锚点 | 修订/基线 | 确认依据 | 执行依赖或集成条件 |
|---|---|---|---|
| 当前代码 | `POO-113/feature/jev-model-browser-opt@af22c74b` | 2026-10-22 只读扫描（grep 锚点见文件表"执行前核对"列） | — |
| 方案/测评 | `docs/plans/poo113-jev-browser-opt/scheme.md` + `eval/results/`（v2 管线 95.6%） | 本会话多轮实测（scheme §5/§6） | 无上游代码依赖（纯新增+少量修改） |

无 `upstream-expected` 项；所有路径已在基线上核对存在。

## Files that change

| 状态 | 文件/预计落地区域 | 动作 | 所有者/来源 | 为什么 | 执行前核对 |
|---|---|---|---|---|---|
| new-by-this-task | `packages/shared/src/agent/browser-fast-decider.ts` | 新增 | 本任务 | 快层调用器：双路并行、子步骤 prompt、fuse 归一化、isExecutable 校验、危险动词标记、超时降级 | 父目录存在（同层 browser-tool-runtime.ts）；复用 `llm-tool.ts` 的 `withTimeout`(:76) 与请求构建模式 |
| new-by-this-task | `packages/shared/src/agent/__tests__/browser-fast-decider.test.ts` | 新增 | 本任务 | 纯函数契约测试（fuse/isExecutable/agreement/dangerous/degrade，mock fetch，不联网） | 同目录已有 browser-tools.test.ts 等约定 |
| existing | `packages/shared/src/agent/browser-tool-runtime.ts` | 修改 | 本任务 | ① 导出 `BROWSER_TOOL_ACTION_MENU`（动词菜单单一来源）；② 新增 `suggest` 分支（经注入的可选 `fastDecider` 调用，缺失时友好报错） | :1729 命令 switch 处无 `suggest` 冲突（已核对）；snapshot 经现有 `fns.snapshot()` |
| existing | `packages/shared/src/agent/browser-tools.ts` | 修改 | 本任务 | 工厂签名增加可选 `fastDecider` 注入并透传 runtime | :233 工厂存在；沿用 `BrowserPaneFns` 同层注入模式 |
| existing | `packages/shared/src/config/llm-connections.ts` | 不改（实现偏差已同步） | 本任务 | 原计划在此新增 `resolveBrowserFastDeciderPaths()`；实现时移入 `browser-fast-decider.ts` 的 `resolveBrowserFastDeciderEndpoints()`（避免 config 层反向依赖 agent 层类型），仅复用本文件导出的 `getLlmCredentialKey`(:356) | `getLlmCredentialKey` 已核对存在 |
| existing | `packages/shared/src/agent/pi-agent.ts` | 修改 | 本任务 | Pi 后端浏览器命令执行处(:1858)透传 `getFastDecider`（plan 风险表中"执行时核对"项，已核对并补上） | `getSessionScopedToolCallbacks` 调用点已核对 |
| existing | `packages/shared/src/config/storage.ts` | 修改 | 本任务 | 内部设置项 `browserFastDecider?: { enabled: boolean; timeoutMs?: number }`（默认 enabled=true；无用户配置 UI，模型与 key 均走托管配置） | `browserToolEnabled`(:80/:157/:556) 同文件同模式 |
| existing | `packages/server-core/src/sessions/SessionManager.ts` | 修改 | 本任务 | 组装 decider 实例（连接解析 + 每会话单例）并传入 browser 工具工厂 | :5860 browserPaneFns 绑定处、:5396 miniModel 注入模式 |
| existing | `apps/electron/resources/docs/browser-tools.md` | 修改 | 本任务 | 新增 `suggest` 用法、快层说明、危险标记语义、"建议≠执行" | 文件存在（模型必读文档，prerequisite 门不变） |
| existing | `packages/shared/src/prompts/system.ts` | 修改 | 本任务 | Browser Tools 章节(:468)加一句：定位类子步骤可用 `suggest` 获取快层建议 | 章节锚点已核对 |
| existing | `packages/session-tools-core/src/tool-defs.ts` | 修改 | 本任务 | `browser_tool` 描述(:909 附近)提及 `suggest` | 注册表行存在 |
| existing | `packages/shared/src/agent/__tests__/browser-tools.test.ts` | 修改 | 本任务 | 补 `suggest` 分支测试（mock decider：一致/分歧/危险/未配置 四态） | 现有用例结构沿用 |

## 快层契约（锁定，来源 scheme §2.3/§5/§6 实测）

```ts
interface FastDeciderInput { snapshot: string; substep: string; history?: string[] }
interface FastDeciderResult {
  suggestedCommand: string | null;      // null = 无建议（降级/超时/双路皆非法）
  agreement: 'both' | 'single-A' | 'single-B' | 'none';
  dangerous: boolean;                   // 目标元素名命中危险词表（save/delete/submit/pay/checkout/…）
  paths: { name: 'deepseek' | 'glm-flashx'; command: string | null; latencyMs: number; error?: string }[];
}
```

硬约束（违反即测试失败）：
1. prompt 的动词菜单**必须**由 `BROWSER_TOOL_ACTION_MENU` 生成（含 upload/key/scroll/done/fail），测试断言菜单与 runtime 命令集一致（E08 教训）；
2. 快层输入**必须**包含 `substep`（主模型子步骤），不接收整任务自规划（§5 实测：整任务口径 40–47%）；
3. 输出经 fuse 归一化（点击→click、上传→upload、已完成→done）+ isExecutable（@eN ∈ 快照、动词 ∈ 菜单）；
4. 单路超时 3s（可配），降级不阻塞、不抛错；
5. `suggest` 永不执行动作，只在返回文本中标注 `dangerous`（P2 才有 auto-accept，且另卡）。

## Order of work

1. **纯函数层先行（最险=契约）**：`BROWSER_TOOL_ACTION_MENU` 导出 + fuse/isExecutable/dangerous 纯函数 + 契约测试——下游全部依赖这份契约，先锁死。
2. decider 调用器 + `resolveBrowserFastDeciderPaths()`（mock fetch 测试；429 退避沿用 eval 脚本经验）。
3. runtime `suggest` 分支 + browser-tools.ts 注入 + SessionManager 组装（missing-dep 优雅降级）。
4. 文档/系统提示/工具描述（一句话级，prerequisite 门不变）。
5. 全量验证（见 Proof）。

## Risks and mitigations

| 风险 | 影响 | 缓解 | 验证 |
|---|---|---|---|
| 真实页面快照超大（500+ 元素）撑爆快层 prompt | token/延迟上涨 | 菜单截断至上限（默认 120 行，截断时附提示"用 find 缩小"）；超限直接返回"建议 find 后重试" | 单测：构造 600 元素快照 |
| 任一快模型 API 不可用/限流（flashx 有 429 实测） | 建议缺失或变慢 | 单路超时 3s + 指数退避 + 单路降级仍可用；双路皆败 → suggestedCommand=null | 单测：mock 超时/429 |
| key 管理（明文 key 禁止入库） | 安全 | 走管理后台托管 LLM 配置（与主模型同通道），仓库与本地 settings 均不存明文 | 代码审查 + grep 明文模式 |
| 中文动词/多行输出（GLM 家族 ~10%） | 建议不可解析 | fuse 归一化 + isExecutable 拦截，非法输出按"该路失败"处理 | 单测：`点击 @e4`→`click @e4`；多行→非法 |
| suggest 增加交互延迟 | 体验 | 3s 上限；主模型可选择不调用 suggest | 手动冒烟（见 Proof） |
| 与 Pi/Claude 双后端差异 | 行为不一致 | decider 注入点在 browser-tools.ts 工厂层，两后端共用同一 runtime；Pi 侧 pi-agent.ts 仅需透传（如已走工厂则零改动，执行时核对 :1850 附近） | 双后端各跑一条 suggest 冒烟 |

## Proof

验收准备分层：
- `scenario_defined`：本表 + 快层契约（已定义）
- `execution_ready`：基线 af22c74b 上全部锚点已核对；bun test/typecheck/lint 可跑（AGENTS.md 命令）
- `function_accepted`：合并后执行下方验收表并留证

| 任务 | 验收时机 | 检查类型 | 场景 | 集中任务 |
|---|---|---|---|---|
| POO-113-P1（本卡） | 实现完成时（✅ 2026-10-22） | `bun run typecheck:all` + `bun run lint` | 全仓库 | 无（单卡 per_card） |
| 同上 | 实现完成时（✅） | `bun test .../browser-fast-decider.test.ts .../browser-tools.test.ts` | 快层契约 5 硬约束 + suggest 四态（一致/分歧/危险/未配置） | 同卡 |
| 同上 | 合并前（⏳ 待人工） | 手动冒烟：`electron:dev` 起真实会话，对内置浏览器执行 `suggest 点击「搜索」`，截图建议输出与耗时 | 真实浏览器端到端（≥1 条） | 同卡 |
| 同上（建议级，✅ 已做） | 合并前 | 生产代码路径（直接 import browser-fast-decider.ts）对 Mind2Web 定位口径抽样 30 例直连跑批 | 回归结果：**28/30 = 93.3% 全对，29/30 双路一致**（与 eval 口径 94.8%/88.1% 吻合） | 同卡 |

**实现完成自检（2026-10-22）**：typecheck:all 0 错误；browser-fast-decider 16/16、browser-tools 91/91（含 suggest 6）、session-tools-core 278/278、browser-tool-detection+names 13/13；shared/agent 套件 1187 例中仅 `base-agent.test.ts > Lifecycle > should track chat calls` 1 例失败（已验证无本次改动亦失败，属分支既有问题）；electron lint 4 个错误位于 onboarding 组件（未触碰，分支既有）；lint:ipc-sends / lint:tool-name-checks 所需 shell 脚本不在仓库（既有环境缺口）。

无 UI 改动 → 视觉验收不适用（无 journey/node 表）。

## Explicitly out of scope

- **P2 auto-accept**（另卡，政策已裁决）：**黑名单放行**——两路一致且未命中危险动词即自动执行；危险动词（删除/支付/提交/发送等）**必须用户确认**后执行；黑名单类目**可配置**（管理后台下发），实现时提供默认类目表（save/delete/remove/submit/confirm/pay/checkout/purchase/buy/place order/book now/sign out/log out/send/transfer 及中文对应词）。前置 gate 不变：polo 内置浏览器 10–15 条多步任务实测通过。
- snapshot 输出自带建议（runtime 无任务上下文，违反硬约束 2——已否决）
- 快层连接的用户设置 UI（配置全部由管理后台托管下发）、远程浏览器（RemoteBrowserPaneManager）专门优化、多步轨迹/真实执行反馈评测（P2/P3 范围）
- `.zcode/agents/flash-eval.md`（本会话测评工具，随仓库保留但不属于产品链路）

## Alternatives rejected

- **snapshot 附带建议动作** — runtime 拿不到主模型任务/子步骤上下文，等于让快层自规划（实测 40–47%），否决
- **单路快模型（只用 deepseek）** — 无跨模型分歧信号，"一致但错"无法拦截（实测同模型双采样一致率虚高），否决
- **call_llm 工具复用为快层入口** — 主模型自由组合 prompt 无法保证子步骤契约与动词菜单单一来源，且逐次构造 prompt 分歧率高，否决（但复用其 withTimeout/请求构建代码）
- **P1 直接 auto-accept** — 危险动作拦截与多步 gate 未落地，安全前置不足，否决
