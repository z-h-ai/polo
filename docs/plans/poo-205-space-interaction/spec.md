# POO-205 空间/项目/应用概念重构 — Spec 草案（待确认）

状态：草案 v1，2026-11-08。概念层已与产品 owner 逐题对齐（Q1–Q13 决策记录见 §3）。
下一步：owner 确认本 Spec → 锁定后进 Plan（两仓契约先行）。
本文档为权威产品结论载体；同步到 POO-205 任务卡在发布时进行。

## 1. 背景

前同事实现时三个概念未理清，导致：

1. **创建项目 = 创建一个新空间。** 仓库中没有独立 Project 实体，"项目"就是
   `enterpriseKind: 'project'` 的企业空间（ProductSpace）；创建项目走
   `POST /api/client/enterprises`（含付款责任勾选），返回新 `productSpaceId`
   并触发完整空间切换事务。证据：`packages/shared/src/admin/client.ts:1846`、
   `apps/electron/src/renderer/components/product-space/useCreateProject.ts:263`、
   `packages/server-core/src/project-members/service.ts:255-269`。
2. **上下文作用域混乱。** 所有空间的会话物理混存同一本地 `sessions/` 目录，
   仅靠会话记录上可选字段 `productSpaceId` 软隔离
   （`packages/shared/src/sessions/types.ts:146`）；Polo助手是同一内置 App
   服务所有空间，项目性只靠 system prompt 追加；workspace 级资源
   （数据源、AGENTS.md 上下文文件、默认配置）全局共享，跨空间可见
   （`packages/shared/src/prompts/system.ts:150-186`）。
3. **企业知识库（POO-108）与项目共享文件区（POO-196）两套同构系统并行**，
   企业会话可同时叠加两套上下文注入。

## 2. 目标概念模型

```
空间（企业空间=组织 / 个人空间）—— 隔离边界，互不可访问
 ├─ 项目：组织内的"大文件夹"，本质一个独立 Agent/子空间
 │    ├─ 会话（对话只发生在项目里）
 │    ├─ 共享文件区（open context，成员共享，唯一知识载体）
 │    ├─ 项目指令 + 名称/用途（Agent 身份）
 │    ├─ 项目成员（⊆ 组织成员）
 │    └─ 数据源（MCP，按项目隔离）
 └─ 应用：自定义 HTML Web App（PoloSDK 调用客户端能力）
      ├─ 共享应用（管理后台上传 / 成员从"我的应用"发布）
      └─ 我的应用（每个空间一份，自建自用，仅本人可见）
           └─ 发布：仅企业空间内可用，发布到当前空间；撤回发布回到"我的应用"

Workspace 不再是独立概念：个人空间=一个本地 workspace；组织=大 workspace；
项目=小 workspace。物理存储按空间/项目分开，会话不再混存。
```

要点：

- **聊天不是应用**。个人空间的默认形态就是自由聊天；企业空间内对话=进入项目后
  在项目里新建会话（不存在项目外会话，也不需要"选项目"引导——新建会话时已在项目内）。
- **组织由企业管理后台创建**（账号+企业空间），客户端无创建组织入口；
  创建项目是组织内的轻量操作（无付款责任）。
- **计费与治理留在组织层**；成员/文件/会话作用域挂在项目。
- **知识载体只有项目**；组织层不挂直属文件/知识上下文。
- **Catalog 契约只剩 `app` 与 `skill`**；`built_in_app` 类整体退役
  （polo_assistant / enterprise_knowledge 不再是目录条目）。

## 3. 决策记录（逐题 owner 裁决，2026-11-08）

