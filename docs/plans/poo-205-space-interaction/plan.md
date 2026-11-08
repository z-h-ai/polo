# Plan: POO-205 空间/项目/应用概念重构

Status: draft · Date: 2026-11-08
Reviewed by: 待技术负责人会签（高风险：迁移/权限/跨服务）· Accepted by: —

方案依据：`docs/plans/poo-205-space-interaction/spec.md`（同分支工作树,随本 Plan 一并提交）
契约依据：`docs/plans/poo-205-space-interaction/contract-draft.md`（v0,待两仓联审冻结）

## Baseline and upstream anchors

| 锚点 | 修订/基线 | 确认依据 | 执行依赖或集成条件 |
|---|---|---|---|
| 当前代码 | `POO-205/refactor/space-interaction@7b723fbc`（2026-11-07） | 三路只读探索（空间/应用/项目域,证据见 Spec §1/§4） | — |
| 契约冻结 | contract-draft.md v0 | Spec Q4=A owner 裁决 | polo-admin 侧联审通过后才进 P2+；客户端 P0-P1 可先行 |
| polo-admin 实现 | 外部仓（z-h-ai/polo-admin）,本 Plan 无其路径 | Spec Q3/Q4 裁决 | Project 实体/Catalog v2/迁移脚本部署 staging 且契约用例通过 → 场景 J-1/J-9/J-10 可达 function_accepted |

> 本 Plan 无 `upstream-expected` 文件：客户端契约文件由本任务持有（P0 产出）；
> admin 仓工作单列 §跨仓工作流,不进入本仓文件表。

## Files that change（本仓）

| 状态 | 文件 | 动作 | 为什么（差距） | 执行前核对 |
|---|---|---|---|---|
| new-by-this-task | `packages/shared/src/admin/project-contract.ts` | 新增 | G1/G2 Project 实体+REST 契约（冻结稿落地） | 联审通过 |
| existing | `packages/shared/src/product-spaces/schemas.ts` | 修改 | G6 Catalog v2：删 built_in_app、source 规则加 `self`、visibility 字段 | 基线存在,契约 §5 |
| existing | `packages/shared/src/admin/project-context-contract.ts` | 修改 | G1 PC v2 作用域键 productSpaceId→projectId | 契约 §3 |
| existing | `packages/shared/src/admin/client.ts` | 修改 | G1/G7/G10 projects/my-apps/publish/withdraw/mapping 客户端方法 | 契约 §2/§5/§7 |
| existing | `packages/shared/src/admin/types.ts` | 修改 | G6 CatalogApp 增 visibility/ownerAccountId | 契约 §5 |
| existing | `packages/shared/src/sessions/types.ts` | 修改 | G4 会话记录增 `projectId` | 契约 §4 |
| existing | `packages/shared/src/protocol/project-members.ts` | 修改 | G11 组织名单勾选语义,邀请流退役 | 契约 §2 |
| existing | `packages/shared/src/protocol/project-context.ts` | 修改 | G1 pc_* RPC 参数换 projectId | 契约 §3 |
| existing | `packages/shared/src/protocol/knowledge-base.ts` | 删除 | G7 KB 退役 | Spec Q5 |
| existing | `packages/shared/src/prompts/system.ts` | 修改 | G13 working-directory context 改名；G5 项目指令注入（替代现 `<project_context>` name/purpose 追加） | Spec §7-5 |
| existing | `packages/shared/src/sessions/storage.ts` | 修改 | G4/G8 项目会话物理分存布局；**迁移工具必须实现在会话存储层**（AGENTS.md 规则） | 现布局 `sessions/` |
| existing | `packages/server-core/src/runtime/product-space-executions.ts` | 修改 | G3/G4 fence 保持空间级,谓词扩展 projectId 校验 | Spec §7-2 |
| existing | `packages/server-core/src/handlers/rpc/sessions.ts` | 修改 | G4 边界谓词（`trustedScopeMatchesSessionRecord` 扩展） | 契约 §4 |
| existing | `packages/server-core/src/sessions/SessionManager.ts` | 修改 | G4/G5/G7 projectId 盖章、分存、KB 注入移除、项目指令注入 | 契约 §4 |
| existing | `packages/server-core/src/project-members/service.ts` | 修改 | G1/G2/G11 项目 CRUD RPC+组织名单（pmCreateEnterprise 退役） | 契约 §2 |
| existing | `packages/server-core/src/project-context/service.ts`、`tool-facade.ts` | 修改 | G1 pc 服务换键；G8 facade 作用域 projectId | 契约 §3 |
| existing | `packages/server-core/src/handlers/rpc/knowledge-base.ts`、`src/knowledge-base/` | 删除 | G7 | Spec Q5 |
| 落地区域 | MCP/数据源配置模块 + 默认模型/权限配置 | 修改 | G8 分级（数据源按项目,默认配置按空间） | 实现起点核对实际配置文件（探索确认 sources 挂 workspace 层,精确文件 P2 首日盘点） |
| existing | `apps/electron/src/main/handlers/genui.ts`、`local-apps.ts`、`transport/channel-map.ts`、preload 对应面 | 修改 | G10 画布应用落我的应用、member 条目安装启动 | 契约 §5 |
| existing | `apps/electron/src/renderer/hooks/useProductSpaceContext.ts`、`useProjectEntry.ts`、`useAppCatalog.ts`、`useMemberAppActions.ts` | 修改 | G3/G10 列表只剩个人+组织、项目轻量进入、目录 v2 | Spec §7 |
| existing | `apps/electron/src/renderer/components/product-space/`（Switcher/SelectScreen/useCreateProject/CreateProjectDialog） | 修改 | G2/G3/G12 轻量创建、选择屏与切换器简化、组织创建入口移除 | Spec §2 |
| existing | `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`、`tab-browser-types.ts`（shared）、`TabContent.tsx` | 修改 | G5/G6 首页两形态、助手/KB Tab 退役、个人空间默认聊天 | Spec §7-3 |
| existing | `apps/electron/src/renderer/components/tab-browser/KnowledgeBaseApp.tsx` | 删除 | G7 | Spec Q5 |
| existing | `apps/electron/src/renderer/components/tab-browser/GenUiAppPublishBridge.tsx`、`GenUiAppPinBridge.tsx` | 修改 | G9/G10 发布仅企业空间当前空间；保存到我的应用；撤回 | Spec Q7/Q11 |
| existing | `apps/electron/src/renderer/components/project-context/ProjectMembersPanel.tsx`+hooks | 修改 | G11 从组织名单勾选 | Spec Q10 |
| new-by-this-task | `apps/electron/src/renderer/components/projects/`（项目导航/项目首页/项目设置） | 新增 | G3/G5 项目页区域（设计系统未确认区,见场景表） | 设计候选先行 |
| existing | i18n locale ×6（zh-Hans 等） | 修改 | 入口退役/新增文案,保持 parity | AGENTS.md parity 线 |
| existing | 受影响测试：space-select、ProductSpaceSwitcher、POO-202 三件套、POO-203 B1、app-shell 70/1、genui-webview-lifecycle、canvas 4 件套 | 重构+新增 | 全部差距 | AGENTS.md 命令 |

