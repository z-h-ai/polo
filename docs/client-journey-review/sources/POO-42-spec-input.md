父任务：POL-68
内部编号：P01

## 阶段与启动门禁

本任务属于 G5 正式客户端实现。仅在 G4-A 完整任务冻结、G4-B 四端 UI v1 冻结全部通过，且 POO-41 的 Polo 客户端 UI v1 已明确确认后启动。

## 目标

用 ProductSpaceContext 替换 OrganizationContext 的成员消费职责，并由 Polo 客户端顶部提供唯一的 ProductSpace 切换器。切换器只显示“我的空间”和用户可访问的企业空间；切换时必须把首页、Tabs、Polo 助手、目录、文件、Skills、权限与运行状态作为同一事务整体切换。启动和会话恢复时还必须校验 ProductSpace 契约；企业创建或邀请成功后安全刷新空间列表，不强制改变当前空间。

## 权威输入

- docs/polo-client-user-flows.md
- docs/product-space-operation-contract.md
- docs/refactor-model-map.md 的 P01
- POO-41 客户端 UI v1：`/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/design-demos/polo-client-g4-ui/index.html`，正式冻结提交 `ef3528ef371b785a1932b8a65356a62ad463538e`；1440、1024、390 宽度核对个人/企业切换、运行终止、失败、离线与受限状态，不自行改变其导航、文案和状态语义。
- POL-72 共享契约
- G4 补充 UI 冻结版：`/Users/wow/project/z-h-ai/polo-admin-dir/POL-68/refactor/comm-defs/design-demos/g4-supplemental-ui-review/index.html`，2026-08-12 经产品用户确认，冻结产物提交 `7e144bd136ecde30e6f7a833e5f784a1e46fcb03`，负责 PC-F11 升级阻断页面；企业创建/邀请公开页仍由 POL-79 实现。

## 前置依赖

- POL-72 共享契约。
- POL-76（F02）ProductSpace API。
- POL-87（S01）统一 Catalog。
- POO-41 UI v1 已冻结。

## 范围与输出

- 引入 ProductSpaceContext；本地 Workspace/workspaceId 保持正交。
- 客户端顶部工作台是唯一的 ProductSpace 切换入口；Polo 助手和其他 App 内不得保留第二套 Organization/ProductSpace 切换器。
- 空间切换器仅列出 personal/enterprise，CreatorCircle 只在“我的圈子”关系入口出现。
- 检查当前 App、Polo 助手和 AI 执行；存在运行项时阻止直接切换。
- 实现逐项/全部终止、等待确认、失败重试与取消切换。
- 切换事务整体更新 ProductSpace，并刷新首页快捷入口、打开的 Tabs、目录、文件、助手会话、Skills、权限和 runtime scope。
- 切换成功后不得保留或回显旧空间的 App Tab、助手会话、文件、授权或运行数据；同一内置 App 可复用宿主，但必须加载目标空间上下文。
- 计量归属继续遵守共享契约，但不在客户端常规页面持续展示“由谁承担 AI 算力”等说明；后续充值或计费场景另行呈现。
- 终止失败或刷新失败时保持原空间，不产生半切换。
- 旧 Organization 产品空间列表不作为 fallback。
- 启动或登录后校验 ProductSpace `contractVersion`；客户端无法安全理解时阻断业务界面，只提供升级与帮助。升级后旧 Organization/Creator Space 授权和 Runtime 缓存直接失效并重建。
- 接收企业创建或邀请成功刷新信号：有效成员关系成立后显示新企业但不强制切换；快速共享待审批不显示企业；刷新目录失败时保留成员关系、允许重试且不混入个人目录。

## 非目标

- 不重命名或删除本地 Workspace。
- 不在后台保留旧空间执行。
- 不把 CreatorCircle 放入空间切换器。
- 不把助手内部的 OrganizationSwitcher 改名后继续保留。
- 不自行改变 POO-41 冻结交互和文案。