| # | 问题 | 裁决 |
|---|---|---|
| Q1 | 个人空间形态 | 保留自由聊天为默认形态（助手不再是应用卡）；个人空间本期不引入项目 |
| Q2 | 项目外裸对话 | 不允许。会话 ∈ 项目；新建会话时已在项目内，无选项目引导 |
| Q3 | 项目数据模型 | polo-admin 新增真正 Project 实体挂组织下；成员/上下文/会话作用域挂项目；计费与付款责任留组织层 |
| Q4 | 两仓节奏 | 一个任务跨两仓，契约先行：先冻结 Project 契约（生成进 packages/shared），两端并行实现 |
| Q5 | 企业知识库 | 整体退役（入口+OpenViking 子系统+会话勾选注入）；存量 KB 数据一次性迁移到项目共享文件区；治理流不保留 |
| Q6 | built_in_app 契约 | 契约一起改（v2）：built_in_app 类从 Catalog 退役，目录只剩 app/skill；聊天=基础能力 |
| Q7 | 个人应用与发布 | "我的应用"两类：个人空间的、企业空间的（每个空间各一份，自建自用）。发布仅在企业空间内→当前空间；**个人空间本期不提供发布**；废除"自动选第一个组织" |
| Q8 | 组织来源 | 企业管理后台创建账号+企业空间；客户端不做创建组织入口；存量项目企业直接一次性升级平移（内测期） |
| Q9 | 存量迁移形态 | 就地升级：每个旧项目企业→组织（同名、成员、计费保留）+组织内自动建同名 Project，会话/文件/角色平移 |
| Q10 | 成员模型 | 项目成员 ⊆ 组织成员；组织成员由管理后台管理；客户端项目 owner/manager 从组织名单勾选；客户端不发组织外邀请 |
| Q11 | 画布应用 | 生成的应用保存到当前空间的"我的应用"；pin 保留为本机快捷方式；支持撤回发布（withdrawn 墓碑承接） |
| Q12 | 项目 Agent 深度 | 项目指令（可编辑，注入该项目所有会话 system prompt）+名称/用途=Agent 身份；底座能力全局共享，不做 per-project 模型/工具配置 |
| Q13 | Workspace 合并 | 空间/项目=Workspace 层级：个人空间=一个本地 workspace（行为不变）；组织=大 workspace；项目=小 workspace；存储物理分开；企业会话不再读个人本地 AGENTS.md/个人数据源 |
| Q13-2 | 配置分级 | 数据源（MCP）按项目；默认模型/权限模式按空间（组织一份、个人一份）；本期不做项目级覆盖 |
| Q13-3 | 组织层上下文 | 组织层不挂任何直属文件/知识上下文 |

## 4. 差距清单（现状 → 目标）

编号供 Plan 引用；证据为现状定位。

| # | 差距 | 现状证据 | 目标 |
|---|---|---|---|
| G1 | 项目=企业空间 | `schemas.ts` ProductSpaceKind 仅 personal/enterprise；`client-enterprise-contract.ts:300-309` enterpriseKind=organization/project | admin 新增 Project 实体（组织下），客户端契约重生成 |
| G2 | 创建项目走企业聚合+付款责任 | `useCreateProject.ts:232-267`、`admin/client.ts:1846` | 组织内轻量创建：名称/用途/指令，无付款责任 |
| G3 | 切换器把项目当一级空间 | `ProductSpaceSwitcher.tsx`、POO-203 直达逻辑 | 切换器=个人+组织；项目在组织内导航切换（轻量，非空间事务） |
| G4 | 会话软隔离混存 | `sessions/types.ts:146`、`trusted-product-space-account.ts:348-360` | 会话 ∈ 项目，按项目物理分存；隔离校验改 projectId 维度 |
| G5 | 单一助手 App 服务所有空间 | `tab-browser-types.ts:46-77`、`system.ts:352-365` | 项目 Agent（指令+元数据注入）；个人空间默认聊天（非应用） |
| G6 | built_in_app 契约强制 | `product-spaces/schemas.ts:139-196, 385-461` | Catalog v2 移除 built_in_app；聊天/kb Tab 退役 |
| G7 | KB 子系统并行 | `protocol/knowledge-base.ts`、`knowledge-base/*`、OpenViking 租户 | 整体退役+存量迁移；会话勾选注入 (`kbCollectionIds`) 移除 |
| G8 | workspace 全局共享 | `workspaces/types.ts:4-12`、`main/index.ts:546-555`、`system.ts:150-186` | 按空间/项目分级：企业会话不读个人本地上下文；数据源按项目 |
| G9 | 发布自动选第一个组织 | `GenUiAppPublishBridge.tsx:52-112` | 发布仅企业空间内→当前空间；个人空间无发布入口 |
| G10 | 画布应用本机化 | `genui-apps/` 本地 HTML、pin 本机条目 | 保存到当前空间"我的应用"；支持撤回发布 |
| G11 | 项目成员=企业成员资格 | `protocol/project-members.ts`、邀请流 | 项目成员 ⊆ 组织成员，从组织名单勾选；邀请流改造 |
| G12 | 客户端创建组织入口 | CreateProjectDialog 实质创建企业 | 移除；组织仅管理后台创建 |
| G13 | "project context"一词三义 | POO-196 共享文件区 / system.ts 的 AGENTS.md 机制 / SessionConfig 元数据 | 命名清理：AGENTS.md 机制改名（如 working-directory context），避免与项目共享文件区混淆 |

## 5. 范围与两仓分工（契约先行）

**第一步（阻塞一切）**：冻结 Project 契约——admin contract 重新生成进
`packages/shared`（Project CRUD、成员、共享文件区沿用 PC 契约、Catalog v2、
"我的应用"条目、发布/撤回语义），两仓同一份契约评审后并行实现。

