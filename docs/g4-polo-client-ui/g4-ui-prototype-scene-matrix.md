# G4 UI 原型：46 流程 × 场景可执行矩阵（红队修正版）

状态：2026-08-10 按红队必须修复项 #2/#3/#4 重写，替代 `g4-ui-prototype-phase0-baseline.md` 旧 §4

本文是 Phase 3/4 的逐流程施工单。每条流程给出：Before 证据分级、场景集（稳定 scene ID）、角色、fixture、交互轨迹。scene ID 在 before/after 的 `prototype-config` 中必须逐字一致。

## 0. 全局协议规则

- **Before 证据六档**：`runtime_surface`（可无后端渲染并捕获）/ `static_surface`（静态源码可忠实还原）/ `partial_surface`（有部分真实 UI）/ `ui_absent_api_present`（后端迹象存在、UI 缺失）/ `fully_absent`（完全不存在）/ `nearest_reference`（仅有最近参考页）。非 runtime 档在 manifest 记录静态提取路径。
- **能力缺失流程**（fully_absent / 大部分 nearest_reference）走 `capability-gap` bundle 模式（见 `g4-ui-prototype-contracts-addendum.md` §1）：before.html 呈现真实现有产品的诚实缺失（尝试入口 → 负证据），scene 集与 after 一致，Before 侧每个 scene 渲染"当前产品对该场景意图的真实回应"。
- **主题**：客户端 bundle `themes:["light","dark"]`；管理端 bundle **省略 themes**（不支持即省略，不造单值选择器）。
- **语言**：客户端 bundle `langs:["zh-Hans","en","de","es","hu","ja","pl"]`（与源码能力一致）；规范截图取 zh-Hans，en 做切换/缺 key/溢出抽查；管理端 bundle **省略 langs**。
- **视口**：客户端 `[desktop 1440×900, small-window 1024×768, narrow-probe 390×844]`（390 仅验证最小窗口保护/窄窗口降级，非移动端承诺）；管理端 `[desktop 1440×900, tablet 1024×768, phone 390×844]`（390 仅登录/邀请落地/状态查看/紧急确认功能完整，复杂管理页呈现"请使用桌面端"降级态）。
- **状态适用**：五标准态（normal/empty/loading/failure/restricted）按流程实际语义专门化命名（如 `terminate-failed`）；不适用者写 `N/A + 原因`，不机械填充。
- **交互轨迹**：每条流程附"真实入口→动作→分支/恢复→可观察结果"，Phase 6 Playwright 据此验收；query 只注入外部状态，不替代交互。

## 0.1 四端共享 fixture 身份（2026-08-10 按壳层实现校准，Phase 3/4 合同必须沿用）

| 端 | 固定 fixture |
| --- | --- |
| 客户端 | 账号「林然」（普通账号）；空间=我的空间 + 企业「北辰智能科技」；圈子=「桥见圈子」（认证创作者）；内置 App=Polo 助手/文件/任务与结果；作品=客户访谈整理、销售周报助手、项目交付看板、商务写作、企业知识检索、资料研究、增长顾问、素材清洗器、品牌洞察、旧版报价助手、合规审阅 |
| 企业管理端 | 企业「北辰智能科技」（主）+「远山设计工作室」（第二，切换器演示）；成员=陈曦、林妍；作品=合规文档检索、设计资产助手、数据洞察 App |
| 创作者工作台 | 创作者与成员=顾言、罗一川、叶青；圈子=「产品研究社」；作品=会议纪要助手 v1.6.0、品牌语气 Skill、数据清洗助手 v2.1.3 |
| 平台运营端 | 平台管理员「沈岚」；稳定 ID 示例=`ver_01J9Q3K7`、`bch_01H2` |

跨端叙事一致性：客户端用户「林然」是「北辰智能科技」的 Member；平台运营端治理对象包含「北辰智能科技」。各端作品名暂不强求同一套，黄金流程合同中按流程需要固定。

## 1. Polo 客户端（11 条）

### PC-F01 新用户第一次进入 Polo — partial_surface（onboarding/webui login 真实；我的空间首页真实）
场景：`login` 登录/注册；`preparing` 我的空间创建中自动重试（不建第二个）；`home-loading` 首页骨架；`home-normal` 首页正常（助手在 Apps 前部，无通用聊天框/平台级继续工作）；`home-empty` 新账号仅内置 App 的首页；`catalog-failed` 首次目录加载失败（不展示缓存）；`account-suspended` 账号暂停受限页（原因+恢复渠道）。
N/A：restricted 独立场景——账号受限即 `account-suspended`，企业受限归 PC-F07/08。
交互轨迹：打开客户端→登录→首页出现内置 App 与分区结构；断言无圈子入口、无平台级待办。

### PC-F02 在"我的空间"使用 App — partial_surface（HomePage/运行态真实；圈子来源标识缺失）
场景：`catalog-normal` 目录正常（名称/创作者/圈子来源/版本/状态）；`catalog-empty` 未添加任何 App；`app-detail` App 详情；`app-preparing` 准备中；`app-running` 运行中（可信栏：名称/来源/空间/版本/状态/权限入口）；`app-update-available` 新稳定版本发布但执行保持启动版本；`app-failed` 准备/运行失败（可理解错误+无业务内容日志入口）；`work-hidden` 隐藏单个圈子 App；`work-restore` 从圈子作品列表恢复；`work-revoked` 授权撤销/停止分发说明；`version-blocked` 平台安全阻断说明。
交互轨迹：首页→打开「访谈洞察」→可信栏显示运行态→执行任务→结果归我的空间。