## 验收标准

1. 任意运行项存在时不能直接切换；用户必须终止或取消。
2. 终止失败保持旧 ProductSpace，所有上下文一致。
3. 切换成功后首页、Tabs、App、助手会话、文件、Skills、权限和运行状态全部属于目标空间，旧空间数据不可继续操作或混入页面。
4. CreatorCircle 不出现在切换器。
5. 同一本地 Workspace 可分别切 personal/enterprise，两个 ID 永不互相替代。
6. 客户端全局只有一个 ProductSpace 切换器，Polo 助手内部不存在 Organization/ProductSpace 切换入口。
7. 正常、加载、终止中、失败、受限和离线状态与 POO-41 一致。
8. E2E 覆盖多个并发执行、助手边界切换、目标空间加载失败与失败恢复。
9. 契约不兼容时业务界面、Apps、助手和文件均不可进入；升级失败可重试，成功后按新契约重建缓存。
10. 企业创建/邀请成功、共享待审批、目录刷新失败和下次启动刷新均通过跨端 E2E；任何情况都不强制切换当前空间。

## 自动继续与暂停规则

状态管理、IPC、缓存刷新和测试技术由研发自动决定。只有需要允许后台执行、改变切换结果或偏离冻结 UI 时暂停裁决。

## 2026-09-03 POO-53 基线恢复接续契约

本节是当前恢复执行的新增约束；上文产品范围、权威输入、非目标和 10 条验收标准保持原样，不得削弱。旧 Goal 及历史流水线证据保持冻结，不得修改或删除。

### 保留状态与合并方式

- 保留 POO-42 起始 HEAD `aac01c1d78fd7c2d79b980caefad70879a1c6651` 及全部既有历史。
- 最新 Client integration 为 `0c4b07d132f9eca63e1b4f65f6687b6b6c741bb4`，其中已包含 POO-53。
- Coder 的第一项实现动作必须在 POO-42 分支执行普通非快进合并：`git merge --no-ff 0c4b07d132f9eca63e1b4f65f6687b6b6c741bb4`；冲突必须在本分支解决，不能留到最终 integration。
- 禁止 rebase、reset、force-push、把 integration commit 改为 cherry-pick，或丢弃任何历史/WIP/流水线证据。

### 语义冲突解决

不能机械选择任意一侧。尤其同时审计 `AppShell.tsx`、`TopBar.tsx`、`SessionManager.ts`、IPC/DTO/routing、session-scoped tools、多语言文件及所有其他重叠路径：

- 必须保留 POO-53 的进程内 request-user-input runtime、session-scoped tool 生命周期、DTO/schema、取消与工具注册语义。
- 不得重新带回 POO-53 已删除的 external Codex/session-MCP 链、外部 Codex CLI session wiring 或废弃兼容路由。
- 必须保留 POO-42 的 ProductSpace fence、account/ProductSpace/local Workspace 正交、原子且 fail-closed 的切换，以及 Tab/session/file/skill/permission/catalog/runtime 隔离。
- 运行任务仍须阻止直接切换；终止或目标加载失败必须完整保留旧空间；全局仍只能有一个 ProductSpace 切换器。
- 必须保留 contract-version 阻断、企业成员关系刷新与冻结 UI 语义。

示例：只保留旧 POO-42 一侧可能复活 external Codex 链；只保留 POO-53/integration 一侧可能丢失 ProductSpace fence。正确结果必须同时满足两套不变量。

### 强制阶段顺序与证据

