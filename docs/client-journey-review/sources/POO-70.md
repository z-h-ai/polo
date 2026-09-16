父任务：POL-111
共享依据：POL-112（身份、登录与端边界）

## Intent（待访谈）

消费 AI 能力的桌面工作台；盘点注册/登录/恢复、个人与企业空间、首次使用/空状态、Apps/Skills 获取与启停、助手、App 运行、任务结果/文件、圈子加入/订阅、积分阻断与充值返回、账号与管理端跳转。先确认用户可完成的任务，再确认首页/导航和页面。

必须检查：空间切换后的数据/会话/权限/付款主体；企业成员被移除、作品/版本受限、断网/执行失败、部分结果、客户端重开后的恢复。Browser 的邀请/支付/管理是跨端交接，不能把浏览器成功误认为桌面已经刷新。

沿用 POL-94 现有充值规则：用户主动单次查询，不自动发送、续写或重试；若要改变另列决定。POO-41、POO-42、POO-43、POO-47、POO-48、POO-49、POO-52—POO-66 只是待核对现有任务范围，不因引用就设为访谈前置。

## 在本卡访谈，从这些例子开始

首次安装的小王加入企业后找到可用 App 并取得结果；同一个人在企业和我的空间间切换；执行因积分不足中断，浏览器充值返回后由用户确认查询再决定是否重新执行。

Agent 先依据 `POL-68/refactor/comm-defs:docs/polo-client-user-flows.md` 的全部 PC-Fxx 场景和现有实现做覆盖表，主动指出缺失环节并给推荐，再请用户判断。不要把以上示例误当成本端全部需求；须检查旧场景和本轮新增目标是否都被覆盖。

## 本端 policy 盘点范围

空间/账号隔离、App/Skill 授权、费用与执行同意、结果保存/恢复、浏览器回跳、桌面权限、无障碍与设计规则的适用证据。

逐条列已有 source/版本/owner、可复用规则、只缺 Skill 包装、规则未知、规则冲突、需强制执行点。端内不复制或改写共享身份定义，待共享规则确认后引用；真正可复用且有 owner 的政策交给最后的政策收口卡工程化。

## 依赖与完成标准

本卡只读盘点和不涉及身份变化的访谈可立即开展；涉及身份/入口的 Spec 定稿依赖 POL-112 对应规则明确确认。无需等待所有历史实现卡完成。

逐个既有 PC-Fxx 场景给出保留、调整、延后或移出本轮的明确结论及依据；列全功能覆盖与缺口、导航/入口、异常恢复、跨端交接、policy 缺口和验收例子。产品 owner 接受本端 Spec 及变更范围才算本次访谈完成；Spec、流程画布与后续验收引用同一组场景 ID。

## 已核验的依据与边界（2026-09-15，本地检出证据）