### PC-F03 加入和管理创作者圈子 — fully_absent
场景：`my-circles-empty` 未加入任何圈子；`circle-invite` 从邀请链接/二维码进入（圈子/创作者/加入方式/分发内容说明）；`join-free-confirm` 免费直接加入；`join-invite-pending` 仅邀请通用链接→待 Creator Owner 审批；`join-paid-confirm` 付费：客户端说明价格/周期/续费规则并打开系统浏览器结算；`pay-processing` 支付结果未知（不重复扣款）；`price-changed-reconfirm` 确认前涨价按新价重确认；`join-success-detail` 回到客户端圈子详情并展示新获得 Apps/Skills（不自动打开/启用）；`my-circles` 我的圈子列表；`cancel-renewal` 取消续费（周期内可用到期失效）；`leave-now` 立即退出确认（剩余周期提示）；`grace-period` 续费失败宽限期；`refund-processing` 退款/拒付处理中；`circle-join-closed` 链接失效/停止加入不建关系；`already-joined` 已加入打开现有关系。
N/A：restricted——圈子侧无独立受限角色态。
交互轨迹：打开圈子邀请→客户端查看加入说明→付费时进入系统浏览器→完成后回到圈子详情，新作品出现但未自动启用。

### PC-F04 启用 Skill 并使用 Polo 助手（黄金）— partial_surface（ChatPage 真实；显式启用 UI 缺失）
POO-41 原型只冻结以下可见边界：`skills-list` / `skill-enable-confirm` / `skill-enabled` 用于确认 Skill 入口只在助手中；`assistant-home` / `chat-normal` 用于确认首页入口、助手 Tab、当前 ProductSpace 交接和复用容器。`skill-source-picker` / `skill-permission-confirm` / `skill-running` / `skill-result` / `chat-failed` / `skill-expired` / `skill-blocked` / `skills-empty` / `history-loading` 保留为真实助手组件复用后的 E2E 场景别名，不在 POO-41 静态原型另造内部状态机。
N/A：restricted——空间级受限归 PC-F07/08。
交互轨迹：首页打开 Polo 助手→作为客户端 Tab 出现→当前空间正确交接→内部没有第二套 OrganizationSwitcher、WorkspaceSwitcher、账号、目录、文件或 Browser Tab 外壳。Skill、Sources、Automations 和 Browser 的内部交互由 POO-44 基于现有助手代码复用并完成 E2E。

### PC-F05 接受企业邀请并进入企业空间 — partial_surface（客户端交接真实；落地页归 ENT-F03）
场景：`landing-reference` 邀请落地页**引用 ENT-F03 bundle**（不复制实现）；`handoff-open-client` 加入成功页引导下载/打开客户端；`client-space-appears` 客户端空间切换器出现新企业（不强制切换，不影响其他设备）；`pending-approval` 快速共享待审批（可登录客户端但无企业空间）；`invite-mismatch` 指定邀请账号不匹配提示切换；`already-member` 已是成员返回现有关系；`create-enterprise-handoff` 创建企业→管理端完成→返回客户端→新空间出现；`handoff-refresh-failed` 目录刷新失败可重试（成员关系保留，不混入个人目录）。
N/A：empty/loading 常规态归 landing 所在 bundle；restricted 无（被企业暂停见 `invite-mismatch` 类拒绝）。
交互轨迹：接受邀请后打开客户端→空间切换器出现「星图科技」→不自动切换→手动进入看到企业目录。

### PC-F06 空间安全切换 — partial_surface（OrganizationSwitcher 旧语义真实）
场景：`switcher-normal` 切换器仅我的空间+有效企业（无圈子）；`switch-running-confirm` 运行项列表+"终止全部并切换"主操作；`terminating-progress` 逐项终止状态；`terminate-failed` 失败项重试/取消，保持原空间；`terminate-cancelled` 取消后留原空间任务继续；`target-access-lost` 目标企业访问失效（移除/标记不可用）；`target-load-failed` 不显示新旧混合内容，重试或返回；`switch-success` 目录/Skills/助手/文件/权限和运行上下文整体刷新后展示目标首页；`assistant-switch` 助手中切换→目标空间助手列表/新对话（不自动打开旧对话）；助手页持续显示当前空间名。
交互轨迹：企业空间有运行中任务→发起切换→确认终止全部→逐项终止→进入我的空间首页；断言旧空间无后台运行。

### PC-F07 企业空间使用 App/Skill/助手 — partial_surface（OrganizationAppCard/组织态真实）
场景：`ent-home` 企业首页（仅已导入+启用+分发给该用户的作品）；`ent-catalog-empty` 无可消费作品；`ent-app-running` 企业身份运行（数据与结果归企业）；`ent-skills` 仅企业授权 Skills；`ent-assistant` 企业独立助手实例；`personal-no-ent-history` 切回我的空间无企业历史（对照）；`member-out-of-scope` 范围外成员目录无该 App 且旧链接不可达；`ent-context` 当前空间、Member 身份、企业数据归属和运行状态一致；`ent-restricted` 欠费/治理暂停：只读+原因+恢复路径（Member/Manager 不能绕过）。
交互轨迹：切到北辰智能科技→打开企业 App→运行→断言当前空间、Member 身份和企业数据归属一致；切回我的空间→断言无企业会话。

### PC-F08 权限或作品失效后的退出与保留 — partial_surface（SkillInfoPage 失效 UI 真实）
角色变体：Member / Manager / Owner。
场景：`member-removed` 被移除：原因+联系管理员+终止企业运行项+安全返回我的空间；`member-suspended` 被暂停同上；`ent-restricted-owner` Owner 视角：账单/导出/申诉可动；`ent-restricted-manager` Manager 只读不能绕过；`ent-closing` 关闭中只读；`work-tombstone` 失效作品保留说明（退出圈子/订阅到期/停止分发/平台阻断四种原因文案）；`history-preserved` 已导出/保存结果保留；`safe-degraded` 我的空间加载失败→安全受限页（不展示企业内容）。
交互轨迹：企业空间中成员被移除→客户端发现→停止新操作并终止运行项→回到我的空间→企业作品出现不可用说明。

