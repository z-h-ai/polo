# Polo 重构完整实施与 UI 编排计划

本文是 POL-68 从“已确认产品定义”进入“编码前完整冻结”的总索引。它把 `refactor-model-map.md` 的内部编号映射为正式看板任务，并规定 UI 回写、依赖执行、自动继续和人工暂停规则。

四端高保真交互 HTML 的重新实现、AB 评审包、产品/评审分离和冻结规则见 `docs/g4-ui-prototype-reimplementation-plan.md`。

## 1. 当前阶段

截至 2026-08-11：

- G0—G3、F01-A、F01-B 已完成。
- G4-A 的 22 个实施项已全部映射为正式看板任务；等待产品用户集中确认任务图后冻结。
- G4-B 的四个产品入口均已建立 UI v1 任务。POO-41 已完成客户端结构对齐和现有原型收敛，进入最终走查/冻结；其余三端仍按各自任务推进，因此整体 G4-B 尚未通过。
- POL-72 及后续实现任务全部保持 `todo`。在 G4-A 与 G4-B 同时通过前，不启动正式产品编码。

## 2. 正式任务映射

### 2.1 编码前 UI v1

| 产品入口 | 流程数 | UI 任务 | 项目 / 分支 | 设计入口（任务产出） | 状态 |
| --- | ---: | --- | --- | --- | --- |
| Polo 客户端 | 11 | POO-41 | Polo-工作台 / `POO-41/feat/polo-client-g4-ui` | `design-demos/polo-client-g4-ui/index.html` | 结构已确认，原型已收敛，待最终冻结 |
| 企业组织管理端 | 12 | POL-73 | polo-admin / `POL-73/feat/enterprise-admin-ui-v1` | `design-demos/enterprise-admin-ui-v1/index.html` | 旧稿待按专项计划覆盖 |
| 创作者工作台 | 10 | POL-74 | polo-admin / `POL-74/feat/creator-workbench-ui-v1` | `design-demos/creator-workbench-ui-v1/index.html` | 旧稿待按专项计划覆盖 |
| 平台运营端 | 13 | POL-75 | polo-admin / `POL-75/feat/platform-operations-ui-v1` | `design-demos/platform-operations-ui-v1/index.html` | 旧稿待按专项计划覆盖 |

统一验收脚本：`scripts/validate-g4-ui-prototypes.mjs`。

2026-08-10 的旧稿历史校验结果如下，仅作为覆盖前基线，不构成本轮 G4-B 完成证据：

| 产品入口 | 流程 | 五态视图 | 关键断言 | 页面脚本错误 |
| --- | ---: | ---: | --- | ---: |
| Polo 客户端 | 11 / 11 | 55 / 55 | App 上传 → 执行 → 审核 → 导出通过 | 0 |
| 企业组织管理端 | 12 / 12 | 60 / 60 | Manager 的 Owner-only 成员写操作禁用且未打开 Dialog | 0 |
| 创作者工作台 | 10 / 10 | 50 / 50 | 首次无默认圈子；资格受限仍保留四项责任处理入口 | 0 |
| 平台运营端 | 13 / 13 | 65 / 65 | 账号删除阻塞与账号恢复分别产生正确结果 | 0 |

### 2.2 基础、企业、圈子与作品

| 内部编号 | 正式任务 | 项目 / 分支 | 直接前置 |
| --- | --- | --- | --- |
| F01 | POL-72 建立跨仓库 ProductSpace v1 契约与直接切换 | polo-admin / `POL-72/refactor/product-space-contracts` | G4-A、G4-B |
| F02 | POL-76 建立 ProductSpace 持久化与我的空间自动供给 | polo-admin / `POL-76/refactor/product-space-provisioning` | POL-72；与 POL-77 对齐 account kind |
| F03 | POL-77 拆分业务账号、工作人员账号与创作者资格 | polo-admin / `POL-77/refactor/account-creator-qualification` | POL-72；与 POL-76 对齐个人空间约束 |
| E01 | POL-78 将 Organization 企业模型收敛为 Enterprise | polo-admin / `POL-78/refactor/enterprise-domain-split` | POL-76、POL-77 |
| E02 | POL-79 实现企业权限矩阵与原子 Owner 转让 | polo-admin / `POL-79/feat/enterprise-owner-permissions` | POL-78 |
| E03 | POL-80 实现企业成员组、生命周期与限制状态 | polo-admin / `POL-80/feat/enterprise-groups-lifecycle` | POL-78、POL-79 |
| C01 | POL-81 将 Creator Space 迁移为 CreatorCircle | polo-admin / `POL-81/refactor/creator-circle-migration` | POL-76、POL-77 |
| C02 | POL-82 实现圈子加入与成员生命周期 | polo-admin / `POL-82/feat/circle-membership-lifecycle` | POL-81、POL-77 |
| A01 | POL-83 建立统一 Artifact 与 ArtifactVersion 身份 | polo-admin / `POL-83/refactor/artifact-version-model` | POL-81、POL-77 |
| A02 | POL-84 实现圈子分发、个人授权与激活分层 | polo-admin / `POL-84/feat/circle-entitlement-activation` | POL-82、POL-83 |
| A03 | POL-85 实现企业 Artifact 实例与 App Skill 导入 | polo-admin / `POL-85/feat/enterprise-artifact-import` | POL-78、POL-80、POL-83 |
| A04 | POL-86 统一作品来源、检查与全局版本治理 | polo-admin / `POL-86/feat/artifact-version-governance` | POL-77、POL-83；与 POL-90 对接 |