## 跨仓工作流（polo-admin,非本仓文件表）

1. 联审并冻结 contract-draft.md（P0 门禁）。
2. Project 实体+REST（§1/§2）、PC 资产换键（§3）、Catalog v2+my-apps/publish/withdraw（§5）、
   迁移脚本（§7）、计费归属组织（§2 联审项）。
3. staging 部署+契约用例绿 → 通知本仓 re-pin 集成验收。

## Order of work

1. **P0 契约冻结**：contract-draft 联审 → 生成 `project-contract.ts` + schemas v2 草案。
   （先于一切：所有下游消费契约,漂移即返工。）
2. **P1 shared 类型层**：schemas/types/protocol 落地 + G13 命名清理（纯类型,先行暴露影响面）。
3. **P2 server-core 数据层（最险先做）**：会话 projectId 盖章与物理分存、存储层迁移工具
   （幂等/dry-run/备份）、栅栏与 RPC 谓词扩展、数据源/默认配置分级盘点与落地。
4. **P3 server-core 服务层**：项目 CRUD/成员 RPC、PC 换键、Catalog v2 消费、
   my-apps/发布撤回 RPC、KB 退役、项目指令注入。
5. **P4 迁移对接**：admin 脚本联调、客户端 mapping 重绑工具（会话存储层）。
6. **P5 renderer 空间层**：切换器/选择屏（个人+组织）、项目轻量进入、创建项目流（无付款）。
7. **P6 renderer 页面层**：首页两形态、项目页区域（设计候选先行）、我的应用+发布撤回、
   成员面板、助手/KB Tab 退役、个人空间默认聊天。
8. **P7 验收**：测试重构全绿、i18n parity、设计系统一致性+维护入口检查、
   canvas 链路回归（4 件套+e2e run.mjs）、场景 J-1~J-10 逐项留证。

## Risks and mitigations

| 风险 | 影响 | 缓解 | 验证 |
|---|---|---|---|
| 两仓契约漂移 | 全线返工 | P0 冻结+生成校验+staging 契约用例 | typecheck:all+admin 用例 |
| 本地会话迁移丢数据 | 用户会话丢失 | 存储层工具幂等+dry-run+原目录备份保留 | 真实 jsonl 夹具迁移测试（含无 projectId 旧记录） |
| 计费归属错乱 | 资损/报表错 | 计量断言测试；admin 联审主导 | J-1/J-9 场景+计量断言 |
| 栅栏/切换回归（POO-202/203 套件） | 空间切换坏 | 先改夹具后改实现；套件重构独立提交 | space-select 19、Switcher 10、app-shell 基线 |
| 首页/顶栏视觉回归 | 破已确认设计 | 已确认模块按 design skill 一致性核对+source-baseline 再生 | build --check+复审 |
| i18n parity 破线 | 发布阻断 | 随改随跑 parity 脚本 | 6 locale parity |
| KB 迁移失败 | 企业知识不可达 | dry-run 报告+导入日志+owner 可见结果 | J-8 场景 |