### PC-F09 个人账号与管理入口 — partial_surface（settings 真实）
场景：`account-overview` 账号状态/安全/外观/通知/本机存储和授权记录；`admin-entry-owner` 显示企业组织管理端入口（浏览器打开）；`admin-entry-creator-active` 创作者工作台可写入口；`admin-entry-creator-suspended` 暂停/撤销后只读责任处理入口；`logout` 退出登录不删本地数据；`deletion-blocked` 注销阻塞摘要（Owner/Creator Owner/未结责任逐项，具体处理进入浏览器）；`session-expired` 会话失效恢复登录。
N/A：empty——账号页无空态语义。
交互轨迹：账号菜单→看到与身份匹配的管理入口→点企业入口→系统浏览器打开（非客户端 Tab）。

### PC-F10 离线和运行中断网 — static_surface（HomePage 离线行为有测试证据）
场景：`offline-home` 离线查看本机历史结果/文件/目录说明+"缓存非最新授权"提示；`offline-start-blocked` 离线禁止启动新 App/助手/AI；`running-disconnected` 运行中断网：停止新 AI/网络调用，任务"等待恢复或终止"；`reconnect-revalidate` 恢复网络重新验证空间/授权/版本后继续；`unknown-not-success` 未知结果不显示为成功；`terminate-offline` 用户终止等待中任务。
N/A：empty/restricted——离线本身即受限表达，不单列。
交互轨迹：助手任务运行中→断网→任务进入等待恢复→恢复→重新验证通过→任务继续。

### PC-F11 客户端契约不一致 — fully_absent
场景：`contract-mismatch` 阻止进入业务界面+明确升级提示；`upgrade-help` 暂无法升级只能查看帮助（不能继续可能串空间操作）；`upgrade-available` 升级入口与进度；`post-upgrade-rebuild` 旧授权/Runtime 缓存失效重建说明。
N/A：empty/loading/failure/restricted——单一场景流程，正常态即业务不可入页。
交互轨迹：启动客户端→契约校验失败→只见升级提示与帮助→无任何业务入口可点。

## 2. 企业组织管理端（12 条）

### ENT-F01 创建企业并首次进入 — fully_absent
场景：`create-form` 必要资料+付款责任确认；`creating` 原子创建中；`create-success` 企业+空间+唯一 Owner 成立→首次配置引导；`create-failed` 整体失败保留资料可重试；`validation-missing` 基础验证缺项说明；`duplicate-submit` 幂等返回同一创建结果。
N/A：empty/restricted——创建流程无对应语义。
交互轨迹：从客户端跳入创建→提交→成为唯一 Owner→管理端首次配置页→客户端空间列表出现新企业。

### ENT-F02 概览、限制与资料维护 — nearest_reference（admin dashboard 为用量统计，非同语义；以能力缺失呈现概览）
场景：`overview-normal` 企业状态+成员+目录+用量+预算+待处理异常；`overview-first-config` 未完成首次配置；`overview-loading` 骨架；`overview-failed` 加载失败可重试；`restricted-billing` 欠费：首屏原因+恢复路径+Owner 可行动作；`restricted-governance` 治理暂停；`manager-view` Manager 视角：Owner-only 操作禁用+原因；`profile-edit` Owner 修改名称/用途/设置+审计记录。
交互轨迹：Owner 进入概览→看到待办（成员未配工具）→进入对应模块；Manager 进入→删除企业按钮禁用并显示原因。

### ENT-F03 邀请成员并查看加入结果 — ui_absent_api_present（`src/lib/organizations` 有后端迹象，UI 缺失；Phase 3 核实）；**拥有公开邀请落地页/结果页的唯一所有权**
场景：`invite-create-direct` 指定邮箱/手机号（默认 7 天）；`invite-create-shared` 共享链接+二维码（有效期/人数/说明）；`invite-list` 六态（待接受/待审批/已加入/已拒绝/已过期/已撤销）；`invite-approve` 共享申请审批通过→Member；`invite-revoke` 撤销/重新生成（旧凭证立即失效）；`landing-direct` 公开落地页（企业名/邀请人/默认 Member，非 Web 工作台）；`landing-auth` 注册/登录后返回原邀请页；`landing-join-success` 加入成功→下载/打开客户端引导（手机打开给下载地址）；`landing-pending` 快速共享待审批；`landing-invalid` 过期/撤销/目标不匹配/人数用完/企业不可加入；`landing-mismatch` 登录账号不匹配提示切换受邀账号。
交互轨迹：管理端创建指定邀请→打开落地页→登录匹配账号→确认加入→成功页引导客户端；另路：共享链接→申请→管理端审批→加入。

### ENT-F04 调整成员角色和状态 — fully_absent
角色变体：Owner（可写）/ Manager（只读对照）。
场景：`member-list` 成员/角色/状态/目录影响；`action-confirm` 高风险确认+必填原因；`change-success` 立即重算管理入口/访问/作品范围/配额+审计；`manager-readonly` Manager 操作禁用+原因；`sole-owner-reject` 唯一 Owner 拒绝普通成员操作（须走转让）；`stale-page-reject` 基于旧页面提交→刷新重确认；`remove-keeps-data` 移除后企业数据归企业说明；`member-empty` 无其他成员。
交互轨迹：Owner 暂停 Member 周舟→填原因确认→列表状态即时变更→审计出现记录。

### ENT-F05 原子转让所有权 — fully_absent
场景：`transfer-select` 选择当前有效 Manager；`transfer-impact` 付款/关闭/成员治理责任转移说明；`transfer-reauth` 重新验证+确认；`transfer-success` 原子交换（新 Owner/原 Owner→Manager）+高风险审计；`target-invalid-reject` 目标非有效 Manager 拒绝；`concurrent-fail` 确认前状态变化→整体失败（不留双 Owner/无 Owner）；`no-candidate-empty` 无有效 Manager。
交互轨迹：Owner→转让→选李恪→影响确认→重新验证→双方角色原子互换。