1. 完成普通合并、语义解冲突、实现修复、测试和 merge commit；后续修复 commit 继续以 `POO-42:` 开头。
2. `.pipeline/implement-report.md` 必须记录合并决策、关键冲突、不变量检查和测试结果。
3. 合并完成后从 Reviewer 1 开始全新 Review；异常退出的历史 R40 不得复用，也不得直接进入 Acceptance。
4. 两位 Reviewer 必须依次在同一当前 HEAD 通过：`pajacom / ali/glm-5.2 / high`，然后 `claucom / ali/qwen3.8-max / high`。
5. 两轮 Review 均通过后，执行完整 Electron 功能验收与冻结视觉一致性验收，覆盖 1440、1024、390；必须保留真实渲染截图/证据，plan-only 报告不算通过。
6. 最终 Review、Acceptance、报告哈希与提交必须指向同一 HEAD；Coder 不 push，branch-ready 后由 Goal 统一核验 push、remote equality 和 Client integration。

完成前必须证明 `git merge-base --is-ancestor 0c4b07d132f9eca63e1b4f65f6687b6b6c741bb4 HEAD` 成功。

## 2026-09-04 Acceptance 环境恢复接续契约

本节仅接续已经完成的 POO-53 语义合并，并以用户最后确认的固定 Ultra 配置覆盖上一节第 4 项的 Reviewer/provider 配置。旧 Goal、旧 Ultra run、历史报告和截图全部保持冻结，不得改写或删除；其余产品范围、双套不变量和验收标准继续有效。

### 当前保留状态

- 保留起始 HEAD `aac01c1d78fd7c2d79b980caefad70879a1c6651`、普通合并 commit `a069f963` 及当前 HEAD `9754797828d6680926f7dc8f07984b9b86a28f98` 的完整历史。
- `git merge-base --is-ancestor 0c4b07d132f9eca63e1b4f65f6687b6b6c741bb4 HEAD` 已通过；不得重复合并、rebase、reset、cherry-pick 或 force-push。
- 旧 run `08dee484` 的 Review 在当前 HEAD 通过，但 Acceptance 因复用了 2026-09-01 启动的 18940 headless server 而失败。该进程缺少当前 HEAD 的 `product-space:getRestrictionState` handler，导致 renderer bootstrap 进入 `space-error`；这属于测试环境故障，不是放宽产品断言或缩减验收范围的理由。

### 固定 Ultra 配置

`orchestrator=claude`、`coder=opencode`、`coder-model=zhipuai-coding-plan/glm-5.3-flash`、`coder-effort=high`、`reviewer=codex`、`reviewer-model=gpt-5.6-sol`、`reviewer-effort=high`、`acceptor=pajacom`、`acceptor-model=zhipu/glm-5.3-flash`、`acceptor-effort=high`、`completion-mode=branch-ready`、`max-rounds=60`、`max-total-rounds=99`、`max-elapsed-seconds=543600`。

Provider strategy 固定；不得自动或人工切换到 fallback。

### 恢复执行要求

1. 新 workflow 从当前干净 HEAD 审计既有实现；只有发现真实代码或测试缺口时才修改业务代码，所有新 commit 继续以 `POO-42:` 开头，不得制造无意义变更来绕过门禁。
2. 对新 workflow 的最终 HEAD 重新执行完整 Review；不得把旧 run 的 Coding Pass 直接当作新 workflow 的终态 Review。
3. Acceptance 前必须使用 `.pipeline/acceptance-repair/reset-fixture-server-v8.sh` 重启 POO-42 专属 18940/18941 fixture server；执行完整 Acceptance 时设置 `POO42_CHECK_ISOLATION_CMD` 为该脚本绝对路径，使每个 check 使用当前 HEAD 的隔离 server。该脚本只能停止命令行与端口均匹配本 POO-42 fixture 的进程。
4. 重启后 `/health` 必须通过，`product-space:getRestrictionState` 不得返回 `No handler`。随后重新执行完整 Electron 功能验收与 1440/1024/390 冻结视觉验收，不得只重跑历史失败项，也不得删除、跳过或放宽任何 requirement。
5. `branch-ready` 包含任务分支普通 push、remote equality 与当前 HEAD 一致；最终 Client integration 仍由 Goal 在通过 post-merge gates 后执行。