### 2.3 目录、客户端、管理、计费与收口

| 内部编号 | 正式任务 | 项目 / 分支 | 直接前置 |
| --- | --- | --- | --- |
| S01 | POL-87 按 ProductSpace 解析统一 Catalog | polo-admin / `POL-87/feat/product-space-catalog` | POL-76、POL-84、POL-85、POL-86 |
| W01 | POL-88 拆分企业管理端与创作者工作台权限 | polo-admin / `POL-88/refactor/admin-entry-permissions` | POL-77、POL-79、POL-82、POL-84、POL-85 |
| M01 | POL-89 实现 ProductSpace 付款主体、预算与最小计量 | polo-admin / `POL-89/feat/product-space-billing-metering` | POL-72、POL-76、POL-77 |
| O01 | POL-90 实现平台工作人员、资格审批与高风险治理 | polo-admin / `POL-90/feat/platform-operations-governance` | POL-77；与 POL-86、POL-89 对接 |
| B01 | POL-91 实现圈子订阅与内容收入账本 | polo-admin / `POL-91/feat/circle-subscription-ledger` | POL-77、POL-82、POL-89 |
| L01 | POL-92 实现企业圈子账号生命周期与支持授权 | polo-admin / `POL-92/feat/lifecycle-support-authorization` | POL-79、POL-80、POL-90、POL-91 |
| P01 | POO-42 重构 Polo 客户端 ProductSpace 上下文与安全切换 | Polo-工作台 / `POO-42/refactor/product-space-switching` | POO-41、POL-72、POL-76、POL-87 |
| P02 | POO-43 重构成员首页、统一 Catalog 与 App Runtime | Polo-工作台 / `POO-43/refactor/catalog-runtime-home` | POO-41、POO-42、POL-84—POL-87 |
| P03 | POO-44 将 Polo 助手重构为内置 App，并隔离会话、附件、文件与 Skills 的 ProductSpace 上下文 | Polo-工作台 / `POO-44/refactor/assistant-space-isolation` | POO-41、POO-42、POO-43、POL-72、POL-84、POL-85、POL-89 |
| X01 | POL-93 执行 ProductSpace 直接切换与旧模型清理 | polo-admin / `POL-93/refactor/direct-cutover-cleanup` | POL-87—POL-92、POO-43、POO-44、四端 E2E |

### 2.4 Polo 客户端三项正式实现边界

POO-42—POO-44 共同把当前“助手承担整个客户端外壳”的结构迁移为“工作台外壳 + 多 App Tab + Polo 助手内置 App”。三项任务不得把同一全局能力保留两套入口：

| 正式任务 | 必须交付的边界 |
| --- | --- |
| POO-42 / P01 | 建立客户端唯一的 ProductSpace 上下文和顶部切换器；安全切换时统一刷新 Tab、助手、目录、文件和运行上下文 |
| POO-43 / P02 | 建立首页、统一 Catalog、App Runtime、顶部运行中心、“任务与结果”和“文件”等外壳目的地，先承接从旧助手移出的全局能力 |
| POO-44 / P03 | 保留会话列表、消息、输入框、附件、代码块、工具调用、进度、结果和 Skill 能力；移除助手内部 `OrganizationSwitcher`、账号、App 目录、下载中心、全局文件、通用偏好和管理端入口 |

POO-44 的去壳层不是视觉隐藏任务：必须解除旧助手控件的导航、状态和上下文所有权，并改接 POO-42/POO-43 提供的客户端外壳。`WorkspaceSwitcher` 不能改名或映射为 ProductSpace 切换器；如助手仍需要本地工作目录，只能作为本次对话上下文或高级设置。POO-41 已冻结 `Sources`、`Automations` 和 Browser 为助手内部能力；POO-44 复用其唯一入口，POO-42/POO-43 不新增顶层入口。

## 3. UI v1 回写规则