### ENT-F06 成员组与目录分发范围 — fully_absent
场景：`group-list` 成员组列表；`group-edit` 成员加入/移出；`distribution-rule` 全员/角色/成员组可见范围配置；`saved-recalc` 保存后目录按最新关系重算（新入组自动获得组内作品）；`nested-reject` 嵌套拒绝；`cross-tenant-reject` 引用其他企业/平台对象拒绝（不产生跨企业授权）；`stale-group-block` 策略引用失效组→整次失败提示修正；`group-empty` 无成员组。
交互轨迹：创建「客服组」→加成员→给「报价助手」配客服组可见→保存→成员目录重算。

### ENT-F07 导入并检查 App/Skill（黄金）— partial_surface（organization-apps/publish 真实）
场景：`import-entry` 选择导入+上传制品+必要说明；`parsing` 解析类型/来源/版本/manifest/checksum；`checking` 统一技术+安全检查进度；`check-passed-instance` 通过→独立锁定企业实例"可配置"（未自动分发）；`check-failed` 失败原因+原检查记录保留+修复后提交新版本；`checksum-mismatch-reject` 来源缺失/checksum 不一致拒绝；`version-blocked-reject` 平台阻断版本不可导入/启用；`duplicate-import` 重复导入→返回已有实例或明确创建候选版本（不静默覆盖）；`works-empty` 无企业作品。
交互轨迹：Apps→导入→上传 ZIP→看检查分项进度→通过→出现"可配置"实例且成员目录尚无。

### ENT-F08 分发、启用和停用 — partial_surface（organization-apps 列表真实）
场景：`catalog-list` 企业实例目录与状态；`distribute-config` 全员/角色/成员组范围；`enable-success` 启用→范围内成员客户端目录可见；`out-of-scope-denied` 范围外成员旧链接不可达；`disable-confirm` 停用：停止新启动/调用，业务数据不自动删除；`re-enable-checks` 再启用仍需满足检查/治理/范围；`restricted-billing-block` 欠费/治理暂停禁新增分发与启用；`global-block-override` 平台全局阻断覆盖企业 enabled，解除后恢复原启停；`invalid-scope-block` 失效对象不发布不完整策略；`distributable-empty` 无可分发作品。
交互轨迹：选实例→配客服组可见→启用→成员侧出现；停用→成员侧不可启动但数据说明保留。

### ENT-F09 上传新包、采用与回退 — partial_surface（publish 流程真实）
场景：`version-list` 企业版本历史（上传人/采用人/时间）；`upload-candidate` 新交付包→候选版本（版本/变更说明/checksum/检查/治理状态）；`adopt-confirm` 明确采用（不自动替换）；`adopt-boundary` 已开始执行保持启动版本，新执行用新版本；`rollback` 回退到保留可运行版本；`candidate-check-failed` 未通过检查/已阻断不可采用；`stale-state-reconfirm` 页面过期状态→刷新重确认；`candidate-empty` 无候选版本。
交互轨迹：上传 v2 包→检查通过→采用→断言进行中的执行仍用 v1，新启动用 v2；再回退到 v1。

### ENT-F10 用量、预算、付款和审计 — fully_absent（审计列表 nearest_reference：admin audit-logs）
角色变体：Owner（预算/付款可写）/ Manager（只读）。
场景：`usage-overview` 总用量/费用趋势/成员或组使用/运行概况；`budget-edit` Owner 设企业级总预算/消费上限（无成员配额）；`budget-warn` 阈值预警；`budget-hard-limit` 硬限制阻止新付费执行（已开始任务完成并计费）；`billing-owner` 套餐/付款方式/账单；`payment-processing` 付款结果未知→处理中不重复扣费；`arrears-restricted` 欠费停止新执行+Owner 恢复入口；`manager-readonly` Manager 查看不可改；`audit-list` 成员/目录/预算/治理变更审计；`concurrent-budget-reject` 并发修改后提交者刷新重确认；`usage-empty` 无用量。
交互轨迹：Owner 设总预算→达到阈值出现预警→到硬限制后新执行被阻止并说明。

### ENT-F11 限时授权创作者协助排障 — fully_absent
角色：仅 Owner（Manager 只读对照）。
场景：`grant-create` 选具体 App+问题+材料+期限（≤24h）；`grant-reauth` 重新验证确认；`grant-active` 授权中（创作者仅见该次材料，界面显示真实操作者）；`grant-revoke` 提前撤销；`grant-expired` 到期自动失效，仍需排障必须重新授权；`scope-escape-denied` 超材料范围访问立即拒绝+记录；`whole-space-reject` 尝试开放整个企业空间拒绝；`grant-empty` 无有效授权。
交互轨迹：Owner 对「报价助手」某问题发起 4 小时授权→重新验证→创作者限时可见该次材料→Owner 提前撤销。

### ENT-F12 移除作品、关闭企业和恢复受限状态 — fully_absent
角色变体：Owner / Manager 分权场景（红队要求拆分）。
场景：`disable-work` Owner/Manager 停用：停止新使用，实例与业务数据保留；`remove-work-owner` Owner 移出目录（仍≠业务数据删除）；`data-deletion-status` 无通用一键删除：按 App 声明/平台人工处理，未确认存储前不得显示"已删除"；`close-start` Owner 发起 closing：停止邀请/导入/分发变更/新执行；`close-blockers` 账单/退款/所有权/数据/法务阻塞清单；`close-withdraw` 撤销关闭恢复 active；`close-platform-confirm` 平台核清后确认 closed（引用 OPS-F03）；`owner-restore-entry` Manager 提交 Owner 恢复申请入口（流程在 OPS-F04）；`governance-restricted` 治理暂停下 Owner 仅账单/导出/申诉，Manager/Member 不能绕过；`restore-original-only` 限制解除只恢复原本仍有效的成员/目录/启用状态。
交互轨迹：Owner 发起关闭→closing 页展示阻塞事项→处理账单→等待平台确认；Manager 视角全程只读。

