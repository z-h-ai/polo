# Polo 客户端完整高保真 UI v1 对齐

父任务：POL-68

## 阶段与目标

本任务属于 G4-B 设计冻结门。产品用户已于 2026-08-11 完成最终走查并冻结 Polo 客户端 UI v1；后续正式开发必须以本任务的冻结结构、状态和文案为准。

## 权威输入

- `/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/docs/g4-polo-client-ui/polo-client-user-flows.md`
- `/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/docs/g4-polo-client-ui/g4-ui-prototype-reimplementation-plan.md`
- `/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/docs/g4-polo-client-ui/g4-ui-prototype-scene-matrix.md`
- `/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/docs/g4-polo-client-ui/phase2-client-shell-contract.md`
- `/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/docs/g4-polo-client-ui/product-space-contract.md`
- `/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/docs/g4-polo-client-ui/product-space-operation-contract.md`
- `/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/docs/g4-polo-client-ui/implementation-orchestration-plan.md`

## 完整范围

按 `PC-F01`—`PC-F11` 覆盖：首次登录与我的空间、个人 App、圈子加入与管理、Polo 助手与 Skill、企业邀请交接、安全切换、企业空间消费、权限/作品失效、账号与偏好、离线恢复、契约不一致。

已冻结的客户端结构：

1. 首页为当前空间摘要、常用 Apps、系统工具三个区块；Polo 助手固定第一张，另有最多 5 个工作 App；“全部 Apps”是唯一管理与查找入口。
2. “全部 Apps”始终展示当前空间完整目录。个人空间按圈子来源分组；同名但不同作品分别出现并标明来源。企业空间展示企业向当前成员分发的全部作品。
3. 文件只记录最近通过助手附件、App 导入/导出或 AI 生成的本机文件；不提供独立上传。文件名用系统默认应用打开，本机位置打开所在目录。
4. Skill 只能在 Polo 助手中启用、选择和调用，不生成独立 App 或 Tab。
5. Sources、Automations、Browser 只属于助手内部，不进入客户端顶层导航。
6. 账号与偏好保留在客户端；企业/创作者管理、付费圈子结算、账单充值和复杂注销在系统浏览器处理。
7. 客户端不持续展示 AI 算力付款主体；相关字段仅保留为内部授权、计量和账务契约。

## 状态覆盖

每个关键流程必须能够通过稳定 `scene` 进入并评审：正常、空、加载、失败、离线、无权限、资格或订阅失效、企业受限、作品治理阻断、运行中、终止中、终止失败和恢复。个人与企业持续显示当前空间、来源、权限、数据归属和运行状态；不展示付款主体。

## 设计产物

- 在现有 `design-demos/polo-client-g4-ui/index.html` 基础上扩展，不丢失已完成路径。
- 正式冻结 artifact commit：`ef3528ef`（已推送到 `origin/POO-41/feat/polo-client-g4-ui`）。
- 冻结记录：`design-demos/polo-client-g4-ui/review-record.md`。
- 已将说明性文案收敛为行动引导；98 个客户端场景不再出现超过 15 个汉字的可见辅助说明。
- 提供一个无需构建即可打开的主评审入口；稳定 `scene` 清单以 `g4-ui-prototype-scene-matrix.md` 为索引。
- 使用真实产品文案、桌面客户端尺寸和接近正式产品的视觉，不使用文本线框图。
- 文档和原型必须共同记录流程覆盖、冻结边界和未纳入 v1 的后续项。

## 不做

- 不修改 Polo 正式前端代码，不连接或伪造正式 ProductSpace 后端实现。
- 不制作企业组织管理端、创作者工作台或平台运营端 UI。
- 不维护或重画产品用户单独管理的可视化画布。
- 不重新访谈已经确认的产品定义和用户流程。
- 不把原型中的临时实现方式写成正式技术架构要求。

## 验收标准

1. 客户端自有流程可在 HTML 内完成主路径、异常和恢复评审；系统浏览器流程验证交接/返回；既有助手内部流程只验证真实组件复用边界，不在静态原型重画。
2. “我的空间/企业空间”、本地 Workspace、Creator Circle 三种概念在画面中不会混淆。
3. Creator Circle 不出现在空间切换器；管理端入口只对具备对应身份的用户显示。
4. Polo 助手在不同 ProductSpace 中复用同一真实组件入口，但运行上下文必须隔离；POO-41 验证入口、Tab 和 scope 交接，会话、附件、文件、Skills 与内部计量隔离由 POO-44 E2E 证明。
5. App、Skill 和 Polo 助手运行时禁止直接切换空间，终止失败时保持原空间。
6. 所有空、加载、失败、受限和危险操作都有用户可理解的反馈与恢复动作，不以技术日志代替。
7. 首页不出现最近结果、内容变化、可添加 Apps 长列表、Skills 摘要或独立上传文件按钮；Tasks 不出现付款主体/最小计量 UI。
8. 产品用户明确冻结 UI v1 后，POO-42、POO-43、POO-44 必须引用本 HTML 和本任务权威文档，不得自行改变已确认的结构、路径和状态语义。