UI 任务完成后，不只是把 HTML 路径写在本文件中。以下实施任务必须通过 Notma 正文更新引用实际冻结产物、确认日期和版本：

| UI v1 | 必须回写的实施任务 |
| --- | --- |
| POO-41 Polo 客户端 | POO-42、POO-43、POO-44；涉及成员端状态的 POL-82、POL-84、POL-87、POL-89、POL-91 |
| POL-73 企业组织管理端 | POL-79、POL-80、POL-85、POL-88、POL-89、POL-92 |
| POL-74 创作者工作台 | POL-81—POL-84、POL-86、POL-88、POL-91、POL-92 |
| POL-75 平台运营端 | POL-77、POL-86、POL-89—POL-92 |

回写至少包含：

- 冻结 HTML 的绝对路径和对应提交。
- UI v1 确认日期与确认人。
- 该任务负责的页面和状态范围。
- 视觉验收视口、关键组件与状态检查点。
- 禁止实施阶段自行改变的页面结构、操作路径、文案、权限差异和状态语义。
- 未进入 UI v1 的内容必须明确标为后续任务，不能在编码中顺便补做。

## 4. 推荐执行波次

同一波次内可以并行，但任务编排必须先验证每个任务的直接前置证据，不得仅按编号启动。

| 波次 | 任务 | 通过条件 |
| --- | --- | --- |
| Design-1 | POO-41、POL-73、POL-74、POL-75 | 四套 HTML 完整覆盖 46 组流程并分别冻结 UI v1 |
| 1 | POL-72 | 共享包发布、两端 contract tests 与直接切换契约通过 |
| 2 | POL-76、POL-77 | ProductSpace 与身份资格不变量集成通过 |
| 3 | POL-78、POL-81、POL-89、POL-90 | Enterprise/Circle 拆分，付款和运营基础可独立验收 |
| 4 | POL-79、POL-80、POL-82、POL-83 | 企业权限/组、圈子成员、作品身份完成 |
| 5 | POL-84、POL-85、POL-86、POL-91 | 个人授权、企业导入、治理、订阅账本完成 |
| 6 | POL-87、POL-88、POL-92 | 统一 Catalog、管理端拆权、生命周期完成 |
| 7 | POO-42 | ProductSpace 安全切换 E2E 通过 |
| 8 | POO-43 | 成员首页、统一 Catalog、App Runtime、运行中心和全局文件目的地 E2E 通过 |
| 9 | POO-44 | Polo 助手完成去壳层并作为内置 App 运行；会话、附件、文件与 Skills 隔离 E2E 通过 |
| 10 | POL-93 | 跨仓 Convert/Switch/Rebuild/Cleanup 与四端最终验收通过 |

## 5. 自动继续规则

任务编排在以下情况下自动继续，不请求产品用户裁决：

- 表、索引、事务、缓存、队列、模块、内部 API 和测试组织等工程选择。
- 已冻结范围内的 bug、边界处理、性能优化和安全加固。
- 根据任务卡验收标准补充单元、契约、集成与 E2E 测试。
- 对已确认 UI 的像素、响应状态和可访问性修复，只要不改变产品语义。
- 未公开发布阶段已明确的一次性开发/试点数据转换和旧缓存重建。

仅在出现下列真实冲突时暂停，并使用具体用户场景、可观察影响和推荐方案提交裁决：

- 必须改变当前版本功能范围或新增尚未确认的业务能力。
- 必须改变 Owner/Manager/Member、Creator Owner、staff 或资格权限。
- 必须改变付款主体、预算粒度、退款/结算责任或内容收入与算力分账。
- 必须改变 ProductSpace、会话、文件、作品、企业实例或业务数据归属。
- 必须改变 closing、注销、支持授权、治理阻断等业务责任。
- 技术约束无法实现已冻结 UI 的结构、操作路径、文案或状态语义。
- X01 对账发现无法确定 Owner、资格、作品来源或财务责任的数据。

## 6. G4-A/G4-B 冻结清单

G4-A 由产品用户确认以下事项后通过：

- 上述 22 个实施任务没有缺失、重复或跨产品入口的隐式范围。
- 依赖波次、目标项目、分支、输入输出和验收条件可以支持持续编排。
- 任务卡中的非目标与人工暂停条件符合预期。

G4-B 由产品用户分别确认四套 HTML 后通过：

- 46 组流程全部可评审。
- 正常、空、加载、失败、受限和关键操作状态完整。
- 页面结构、文案、视觉、权限差异和危险操作已经冻结为 UI v1。
- 设计路径和确认结果已回写所有相关实施任务。

两项门禁全部通过后，第一张可启动的代码任务是 POL-72；在此之前，任务编排只允许执行 UI 设计、任务卡补全和文档校验。