## 3. 创作者工作台（10 条）

### CRE-F01 获得资格并首次进入 — fully_absent
场景：`first-enter` 资格状态+责任信息+允许操作；`no-default-circle` 不自动创建圈子/作品（"尚未创建圈子"）；`choose-path` 先创建作品或先创建圈子；`profile-setup` 公开资料/作品责任信息/默认数据保留声明；`restricted-suspended` 暂停：只读（圈子/作品/订单/结算/原因/申诉/导出）；`restricted-revoked` 撤销同只读；`create-blocked` 暂停/撤销期间禁止创建圈子/作品/发布。
交互轨迹：首次进入→资格状态卡→选择"创建第一个圈子"→进入 CRE-F02；暂停变体→全部写操作禁用并显示原因。

### CRE-F02 创建圈子并设置加入方式 — fully_absent
场景：`create-form` 名称/介绍/责任说明/公开信息；`mode-select` 免费/仅邀请/付费订阅三选一；`paid-pricing` 价格/周期/续费规则；`invite-tools` 定向邀请+通用链接+二维码（仅邀请的通用链接只产生待审批申请）；`created-owner` 创建成功成为该圈 Creator Owner；`qualification-lost-reject` 提交前资格失效不创建；`duplicate-submit` 幂等不产生重复圈子；`payout-incomplete` 收款资料不完整：可存草稿不可开放付费；`mode-switch-free` 无成员订单自由切换；`mode-switch-blocked` 有付费成员/订单禁直改免费/仅邀请（须关闭或新建）。
交互轨迹：创建付费圈→设价格周期→生成链接与二维码→圈子出现在列表且身份为 Creator Owner。

### CRE-F03 成员、订阅和价格 — fully_absent
场景：`member-list` 基础身份/加入时间/加入方式/会员状态；`state-filter` 五态筛选（active/grace_period/cancelled/suspended/expired）；`gift-grant` 赠送免费资格；`risk-suspend` 风险暂停+原因+按平台规则处理未用周期；`no-renewal-only` 普通经营原因只能到期不续费（不吞剩余权益）；`price-change` 提交下一周期价格（当前周期不变+提前通知+成员确认）；`price-unconfirmed-stop` 未确认成员本期结束停止续费；`refund-processing` 退款/拒付/状态不一致→处理中交平台；`content-access-denied` 读取成员余额/业务内容拒绝+记录；`member-empty` 无成员。
交互轨迹：成员列表→对风险成员暂停并填原因→其状态变 suspended；再发起涨价→显示待成员确认。

### CRE-F04 创建作品和上传版本 — partial_surface（organization-skills 创建/上传真实）
场景：`type-select` Web App / Skill；`work-identity` 稳定作品身份归创作者；`metadata-form` 名称/说明/责任信息/数据保留声明；`artifact-upload` 网站信息/ZIP 等制品；`version-form` 版本号/变更说明/运行元数据；`checksum-computed` checksum 形成不可混淆版本记录；`draft-saved` 草稿/待检查保存；`invalid-artifact` 格式/manifest/checksum 不合法保留问题不提交；`duplicate-version-reject` 重复版本号拒绝（不静默覆盖历史）；`works-empty` 无作品。
说明：页面明确不提供在线编辑器（生产边界信息呈现，非空态）。
交互轨迹：新建 Skill 作品→填元数据→传 ZIP→生成 checksum→保存为待检查版本。

### CRE-F05 自动检查和人工审批（黄金）— partial_surface（organization-skills 校验进度真实 + creator-skill-policy）
场景：`submit-check` 提交版本检查；`check-progress` 分项进度（Package/Manifest/元数据/安全策略）；`check-passed-publishable` 低风险自动通过→可发布；`manual-review-pending` 首次/高风险/异常→平台人工审批队列（审批材料展示）；`review-approved` 批准→可发布；`review-rejected` 拒绝原因+必要材料，修复后新提交不覆盖原记录；`check-failed` 禁止发布可修复重试；`check-service-error` 检查服务异常可重试（不得误标通过）；`incomplete-cannot-request` 必要检查未完成不能请求人工批准。
交互轨迹：提交 v1.2→分项逐项变绿→因首次发布进入人工审批→显示审批中→被拒→原因展示→修复后生成新提交。

### CRE-F06 发布、回退、撤回、归档和恢复 — partial_surface（归档/恢复真实）
场景：`publish-confirm` 版本号/变更说明/分发影响确认；`published-stable` 成为唯一当前稳定版本（所有分发圈子下次启动统一）；`running-pinned` 已开始执行保持启动版本；`rollback-stable` 从历史已通过检查版本重新指定当前稳定（红队补充）；`withdraw-version` 撤回版本：阻止新启动，历史保留；`archive-work` 归档：阻止所有圈子新启动+后续发布；`restore-work` 条件允许时恢复；`impact-confirm` 撤回/归档前展示全部圈子与成员影响；`no-fallback-stop` 当前稳定被撤回且无可回退→停止所有新启动；`governance-preempt` 严重风险全局阻断优先于生命周期操作。
四状态轴（作品生命周期/版本生命周期/平台检查/平台治理）在版本详情页分轴呈现。
交互轨迹：发布 v1.2 为稳定→圈子成员下次启动用它→发现问题→回退到 v1.1→v1.2 撤回。