## Proof（验收准备三层）

- `scenario_defined`：Spec §8 J-1~J-10 全部（含拒绝/恢复行为）。
- `execution_ready`：P0-P1 即刻可验（typecheck:all、契约 schema 单测）；
  J-1/J-9/J-10 依赖 admin staging（负责人:admin 侧,再检查时机:P4 联调门禁）。
- `function_accepted`：各 P 完成后在绑定 commit 上执行并留证后才可声明。

命令（AGENTS.md）：`bun run typecheck:all`、`bun run test`、`bun run lint`、
canvas 回归 4 件套+`bun apps/electron/e2e/poo161-canvas-recovery/run.mjs`。
UI 视觉证据：真实截图对照 design skill 已确认模块；未确认区域以评审通过的候选为准。

## Scenario and visual implementation map

| 场景 ID（Spec §8） | 实现工作 | 设计依据与确认范围 | 验证方式 |
|---|---|---|---|
| J-1 组织直达首页 | P5 HomePage/P203 直达逻辑改造 | 首页目录=design skill 已确认模块（调整需一致性核对） | 真实运行+截图 |
| J-2 轻量创建项目 | P5/P3 创建流+RPC | CreateProjectDialog 改造,已确认组件域 | 场景测试 |
| J-3 项目文件成员共享/隔离 | P3 PC 换键 | 无新视觉 | pc RPC 边界测试 |
| J-4 项目指令生效 | P3 system 注入 | 无新视觉 | 会话 prompt 断言测试 |
| J-5 企业会话不读个人本地上下文 | P2 分级 | 无新视觉 | system prompt 断言（含反例） |
| J-6 切换器只剩个人+组织/项目切换轻量 | P5 Switcher/进入 | 顶栏=已确认模块 | Switcher 套件+真实操作 |
| J-7 画布应用落位/发布/撤回 | P6 GenUi 桥+P3 RPC | 应用卡=已确认组件；我的应用区=新候选（先出设计候选） | genui 套件+场景测试 |
| J-8 助手/KB 入口消失+KB 内容迁移 | P6 Tab 退役+P4 迁移 | 首页=已确认模块（摘卡） | 全局搜索断言+迁移日志 |
| J-9 旧项目升级平移 | P4 迁移链 | 无新视觉 | 迁移夹具端到端+staging 联调 |
| J-10 后台建组织→成员使用 | 跨仓+P5 | 无新视觉 | staging 端到端 |
| 新增：项目页/项目设置 | P6 projects/ 区域 | **未确认区**：product-ui-prototype 候选→owner 确认后实施 | 候选评审+真实操作 |

## Explicitly out of scope

- 客户端创建组织入口（Q8）；个人空间发布（Q7）；个人空间项目（Q1）。
- 项目级模型/工具配置（Q12）；组织层直属上下文（Q13-3）；项目归档。
- 无 productSpaceId 历史会话的归属恢复（维持 fail-closed）。
- 契约双版本兼容窗口（内测硬切）。
- `apps/webui` 浏览器版与 CLI 侧的适配（受 shared 契约影响时仅做编译级跟进,交互适配另行开卡）。

## Alternatives rejected

- 客户端呈现层重构、数据模型不动（Q3-B）——"创建项目≠创建空间"无法满足,乱的根源仍在。
- 保留全局 workspace 只做隔离补丁（Q13-B）——会话混存与三义命名洞不闭合。
- 双版本契约兼容期——内测无真实用户,兼容期纯成本。
- 项目级独立计费主体——与"计费留组织层"裁决相反。
- KB 保留兼容期（Q5-B）——两套知识系统并行正是本次要消除的混乱。

## 项目政策沿用（AGENTS.md 提取）

- 检查命令与 canvas 回归/CLI 套件按仓库根 AGENTS.md 执行,分别报告。
- 会话存储迁移必须实现在会话存储层（不得前端猜路径/放宽主进程安全门）；
  会话层不得为显示改写协议数据的路径/模型标识。
- UI：已确认模块（首页/顶栏/应用卡）改动做一致性核对；未确认区域先出候选；
  验收锁定前跑 `polo-client-design-system` 维护入口只读检查；source-baseline 按纪律再生。
- i18n 6 locale parity 保持。
- 本 Plan/Spec/契约草案随分支提交；不自动 push/tag/发版。