**polo-admin 仓**：
- Project 实体（组织下）：CRUD、成员（⊆组织）、指令/元数据。
- Catalog v2：移除 built_in_app；新增成员级"我的应用"条目（自建自用）；
  发布（我的应用→空间共享）/撤回。
- 计费：项目会话计量归属组织；创建项目不产生计费主体。
- 迁移脚本（§6）。

**本仓（客户端）**：
- `packages/shared`：契约重生成、schemas v2、协议调整。
- `packages/server-core`：会话作用域 productId 化、运行时栅栏语义调整
  （空间切换保留重事务；项目切换为轻量导航，不 stop-all）、KB RPC 退役、
  数据源/默认配置按空间·项目分级。
- renderer：首页（个人/组织两形态）、项目导航与项目页、创建项目流、
  "我的应用"区与发布/撤回、成员面板改造、助手/KB Tab 退役。

## 6. 迁移方案（一次性，内测期）

| 存量 | 处理 |
|---|---|
| 每个旧项目企业（enterpriseKind=project） | 就地升级为组织（同名/成员/计费保留）+自动建同名 Project；该企业下会话（productSpaceId=该项目空间）重绑到新 projectId；项目共享文件区资产平移；成员角色映射为项目角色 |
| 企业知识库数据 | 集合导出为文件 → 导入到迁移目标项目的共享文件区（owner 可见结果日志）；OpenViking 租户退役 |
| 无 productSpaceId 的历史会话 | 维持 fail-closed 隔离现状（内测期不投入归属恢复） |
| 个人空间 | 无变化（本地 workspace 行为不变） |

兼容策略：内测期硬切，契约不设双版本兼容窗口；两仓同版本联调发布。

## 7. 工程决策（本 Spec 直接定，Plan 细化）

1. **会话物理分存**：本地会话目录按空间/项目分层（个人一份、每项目一份），
   新会话落位即物理隔离；旧目录由迁移收敛。
2. **栅栏语义**：空间切换（个人↔组织）保留现有 PREPARE/STOP/COMMIT 事务；
   组织内项目切换为轻量导航，项目执行作用域校验改 `productId`。
3. **首页形态**：个人空间=默认聊天+我的应用+圈子（现状减助手卡）；
   组织空间=项目列表+共享应用+我的应用。POO-203 首登直达组织后落到组织首页
   （或上次项目，Plan 定，倾向记住上次项目）。
4. **画布应用落位**：生成即存当前空间"我的应用"（企业项目会话→该空间；
   个人会话→个人空间）；pin 不变；发布/撤回走新契约。
5. **命名清理（G13）**：AGENTS.md 读取机制改名 working-directory context，
   "project context"术语专属 POO-196 共享文件区语义。

## 8. 验收要点（outside-in，Plan 细化为 acceptance）

1. 企业成员登录 → 直达组织 → 首页见项目列表与共享应用，无"创建企业/付款责任"入口。
2. 组织内创建项目 → 秒级完成（无付款勾选）→ 自动进入 → 项目内新建会话对话。
3. 项目 A 上传共享文件 → 成员 B 进入项目 A 可见可引用；项目 B 与个人空间不可见。
4. 项目指令修改后，该项目新会话行为随指令变化；个人空间聊天不受影响。
5. 项目会话发起时不读个人本地 AGENTS.md/个人数据源；个人空间聊天保留本地行为。
6. 空间切换器只有个人+各组织；项目切换不中断其他项目会话。
7. 画布生成应用 → 出现在当前空间"我的应用"→（企业空间内）发布 → 成员首页出现 →
   撤回 → 成员侧下线、回到"我的应用"。个人空间"我的应用"无发布入口。
8. 全客户端无"Polo助手""企业知识库"应用入口；存量 KB 内容出现在迁移目标项目。
9. 旧项目企业升级后：同名组织+同名项目，成员/文件/会话完整可继续使用。
10. 管理后台创建的组织，成员登录后可见并按上述模型使用。

## 9. 风险与开放点

- **跨仓联调**：admin 实现进度直接阻塞客户端联调；契约先行+客户端以契约
  stub 驱动开发降低串行等待。
- **计费主体合并细节**（组织层聚合）：admin 侧设计，Plan 阶段对齐。
- **设计系统缺口**：项目导航/项目页/"我的应用"为已确认范围外的区域，
  UI 高保真前需按 `polo-client-design-system` 的 native-reuse 指南出任务内候选；
  首页与顶栏属已确认模块，改动需与既有确认一致性核对。锁定验收前跑维护入口
  只读检查。
- **POO-203 直达交互**：直达组织后的落点（首页 vs 上次项目）在 Plan 定。
- i18n 键随入口退役同步清理（仓库有 3392 键×6 locale 的 parity 线）。