### CRE-F07 向多个圈子分发 — fully_absent
场景：`distribute-select` 选有当前稳定版本的可运行作品；`circle-picker` 列出当前拥有圈子（多选）；`distributed-relations` 各圈子独立分发关系（指向作品不固定/不复制版本）；`member-effect` 有效成员我的空间获得授权，新启动统一解析当前稳定版本；`no-gray-version` 不允许按圈子选不同版本；`no-auto-install` 加入不自动安装/启用；`stop-one-circle` 停止单圈分发：该圈失后续启动权，他圈不受影响；`not-owner-reject` 不再拥有目标圈子不能新增/修改；`blocked-version-stop` 全局阻断不能新增分发且现有分发停止启动；`idempotent` 重复提交幂等；`distribute-empty` 无可分发作品/无圈子。
交互轨迹：「访谈洞察」分发到两个圈子→各自出现独立分发关系→停止设计工具箱→效率研究所不受影响。

### CRE-F08 经营、收入、质量和反馈 — fully_absent
场景：`overview-stats` 圈子人数/活跃资格/加入变化；`work-stats` 按作品/版本聚合启动/完成/失败+技术失败类型；`ratings` 用户主动评分与反馈数量（无平台推断质量分）；`revenue-by-circle` 分圈订阅收入/退款/拒付/待结算/可结算；`payout-account` 账号级一套收款资料，各圈核算后汇总；`feedback-list` 单次反馈（描述+用户明确附带材料/技术日志）；`feedback-reply` 更新状态+回复一次处理结果；`ledger-separation` 内容收入与个人算力账本分离；`settlement-processing` 退款/拒付/结算未知→处理中不重复调整；`access-denied` 超范围访问（成员内容/余额/单用户算力）拒绝+记录；`stats-empty` 无数据。
交互轨迹：经营页→看「访谈洞察」v1.2 完成/失败聚合→打开一条用户反馈→回复一次处理结果。

### CRE-F09 关闭圈子并处理成员权益 — fully_absent
场景：`close-start` 发起 closing；`responsibility-list` 有效成员/已付周期/退款/拒付/待结算责任；`stop-join-renew` 立即停止新加入+自动续费；`serve-till-period-end` 默认服务到已付周期结束；`early-close-refund` 提前关闭→平台处理未用周期退款；`platform-confirm-closed` 平台核清后确认 closed+停止分发（引用 OPS-F12）；`blocked-by-liabilities` 有退款/拒付/待结算责任不能确认关闭；`hard-close-reject` 绕过平台硬关闭拒绝；`active-work-impact` 仍在分发作品的停止时间与影响范围。
交互轨迹：发起关闭→closing 页→选择服务到周期末→等待平台核清→状态变 closed。

### CRE-F10 资格暂停/撤销与圈子善后 — fully_absent
角色变体：创作者 / 圈子成员 / 平台视角。
场景：`suspended-readonly` 只读：圈子/作品/订单/退款/待结算/原因；`create-publish-blocked` 禁止创建/更新/发布/新分发/新加入/续费；`appeal-single` 一条处理中治理申诉；`export` 导出责任与资产清单；`transition-deadline` 平台设过渡截止并通知创作者与成员；`member-continue` 已付成员截止前继续（错过续费不补扣）；`severe-no-transition` 严重安全风险无过渡期→立即全局阻断（引用 OPS-F10）；`handover-whole` 全部圈子和作品整体交接一个有效创作者；`close-whole` 全部关闭；`no-split` 禁止拆分交接；`restore-not-auto` 资格恢复不自动恢复已关闭圈子/独立停用/错过续费（成员需重新确认）；`member-view` 成员收到通知与过渡说明。
交互轨迹：资格被暂停→工作台只读→提交一条申诉→过渡截止后选择整体交接给指定创作者。

## 4. 平台运营端（13 条）

### OPS-F01 健康概览和行动队列 — nearest_reference（dashboard 为用量统计）
场景：`health-overview` 平台健康/企业状态/账号异常/订单与网关异常/运行故障/治理事件；`action-queue` 按影响范围/风险/时长/是否阻断排序；`event-aggregated` 同对象重复异常聚合一个事件；`event-claim` 领取→处理中（他人可见处理人，不并发重复处置）；`event-detail` 必要元数据/相关对象/已执行动作；`event-resolve` 已解决；`event-reopen` 再发生→重开或新关联事件（不静默覆盖）；`data-stale` 数据源延迟/未知明确标识（不显示为健康）；`no-content-default` 默认不展示对话/文件/App 输入输出；`queue-empty` 队列空。
交互轨迹：登录→健康卡显示 2 异常→队列领取"企业关闭"事件→详情→进入对应处理流程。

### OPS-F02 账号查询、暂停、恢复、注销阻塞 — partial_surface（users 页真实，语义不同）
场景：`account-search` 稳定标识查询；`account-detail` 状态（有效/暂停/注销冷静期/已注销）+责任摘要（Owner/Creator Owner/未结财务）；`suspend-reauth` 重新验证+原因确认；`suspend-effect` 撤登录+终止该账号发起执行（不影响同企业他成员），不删数据/关系/责任；`restore` 恢复登录资格（不自动恢复成员/圈子/治理状态，旧执行不重启）；`deletion-blockers` 注销阻塞责任清单（不借此读业务内容）；`ambiguous-reject` 对象不明确不凭相似名称执行；`concurrent-refresh` 并发状态变化刷新重确认；`termination-tracking` 不能立即停止→终止中持续处置。
交互轨迹：搜索陈然→暂停→重验证+原因→账号立即失效且其运行项终止→恢复→仅登录资格回来。

### OPS-F03 企业查询、暂停、恢复、最终关闭 — fully_absent
场景：`enterprise-search` 按稳定标识；`ent-detail` 状态/套餐/费用/Owner/健康元数据；`suspend-reauth` 影响范围+现有运行项摘要+原因；`suspend-effect` 停止新执行+作品变更+终止活动执行；Owner 保留账单/导出/申诉；`resume` 解除治理不自动重启旧任务，返回原生命周期；`closing-event` Owner 发起后行动队列出现企业关闭事件；`closing-checklist` 账单/退款/所有权/活动执行/数据导出/法务核验（不读业务内容）；`closing-blocked` 责任未清保持 closing+向 Owner 展示阻塞；`closed-confirm` 重验证确认 closed（≠物理删除）；`dual-axis` 治理暂停与欠费两独立限制轴呈现。
交互轨迹：查询星图科技→治理暂停→填原因重验证→企业受限；解除→恢复 active；closing 事件→核清→确认 closed。