- Admin 文档基线：仓库 `/Users/wow/project/z-h-ai/polo-admin-dir`，分支 `POL-68/refactor/comm-defs`，HEAD `c43754bab5700f20998eef971c0ff27f36eba743`。复用 `CONTEXT.md`、`docs/adr/`、`docs/product-function-baseline.md`、`docs/user-flows-permissions-and-states.md`、`docs/product-space-contract.md` 及四端 `*-user-flows.md`。
- 第二轮支付：同仓库 `POL-94/feat/product-space-credit-recharge@9ae3e7308317fe2dce5b5fb714bd0955c7054335`，读取 `docs/payment-requirements-round2-handoff.md`、`docs/payment-round2-user-flows-and-page-states.md`、`docs/payment-round2-implementation-orchestration-plan.md` 与最新 POL-94 正文。ADR 0019 位于 POL-68 分支。第二轮是接续范围，不把两套计划机械拼成新需求。
- Admin 实现对照：`integration/pol68-g5-admin@1fbf393811bc78b02a8a2de17796b6d61d3d88ee`；`dev@04c64fd5afb14e918463c699c0994789551d6944`。集成分支 `src/app/page.tsx` 正好列出 `/login`（Platform admin login）、`/enterprise/login`、`/creator-workbench/login` 三入口，并声明独立会话、无互跳。dev 首页仍是 Platform admin login 与 Organization App management。两者不可混称当前产品。
- Client 实现对照：仓库 `/Users/wow/project/z-h-ai/polo-dir`，`integration/pol68-g5-client@3dc20ca373a9ad64c8b0701d1156a5adaf55aef8`；`dev@01f4447cf77612ca2c62d9c7155601a51bdb7b5b`。这些是本地源码基线，未验证用户正在访问的部署版本，也不是上线/验收声明。访谈开始时刷新分支、HEAD、脏改动，并记录实际体验环境（若可取得）。
- 最新 POL-68 正文保留既有模型；最新 POL-94 已收敛为 App Metering Contract 与最终跨端验收；POL-88 明确企业、创作者、staff 会话隔离及无互跳。旧卡的历史进度、Done 和文档页数不能证明当前旅程已验收。
- 已检查 Admin main/dev/POL-68/POL-94 的 `.agents/skills`：以工程执行 Skills 为主，另有 `skills/polo-bundle-compliance`；Client dev 未见 `.agents/skills`，集成分支该目录未见 SKILL.md。尚未发现适用的四端产品 policy skill；这不等于现有业务规则全部缺失，不扩张为全分支穷尽结论。
- 跨分支文档引用必须写仓库、分支/commit、路径；检查用户指出的支付文档到 `implementation-orchestration-plan.md` 的悬空相对链接。不得仅因另一分支缺文件就认定没有设计。

## 本轮协作方式与交付约定

- 用户已授权重新梳理与创建访谈任务；本卡是待访谈的 Intent 草案，不代表新 Spec/产品政策已被批准。这里不启动 Goal/Ultra、改产品代码或重置现有执行任务。
- 进入本卡后使用 `ai-native-sdlc`：先读本卡、总入口和有关的最新来源；复用仍适用的确认，只问新增或冲突的产品问题。在本卡会话访谈，一次最多 3 个问题；用户不需要先列出自己不知道的缺失功能。
- Agent 先给功能盘点和差异：每项列用户目标、来源/场景 ID、现有入口/权限/状态证据、实现与集成位置、验收证据、缺口类型、推荐下一步。缺口分为未设计、已设计未实现、已实现未集成/发布、已实现但流程不闭合、已验收、证据不足；同一项允许记录多个维度，不能用 Done 代替证据。
- 用具体人物和动作说明问题：现状 → 用户卡在哪里 → 选项 → 唯一推荐方案及影响。保留原 PC-Fxx/ENT-Fxx/CRE-Fxx/OPS-Fxx 与 S-xxx ID，新场景追加稳定 ID，不按文档自报数量宣称覆盖完成。
- 每条旅程写角色、前置状态、自然入口、页面和动作、成功结果、拒绝、空状态、失败、取消/中断、会话过期、返回与恢复、跨端交接、数据/付款责任。关键跨端场景在 Spec 草拟时用 `product-flow-canvas` 形成可点击低保真画布，逐节点讨论；源码现状与拟议行为分开标注。
- 每端输出：功能覆盖表、端内信息结构/入口图、主流程及异常恢复、跨端输入输出、policy 缺口矩阵、变更裁决清单和验收场景；至少走通首次使用、日常使用、一次失败恢复三个代表场景。来源绑定统一，画布是派生产物，产品结论在任务正文。
- 已确认规则、建议和待决问题分别标记；不把历史页面偶然行为提升成政策，不静默覆盖 POL-68/POL-94 已确认规则。发生冲突，列原依据、新例子、推荐变化、影响场景/卡片，待对应产品 owner 在本卡确认。
- 先确认怎么走，再确认长什么样。仅对仍不明确的节点做线框/关键页原型；流程确认与视觉确认分别记录。Spec 接受后才进入 Plan；本次建卡不授权开发或发布。
- 本卡完成标准是明确的产品结论与场景交付，不是已实现/已上线。产品确认人是需求提出者或其指定 owner（未指派具体访谈执行人）。需要实施的缺口在收口后关联原卡或另建增量执行卡。