### OPS-F04 恢复失效企业 Owner — fully_absent
场景：`restore-application` Manager 提交恢复申请；`verify-subject` 核验企业主体/申请人身份/当前成员状态/争议信息；`reauth-restore` 重验证+恢复依据；`restore-atomic` 原子恢复（仍唯一 Owner）+高风险审计+通知相关方；`no-verifiable-reject` 无可验证主体/有效 Manager 不恢复；`dispute-manual` 所有权争议→人工异常处理（不自动裁决）；`no-content-read` 不读企业业务内容；`application-empty` 无待处理申请。
交互轨迹：Manager 李恪申请→平台核验→重验证确认→李恪成为唯一 Owner→审计与通知。

### OPS-F05 平台工作人员账号 — nearest_reference（users 页）
场景：`staff-list` 工作人员账号/状态/最近高风险操作摘要；`grant-staff` 授予前验证目标是专用工作人员账号+重验证+原因；`revoke-staff` 撤销；`business-account-reject` 普通业务账号/带企业圈子关系拒绝叠加平台身份；`last-admin-protect` 撤销最后一个有效管理员拒绝；`concurrent-fail` 并发撤销可能无管理员→整次失败。
交互轨迹：授予新管理员→验证专用账号→重验证→生效并审计；尝试撤销最后一人→拒绝。

### OPS-F06 授予、暂停和撤销创作者资格 — nearest_reference（users/[id]）
场景：`grant-qualification` 核对线下审核结果+重验证+依据；`granted-effect` 账号获得工作台入口（不自动创建圈子）；`suspend-confirm` 资格/作品/圈子责任影响摘要+原因+处理类型；`suspend-effect` 创作/更新/发布/新分发/新加入/续费立即停止；只读保留；`transition-deadline` 非安全必设过渡截止+通知相关方；`no-backcharge` 暂停期间错过续费不补扣；`revoke-assets-route` 撤销留下无人负责资产→进入 OPS-F07 整体交接/关闭（禁拆分）；`severe-to-block` 严重安全风险→OPS-F10 全局阻断（不用普通过渡）；`restore-not-auto` 恢复资格不自动恢复已关闭圈子/独立停用/错过续费（成员重新确认）。
交互轨迹：对林澜暂停资格→设过渡截止→其圈子停止新加入→截止后资产进入 OPS-F07。

### OPS-F07 无责任人创作者资产组合 — fully_absent
场景：`ownerless-event` 行动队列出现"创作者资产无有效责任人"事件；`asset-inventory` 核验全部圈子/共享作品/成员/订阅/退款/分发/候选承接主体；`handover-whole` 整体转给一个已验证有效创作者（作品/成员/订阅/分发一次转移）；`close-whole` 全部关闭（停止新加入续费+按已付权益退款善后）；`no-split` 不允许部分转移或长期无人负责；`dispute-manual` 所有权争议/财务未清→人工异常；`severe-block-first` 严重风险先全局阻断再处理经营关系；`notify-audit` 通知受影响成员+审计。
交互轨迹：领取事件→核验资产清单→选择整体交接给创作者 X→通知成员→事件解决。

### OPS-F08 作品检查和平台政策配置 — partial_surface（creator-skill-policy 真实）
场景：`policy-current` 当前技术/安全/发布/运行政策版本；`policy-edit` 预定义配置项内修改（阈值/权限/包限制/风险分类/限额，无任意脚本）；`impact-preview` 规则影响范围+生效方式；`high-risk-reauth` 高风险政策变更重验证+原因；`severe-rule-immediate` 严重安全规则立即适用所有历史版本；`normal-rule-grace` 普通标准：新提交生效+历史整改期（逾期未过停止使用）；`conflict-reject` 配置不完整/互相冲突不能发布；`check-service-error` 规则执行异常→作品不得误标通过；`policy-rollback` 回退形成新政策版本（不删历史）；`version-history` 规则版本与变更审计。
交互轨迹：调整包大小限制→影响预览→确认发布新政策版本→历史版本可回溯。

### OPS-F09 审批首次/高风险/异常版本 — nearest_reference（app-governance 单对象表单）
场景：`approval-queue` 已过必要自动检查的待审队列；`version-detail` 稳定来源/版本/checksum/发布时认证/创作者当前资格/检查结论/审批材料；`artifact-boundary` 可读已提交版本包/包内代码资源/manifest/权限声明/检查报告（不读未提交资料与用户业务内容）；`approve` 批准→可发布；`reject` 拒绝理由→返回修复；`checks-incomplete` 必要检查未完成不能批准；`changed-during-review` 审批时版本/政策已变→重新检查/确认；`audit-evidence` 结果+证据引用不可修改审计；`queue-empty` 队列空。
交互轨迹：队列进入 v1.2→看检查报告与材料→拒绝并填理由→创作者侧出现拒绝原因。

### OPS-F10 全局阻断严重风险版本（黄金）— nearest_reference（app-governance）
场景：`risk-confirmed` 确认具体版本严重安全风险；`impact-scope` 个人圈子授权+企业实例影响范围；`block-reauth` 重新验证+安全原因+确认；`block-effect` 所有个人/企业空间立即禁止新启动/调用；`termination-progress` 安全终止进度+持续跟踪未停止执行；`history-marked` 历史结果/文件/最小记录保留+标记来源版本已阻断+禁止重跑；`notify-parties` 通知创作者/企业管理员/受影响成员；`audit-trail` 阻断与处置进展不可修改审计；`unsafe-stop-tracking` 不能安全停止→持续标记处置（不把入口隐藏当成功）；`ambiguous-reject` 标识不明确不执行（须锁定稳定作品版本 ID）；`file-quarantine` 具体危险文件另行隔离（不批量删历史）；`unblock-separate` 解除走 OPS-F11 独立恢复流程。
交互轨迹：确认 iv_2.3.1 风险→看影响范围→重验证确认阻断→新启动即停→跟踪 2 个未停止执行→通知三方圆。

### OPS-F11 普通违规、申诉、整改和解除治理 — nearest_reference（app-governance）
场景：`violation-confirm` 确认非紧急违规；`suspend-new-distribution` 暂停新分发+整改原因+截止时间；`existing-use-policy` 无风险稳定使用按决定继续/受限；`fix-submitted` 创作者修复版本/材料→重新检查；`decision-three-way` 维持/升级/解除；`appeal-submit` 责任主体提交一条处理中申诉+明确证据；`appeal-single` 每项决定一条处理中（重复提交拒绝，补充替换需确认材料范围）；`appeal-decision` 维持/修改/撤销+一次结论回复；`lift-governance` 解除只移除平台覆盖层（用户隐藏/企业停用/资格过期不变）；`still-noncompliant-reject` 不符合当前规则不能恢复；`escalate-block` 整改期出现严重风险→升级全局阻断；`concurrent-refresh` 并发治理变更后提交者刷新重确认。
交互轨迹：普通违规暂停新分发→设整改期→创作者提交修复→重新检查→解除治理→仅平台覆盖层消失。

### OPS-F12 订单、退款、拒付、账单、结算和圈子关闭 — fully_absent
场景：`order-queue-entry` 行动队列进入圈子订阅/个人算力/企业账单异常；`payment-facts` 真实付款主体/订单/权益/退款/拒付/结算状态；`ledger-separation` 圈子内容收入与个人/企业算力账本区分；`adjustment-reauth` 资金调整重验证+原因；`append-only` 幂等业务键追加退款/拒付/权益修正/结算治理（原订单与资金记录不改不删）；`compensation-credit` 补偿额度（关联事件+金额+原因）；`temp-quota` 临时配额覆盖（数值+原因+失效时间，到期恢复）；`direct-edit-reject` 直接改余额/历史用量/原订单/永久套餐拒绝；`payment-unknown` 支付未知/并发→处理中不重复退款/结算/授权；`equity-update-failed` 退款成功但权益更新失败→可恢复异常队列（不假装整体成功）；`risk-period-no-settle` 风险期不可提前转可结算；`historical-append` 历史金额错误→反向/补充追加修正；`circle-closing-check` 圈子关闭核验（已付权益/续费停止/退款/拒付/待结算/法务）；`circle-closed-confirm` 核清后确认 closed（历史保留）；`notify-audit` 结果通知相关方+审计。
交互轨迹：领取退款异常→核对付款事实→追加退款记录→权益同步更新→审计与通知。

### OPS-F13 运行异常和限时紧急内容访问 — fully_absent（审计查看 nearest_reference：audit-logs）
场景：`anomaly-list` 网关/Catalog/安装/客户端兼容/运行异常；`locate-metadata` 按账号/空间/作品版本/时间/错误元数据定位影响范围；`metadata-first` 优先无业务内容日志与状态诊断；`access-request` 数据所有方授权或重大安全事件依据；`access-reauth` 重验证+授权/安全依据记录；`scope-precise` 选具体账号/空间/App/文件/材料（拒绝整租户）；`access-window` 单次≤4 小时（到期自动失效，继续须重新发起）；`access-active` 访问中始终显示真实操作者+开始/结束通知所有方；`itemized-audit` 每次查看/下载/拒绝/撤销独立审计；`early-revoke` 数据所有方提前撤销；`missing-basis-reject` 缺重验证/原因/授权/依据拒绝；`over-limit-reject` 超 4 小时或延长原授权拒绝（须重新发起）；`no-escalate` 元数据足够诊断时不得升级内容访问；`audit-readonly` 平台管理/高风险/运行处置审计只读（不可修改）。
手机降级：紧急确认页 390×844 功能完整。
交互轨迹：网关异常定位到作品版本→元数据诊断足够→不发起内容访问；另路：获授权发起 2 小时指定文件访问→逐项审计→到期自动失效。

## 5. 红队 15 条流程缺口修正核对

PC-F02 隐藏/恢复（`work-hidden`/`work-restore`）；PC-F03 支付未知/涨价/退款（`pay-processing`/`price-changed-reconfirm`/`refund-processing`）；PC-F05 创建企业交接（`create-enterprise-handoff`）；PC-F08 三角色受限差异（`ent-restricted-owner/manager` 等）；ENT-F02 Before 指向修正为能力缺失+nearest；ENT-F06 跨租户拒绝（`cross-tenant-reject`）；ENT-F07 重复导入幂等（`duplicate-import`）；ENT-F12 角色拆分+移出≠删除（`disable-work`/`remove-work-owner`/`data-deletion-status`）；CRE-F06 回退（`rollback-stable`）；CRE-F10 成员视角/严重风险无过渡/恢复不自动（`member-view`/`severe-no-transition`/`restore-not-auto`）；OPS-F04 申请人 Manager+争议人工（`verify-subject`/`dispute-manual`）；OPS-F06 严重风险转 F10+恢复不自动（`severe-to-block`/`restore-not-auto`）；OPS-F08 规则冲突/服务异常/回退新版本（`conflict-reject`/`check-service-error`/`policy-rollback`）；OPS-F12 标题含账单+支付未知/权益失败/风险期（已补三场景）；OPS-F13 授权依据/重验证/精确对象/提前撤销/元数据足够不升级（已补五场景）。
