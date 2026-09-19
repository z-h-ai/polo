# POO-70 · MVP 完整流程高保真 — 评审指南

日期：2026-09-17 · 修订 `poo70-ux-r4-v2-7`（继承 D-PC-07/08/09，经四轮用户走查迭代收敛） · 评审壳：[prototype.html](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fprototype.html) · 产品表面：[surface.html](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fsurface.html) · 功能地图：[feature-map.md](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Ffeature-map.md) · 机器可读追溯：[prototype-manifest.json](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fprototype-manifest.json)

**评审承诺**：产品 owner 打开 prototype.html 一个入口，即可完成四条代表故事走查 + 全部模块视觉确认 + 查看本轮修订与后续输入；全程无需账号、网络、支付或真实 AI。

**本轮修订（D-PC-07 收口）**：2026-09-16 用户确认 D-PC-07 五项收口（M03 首页组合 / M04 关闭三选项 / M07 我的圈子入口 / M09 容器级积分提示 / M10 账号菜单管理入口，原文见 [user-decision-r8.md](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fsources%2Fuser-decision-r8.md)）。本轮：①11 个收口场景挂**锚定标注**（页面上直接圈出收口点，评审壳「页面说明」可逐条揭示）；②评审壳「本轮评审」绑定 D-PC-07 评审快照（现状→收口→依据→核对问题）；③清除与已确认结论冲突的旧残留——首页「系统工具」区（文件/任务与结果入口，违反 D-PC-03 与 POO-56/57 调整结论）、通知文案「结果在任务与结果查看」、「查看历史结果」更名为「查看运行记录」；④两个 HTML 按 product-ui-prototype 官方模板契约重建。**待核对直达**：[M03 首页组合](prototype.html#scene=P-M03-HOME-PERSONAL&annotation=a-m03-circle-entry) · [M04 关闭三选项](prototype.html#scene=P-M04-CLOSE-ACTIVE&annotation=a-m04-close-three) · [M07 圈子入口](prototype.html#scene=P-M07-LIST&annotation=a-m07-nav) · [M09 容器积分提示](prototype.html#scene=P-M09-APP-BANNER&annotation=a-m09-banner) · [M10 账号菜单管理入口](prototype.html#scene=P-M10-MENU&annotation=a-m10-admin-section)。

**master-r9 / D-PC-08 同步**：圈子权益只聚合到“我的空间”，企业目录不继承个人圈子且不出现圈子订阅通知；圈子私域入口覆盖分享链接、二维码、定向邀请、付费或审批，不虚构公开市场。新增 [P-M02-CONFIRM-PERSONAL](prototype.html#scene=P-M02-CONFIRM-PERSONAL)，补齐个人空间有活动时切企业的确认与取消路径。本轮状态为“修改待复看”。

**master-r10 / D-PC-09 同步**：同一作品可以分发到多个圈子，“我的空间”按作品 ID 去重并保留全部有效来源；退出或失去一个圈子只撤销该来源，其他有效来源继续支持使用；最后一个来源失效才进入不可用与恢复。修正了旧原型把圈子到期阻断显示在企业上下文的问题。受影响页面为 [作品去重](prototype.html#scene=P-M03-ALL-APPS&annotation=a-m03-multi-circle-dedupe)、[单一来源失效后继续可用](prototype.html#scene=P-M07-SOURCE-FALLBACK&annotation=a-m07-source-fallback)、[圈子到期但另有来源](prototype.html#scene=P-M07-EXPIRED)、[最后来源失效](prototype.html#scene=P-M11-BLOCKED-EXPIRED) 和 [企业无圈子泄漏](prototype.html#scene=P-M03-HOME-ENT)。

**产品表面内容边界收口**：本轮按“原型不是 PRD”的要求，把所有说明性、设计性、开发性内容从产品表面移到评审壳/说明：①移除 44 个「分支：」虚线评审按钮（连同 `scenario-strip`/`scenario-jump` 样式），原本靠这些按钮可达的 35 个失败/取消/交接状态改为 `review_entries` 独立评审入口（评审壳「本轮评审」或直达链接进入，不计入产品操作）；②故事 2/3 中三处系统触发状态（`P-M02-STOP-FAILED`、`P-M01-REOPEN`、`P-M09-STREAM-CUT`）的 story step 改 `arrival: review`，由评审入口进入而非伪造产品按钮；③清理 `FDE 工作区` 标题与「内部界面归 App 开发者」「逐项终止后才会提交切换」「创建在浏览器端完成且幂等」「支付在浏览器完成；桌面端只发起并确认结果」等机制/责任文案——这些说明移到对应场景的 `annotation`（评审壳「页面说明」可见），**独立语义审查后的补充清理**：独立审查员复查后发现产品表面仍有机制/责任/设计理由文案残留，第二轮清理：①13 个 M10/M11 场景的 toast 尾注「· 责任以后台数据为准」移除（保留「已重新核对管理资格」状态结果），责任说明移 annotation；②4 处「幂等」术语改写为用户语「可以安全重试…」（P-M01-PERSONAL-PREP / PREP-FAIL / P-M04-PREP-FAILED / P-M11-CONTRACT-FAIL）；③P-M01-COLD-START 删「不自动切换空间」、P-M10-SETTINGS 删「· 独立登录」「· 偏好随账号，不随空间」「· 运行任务原地等待」、P-M10-SETTINGS-APPEARANCE 删「个人偏好随账号，不随空间」、P-M09-NOT-YET/CHECKING/RESUMED 删「保持阻断」「不重复发起多次查询」「不会自动发送会话草稿」「不会自动发送或续写」、P-M04-APP-VIEW 等删「· 切换标签不中断」、P-M07-PAY-RETURN-FAIL 删「；确认前不会显示「已到期」」、P-M03-HOME-LOAD-FAIL 删「· 重试不会产生重复内容」、P-M01-INVITE-MISMATCH 改「不交给错误账号」→「请切换到受邀账号」——这些非动作保证/作用域机制说明均移至对应场景 annotation。**第三轮（独立审查同义改写残留）**：独立审查员第二轮复查发现 18 个硬词虽清零，但可见区仍残留同义改写的类别 4 非动作保证文案与类别 2 机制/流程说明（硬词清单未覆盖），逐项清理：①P-M01-PERSONAL-PREP/PREP-FAIL 删「不会重复创建」「无副作用」（改「本次未写入」）；②P-M02-CONFIRM/CONFIRM-PERSONAL/STOP-FAILED/STOP-CANCEL/TARGET-FAILED 删「已终止的项不会自动恢复」「保持停止」等不自动恢复/保持停止保证；③P-M02-STOPPING「全部停止后才提交切换」改「请稍候」、P-M02-TARGET-LOADING「一起加载；不展示混合内容」改「正在加载目录、权限与助手」；④P-M03-INSPECTOR/P-M11-PERSONAL-RESTRICTED 删「不归因」；⑤P-M11-CONTRACT「最低版本阻断企业空间」改用户视角「当前版本无法使用企业空间」；⑥P-M04-TERM-FAILED 删「标签已保留」「标签保留并可重试」；⑦P-M11-BLOCKED-EXPIRED 删「不需要重复安装」、P-M01-LOGIN-CANCEL 删「未产生任何副作用」——全部移至对应场景 annotation。另清 2 条含「评审/分支/POO-71」的 CSS 注释。产品表面只保留用户当下需要读、会点击、会感知的内容。当前状态为“修改待复看”。


**ux-r1 / 用户走查迭代（poo70-ux-r1-v2-5）**：5 名模拟用户（2 名小白 / 3 名目标用户）走查全部 11 个模块流程，产出 93 条反馈（正面 30 / 负面 63），由 PM 评审归并为 19 项修复与 11 个新场景（92→103 场景，1539 条 transitions）。修复重点：①跨空间上下文统一（C-R03）——新增个人 App 容器、个人运行中心、个人助手会话与个人方向切换器，7 处个人「打开」不再落入企业「报价整理」，充值链整链落在个人空间（PC-N03：Member 不能自费充值）；②状态账目可判读（C-R04）——取消切换与终止并关闭各有独立落态首页（1 项 / 2 项运行中账目式），后台继续计数修正，首登零状态删除运行 pill 并新增零常用版全部 Apps；③恢复链闭合——升级失败改为可达（演示注入）、下载完成先过重开恢复核对（C-R05）、新增支持请求交接卡、版本阻断给联系管理员出路、离线两屏重试行为一致、被阻断 App 的标签激活改自环；④圈子线（PC-F03 / D-PC-09）——到期续费起算日立即生效（与有效期内续费区分）、付费圈补退出链、来源撤销后作品账目改写（已退出圈不可用 + 重新加入路径）；⑤全局卫生——无关场景的「已在后台继续运行」toast（38→1）与「已重新核对管理资格」（13→1）清理、「（不假装完成）」元语言改写、术语统一（Skill→技能、角色词中文化）、死按钮接线（权限弹窗 ×/暂不打开、生成中断发送禁用、登录取消改走密码流程、验证码重发演示注入）。故事路径同步：故事 1 步 4 → ALL-APPS-ZERO；故事 2 步 8 → AFTER-CANCEL；故事 3 起讫 → CHAT-PERSONAL。11 个新场景：P-M02-SWITCHER-PERSONAL、P-M03-HOME-ENT-AFTER-CANCEL、P-M03-HOME-ENT-AFTER-CLOSE、P-M03-ALL-APPS-ZERO、P-M04-APP-VIEW-PERSONAL、P-M04-RUNTIME-PERSONAL、P-M05-CHAT-PERSONAL、P-M07-RENEW-EXPIRED、P-M07-LEAVE-PAID、P-M07-DETAIL-PAID-AFTER-LEAVE、P-M11-SUPPORT-BROWSER。本轮状态为「修改待复看」。

**ux-r3 / 收敛轮（poo70-ux-r3-v2-6）**：R2 五名复测用户确认 19 项修复中绝大多数生效（含 1 个本轮引入的标签失衡 blocker，已修复并加全文标签平衡校验与 106 屏首屏渲染回归门）。按 PM 收敛判定：①新增个人技能/数据源/会话文件 3 个变体场景，个人助手衍生入口全程不跨空间（C-R03）；②个人会话 composer 补「发送→发送前阻断」正序与行内「停止」（PC-N03）；③ACCESS-LOST 按唯一直达入口改个人上下文；④ENT-EMPTY 企业身份收尾；⑤首登圈子线 4 屏删运行 pill、JOIN-FREE 背景未加入态；⑥DETAIL-PAID 增「（演示）模拟到期」；⑦文案统一包 8 处。8 项判定不改（中性容器口径、切换只终止源空间、演示粒度等）并写入场景 annotation；术语表 3 条（Skill 保留英文、角色词括注、圈子主≠企业所有者）。本轮状态为「修改待复看」。

**ux-r4 / 收敛修复与点验（poo70-ux-r4-v2-7）**：R3 复测 10 条负面全清（三个个人变体场景顶栏徽标、ACCESS-LOST 背景与主内容个人化、ENT-EMPTY 导航企业向、OFFLINE-RUNNING 重试语义、HOME-EMPTY-DIR 运行 pill、PRE-BLOCK 生成中行、LEAVE-PAID 背景重建）；终验再清 3 条（NEW 三处 chip、JOIN-FREE 到期字样）；点验轮唯一残留（NEW「发送」未接线）修复后由独立验收员确认**无负面反馈（0 条）**，迭代循环收敛。HOME-PERSONAL 演示状态口径与术语表已写入 annotation。

**v2 契约说明**：本卡按 product-ui-prototype v2 契约构建——`surface.html` 是纯产品表面（106 场景、1601 条 transitions 全部静态声明，无演示控制代码；44 条「分支：」评审按钮已移除，对应失败/取消状态改由 review_entries 进入）；`prototype.html` 是官方评审壳，用 iframe 按真实视口加载 surface，集中放页面索引、页面说明、锚定标注揭示、本轮评审、故事播放与视口切换。两文件均离线零网络请求，场景内容与 POO-41 G4 冻结稿、POO-70 已确认结论逐条绑定（manifest `sources`/`confirmations` 含 sha256 快照）。

---

## 1. 三分钟上手

1. **打开**：浏览器（Chrome/Edge/Safari 均可）直接打开 `prototype.html`；完全离线，无任何网络请求。
2. **两种形态**：
   - 评审形态（prototype.html）：右侧检查器有三个标签——**页面索引**（按 11 模块分组跳转）、**页面说明**（当前屏 ID/分类/依据/需求节点）、**本轮评审**（现状→本轮差异→依据→下一次复看问题）；顶部有**故事**下拉（四条代表故事播放）与**视口**下拉（1440×900 / 1024×768 真实视口切换）。
   - 纯净形态：直接打开 [surface.html](surface.html)（如 `surface.html?scene=P-M03-HOME-PERSONAL`）——无任何评审 chrome，即产品表面本身；正式截图均在此形态拍摄。
3. **导航**：点屏内任何产品按钮跳转（surface 运行时会校验「当前场景的已声明 transitions」，无效跳转被忽略）；检查器顶部 **Back**/**Reset** 按钮回退浏览历史 / 回到起始屏。
4. **直达**：任何屏都可用 `#scene=<屏 ID>` 直达（索引见 §3）。
5. **演示注入**：部分屏用「（演示）」按钮模拟后端事件（如积分到账、停止失败）；标注为注入点，代表真实实现里的服务端回调。
6. **评审入口（review_entries）**：无自然产品入口的失败/取消/系统触发状态（如登录取消、准备失败、最后来源失效）不再以「分支：」虚线按钮出现在产品表面，而是登记为 `review_entries`——评审壳直达链接 `#scene=<ID>` 或「本轮评审」进入。验收时这些不计入产品操作；故事 2/3 中三处系统触发状态（`P-M02-STOP-FAILED`、`P-M01-REOPEN`、`P-M09-STREAM-CUT`）由评审入口进入，不伪造产品按钮。

## 2. 四条代表故事（连续点击走通）

四条故事对应评审壳顶部的「故事」下拉（故事 1—4），进入后可 `←`/`→` 步进、自动跟随产品点击同步；下表给出同样的路径与每步验证点。故事四专门走查 D-PC-09 的逐来源变化，后三步由评审入口进入系统状态，不伪造产品按钮。

### 故事 1 · 首登加入企业并使用（M01 → M03 → M04 → M05 → M08）

目标：验证「首登一定有可用的我的空间；企业加入不阻塞个人使用」。

| 步 | 操作 | 到达屏 | 你会看到 / 验证点 |
| --- | --- | --- | --- |
| 1 | 打开原型，进入登录页 | [P-M01-LOGIN-PASSWORD](prototype.html#scene=P-M01-LOGIN-PASSWORD) | G4 login-split 双栏：品牌故事 + 登录方式切换（密码/验证码）+ 协议说明，与 POO-41 冻结稿同构 |
| 2 | 输入账号密码，点「登录」 | [P-M01-PERSONAL-PREP](prototype.html#scene=P-M01-PERSONAL-PREP) | 唯一的“我的空间”准备中；重试幂等，不产生第二个空间 |
| 3 | 准备完成自动进入首页 | [P-M03-HOME-ZERO](prototype.html#scene=P-M03-HOME-ZERO) | 首登零常用：Polo 助手始终可用，并引导“全部 Apps” |
| 4 | 点「去全部 Apps 挑选」 | [P-M03-ALL-APPS-ZERO](prototype.html#scene=P-M03-ALL-APPS-ZERO) | 首登零常用目录：无“移出首页”、账目干净；同一作品只显示一次并保留全部来源（D-PC-09） |
| 5 | 使用后回个人首页 | [P-M03-HOME-PERSONAL](prototype.html#scene=P-M03-HOME-PERSONAL) | Polo 助手固定；常用 Apps 来自个人已有权益；“我的圈子”管理关系 |
| 6 | 选择“晨星科技”且个人有运行项 | [P-M02-CONFIRM-PERSONAL](prototype.html#scene=P-M02-CONFIRM-PERSONAL) | 先说明将终止的个人空间活动；取消仍在个人空间，确认后才切换 |
| 7 | 进入企业首页 | [P-M03-HOME-ENT](prototype.html#scene=P-M03-HOME-ENT) | 只展示企业导入、启用并向本人分发的作品，不出现个人圈子或圈子通知 |
| 8 | 打开有更新的 App | [P-M04-PREPARE](prototype.html#scene=P-M04-PREPARE) | 权限说明 + 下载校验；可取消，准备成功后再打开 |
| 9 | 使用 App | [P-M04-APP-VIEW](prototype.html#scene=P-M04-APP-VIEW) | App 占满主内容工作区；FDE 区域为中性占位，业务结果由 App 负责 |
| 10 | 查看运行状态 | [P-M04-RUNTIME](prototype.html#scene=P-M04-RUNTIME) | 只列当前企业空间的 App/助手活动 |
| 11 | 打开 Polo 助手 | [P-M05-CHAT](prototype.html#scene=P-M05-CHAT) | G4 三栏助手框架；当前空间的会话、Skills 与计量主体一致 |
| 12 | 打开会话文件 | [P-M08-FILES](prototype.html#scene=P-M08-FILES) | 附件与生成文件留在原对话；无独立文件汇总页 |

变体分支：

| 变体 | 走法 | 落点屏 | 关键行为 |
| --- | --- | --- | --- |
| 主要失败 · 加入后刷新失败 | 邀请确认 → 确认加入 → 桌面刷新失败 | [P-M01-REFRESH-FAIL](prototype.html#scene=P-M01-REFRESH-FAIL) | 成员关系已保留；核对同账号后重试即可，不需要重新接受邀请 |
| 主要失败 · 空间准备失败 | 登录成功 → 准备失败 | [P-M01-PERSONAL-PREP-FAIL](prototype.html#scene=P-M01-PERSONAL-PREP-FAIL) | 给重试入口并说明幂等；不阻塞重新登录 |
| 取消中断 · 登录取消 | 登录页点「取消」 | [P-M01-LOGIN-CANCEL](prototype.html#scene=P-M01-LOGIN-CANCEL) | 留在登录入口可重试，不产生副作用 |
| 邀请 · 账号不匹配 | 浏览器中用非受邀账号打开邀请 | [P-M01-INVITE-MISMATCH](prototype.html#scene=P-M01-INVITE-MISMATCH) | 邀请不交给错误账号；改用受邀账号后才能接受 |
| 邀请 · 待审批 | 接受共享邀请后等审批 | [P-M01-INVITE-PENDING](prototype.html#scene=P-M01-INVITE-PENDING) | 批准前企业不出现在可用空间；审批不是用户能跳过的 |
| 会话过期 | 任意桌面屏 → 会话过期 | [P-M11-REAUTH](prototype.html#scene=P-M11-REAUTH) | 要求重新登录后恢复；不自动执行过期前的原动作 |
| 客户端重开 | 重开 Polo | [P-M01-REOPEN](prototype.html#scene=P-M01-REOPEN) → [P-M11-REOPEN-RECOVERY](prototype.html#scene=P-M11-REOPEN-RECOVERY) | 恢复身份并重验访问权；不重发旧请求、不把中断猜成完成 |
| 跨端 · 创建企业 | 账号菜单 → 创建企业 | [P-M01-CREATE-ENT](prototype.html#scene=P-M01-CREATE-ENT) → [P-M02-SWITCHER](prototype.html#scene=P-M02-SWITCHER) | 创建在浏览器完成且幂等；回到桌面后企业出现在切换器里 |

### 故事 2 · 日常切换空间（部分停止失败）（M03 → M04 → M02）

目标：验证「切空间先讲清代价；部分失败可恢复、可取消，且不产生半状态」。

| 步 | 操作 | 到达屏 | 你会看到 / 验证点 |
| --- | --- | --- | --- |
| 1 | 打开原型，进入企业空间首页 | [P-M03-HOME-ENT](prototype.html#scene=P-M03-HOME-ENT) | 晨星科技首页，运行中 3 项；按 D-PC-07 不放管理卡，管理入口只在账号菜单 |
| 2 | 点顶栏「运行」入口 | [P-M04-RUNTIME](prototype.html#scene=P-M04-RUNTIME) | 运行状态中心按空间列 App 任务与助手生成，含逐项停止 |
| 3 | 点顶栏空间切换器 | [P-M02-SWITCHER](prototype.html#scene=P-M02-SWITCHER) | 集成候选真实组件：列表含我的空间 + 可用企业，当前项高亮 |
| 4 | 选「我的空间」 | [P-M02-CONFIRM](prototype.html#scene=P-M02-CONFIRM) | 确认框列出将被终止的 3 项（App ×2 + 助手生成 ×1），取消留在原空间 |
| 5 | 点「终止并切换」 | [P-M02-STOPPING](prototype.html#scene=P-M02-STOPPING) | 逐项停止中；全部停止后才提交切换 |
| 6 | 注入失败（演示） | [P-M02-STOP-FAILED](prototype.html#scene=P-M02-STOP-FAILED) | 1 项停止失败：可重试失败项或取消；已终止项不自动复活 |
| 7 | 点「取消切换」 | [P-M02-STOP-CANCEL](prototype.html#scene=P-M02-STOP-CANCEL) | 留在晨星科技；已完成的停止不回滚（顶栏 1 项运行中=停止失败项）——这是本故事的核心规则 |
| 8 | 点「返回首页」 | [P-M03-HOME-ENT-AFTER-CANCEL](prototype.html#scene=P-M03-HOME-ENT-AFTER-CANCEL) | 落点账目可判读：2 个 App 已终止可重新打开，仅停止失败的助手项仍运行 |
| 8 | 点「后台继续」后从顶栏运行入口查看 | [P-M04-BACKGROUND](prototype.html#scene=P-M04-BACKGROUND) | 改为后台继续：顶栏保留运行 pill 入口，任务在后台不丢 |

变体分支：

| 变体 | 走法 | 落点屏 | 关键行为 |
| --- | --- | --- | --- |
| 成功切换（对照） | 确认后全部停止成功 | [P-M02-TARGET-LOADING](prototype.html#scene=P-M02-TARGET-LOADING) → [P-M03-HOME-PERSONAL](prototype.html#scene=P-M03-HOME-PERSONAL) | 目录/权限/计量/助手集合一起切换；不展示混合内容 |
| 目标加载失败 | 切换提交后目标加载失败 | [P-M02-TARGET-FAILED](prototype.html#scene=P-M02-TARGET-FAILED) | 重试加载或留在原空间；已停止的任务保持停止 |
| 无权目标 | 目标空间权限被回收后切换 | [P-M02-ACCESS-LOST](prototype.html#scene=P-M02-ACCESS-LOST) | 已从切换器移除并说明原因；联系管理员恢复 |
| 会话过期 | 切换过程中会话过期 | [P-M11-REAUTH](prototype.html#scene=P-M11-REAUTH) | 重新登录后不自动续切；重新核对候选目标 |
| 客户端重开 | 切换后重开 Polo | [P-M01-REOPEN](prototype.html#scene=P-M01-REOPEN) → [P-M11-REOPEN-RECOVERY](prototype.html#scene=P-M11-REOPEN-RECOVERY) | 恢复身份、重验空间权限；停留在安全入口 |
| 跨端 · 企业后台返回 | 账号菜单 → 企业管理后台 → 返回 | [P-M10-ADMIN-BROWSER](prototype.html#scene=P-M10-ADMIN-BROWSER) → [P-M10-ADMIN-RETURN](prototype.html#scene=P-M10-ADMIN-RETURN) | 后台在浏览器独立登录；返回后重新核对资格，不沿用旧判断 |

### 故事 3 · 积分不足 → 浏览器处理 → 主动单次查询（M05 → M09）

目标：验证「不足时容器级提示、不丢内容；充值走浏览器；到账后由用户决定是否继续」。

| 步 | 操作 | 到达屏 | 你会看到 / 验证点 |
| --- | --- | --- | --- |
| 1 | 打开原型，进入助手会话 | [P-M05-CHAT-PERSONAL](prototype.html#scene=P-M05-CHAT-PERSONAL) | 小王在「我的空间」让助手按客户分组整理报价汇总（含自己的消息气泡）；充值链按 PC-N03 落在个人空间 |
| 2 | 把问题补全后点「发送」 | [P-M09-PRE-BLOCK](prototype.html#scene=P-M09-PRE-BLOCK) | 发送前积分不足：输入完整保留、发送不可用、原因与去充值入口同屏 |
| 3 | 点「去充值」 | [P-M09-BROWSER](prototype.html#scene=P-M09-BROWSER) | 浏览器交接卡：桌面只发起与确认结果，支付在浏览器完成 |
| 4 | 回到 Polo | [P-M09-CHECKING](prototype.html#scene=P-M09-CHECKING) | 只做一次到账查询；会话、草稿与部分输出全部保留 |
| 5 | 点「再查一次」（演示未到账） | [P-M09-NOT-YET](prototype.html#scene=P-M09-NOT-YET) | 未到账：保持阻断、不丢内容；可再查或稍后再说 |
| 6 | 注入到账（演示） | [P-M09-RESUMED](prototype.html#scene=P-M09-RESUMED) | 到账解除阻断，但不自动发送/续写——是否继续由用户决定 |
| 7 | 点「继续发送」 | [P-M05-CHAT-PERSONAL](prototype.html#scene=P-M05-CHAT-PERSONAL) | 回到个人空间会话，不切企业；小王自己点发送，接着刚才的整理继续 |

变体分支：

| 变体 | 走法 | 落点屏 | 关键行为 |
| --- | --- | --- | --- |
| 生成中不足 | 生成进行到一半积分耗尽 | [P-M09-STREAM-CUT](prototype.html#scene=P-M09-STREAM-CUT) | 保留已生成部分并如实标注中断原因；不静默丢弃 |
| App 内提示 | 在 App 容器内触发积分不足 | [P-M09-APP-BANNER](prototype.html#scene=P-M09-APP-BANNER) | 只用非模态横幅，不打断 App 内操作 |
| 企业 Member | 企业空间 Member 触发不足 | [P-M09-ENT-NOTIFY](prototype.html#scene=P-M09-ENT-NOTIFY) | 通知 Owner 处理额度，不代 Member 做充值裁决 |
| 用户主动停止 | 生成中点「停止」 | [P-M09-USER-STOP](prototype.html#scene=P-M09-USER-STOP) | 与积分不足分开展示：停止是用户意图，不足是平台状态 |
| 未到账（主路径已含） | 返回后第一次查询未到账 | [P-M09-NOT-YET](prototype.html#scene=P-M09-NOT-YET) | 保持阻断、可再查；查询不产生副作用 |
| 会话过期 | 充值返回时会话已过期 | [P-M11-REAUTH](prototype.html#scene=P-M11-REAUTH) → [P-M09-CHECKING](prototype.html#scene=P-M09-CHECKING) | 重新登录后再查到账；草稿与会话保留 |
| 跨端 · 圈子支付 | 圈子续费 → 浏览器支付 → 返回 | [P-M07-PAY-BROWSER](prototype.html#scene=P-M07-PAY-BROWSER) → [P-M07-PAY-RETURN-FAIL](prototype.html#scene=P-M07-PAY-RETURN-FAIL) | 支付成功只是浏览器端事实；桌面需同账号验证后刷新订阅状态 |

### 故事 4 · 多圈授权去重与逐来源失效（M03 → M07 → M11）

目标：验证“同一作品只显示一次；单一来源失效仍可用；最后来源失效才阻断；企业无个人圈子来源”。

| 步 | 操作 / 评审进入 | 到达屏 | 你会看到 / 验证点 |
| --- | --- | --- | --- |
| 1 | 从我的空间打开全部 Apps | [P-M03-ALL-APPS](prototype.html#scene=P-M03-ALL-APPS&annotation=a-m03-multi-circle-dedupe) | 同一创作者“晨星增长工作室”的“会议纪要整理”只显示一次，来源行为晨星增长圈 + 晨星设计圈 |
| 2 | 查看晨星增长圈详情 | [P-M07-DETAIL-FOCUS](prototype.html#scene=P-M07-DETAIL-FOCUS) | 圈子关系与作品授权来源分开呈现 |
| 3 | 点管理成员资格并确认退出 | [P-M07-LEAVE](prototype.html#scene=P-M07-LEAVE) | 确认框说明只撤销本圈来源，另一个有效来源继续支持访问 |
| 4 | 确认退出 | [P-M07-SOURCE-FALLBACK](prototype.html#scene=P-M07-SOURCE-FALLBACK&annotation=a-m07-source-fallback) | 同一作品仍只显示一次，并明确晨星设计圈仍有效 |
| 5 | 评审进入“一个圈子到期” | [P-M07-EXPIRED](prototype.html#scene=P-M07-EXPIRED) | 独有作品需续费；共同授权的“会议纪要整理”仍可打开 |
| 6 | 评审进入“最后来源失效” | [P-M11-BLOCKED-EXPIRED](prototype.html#scene=P-M11-BLOCKED-EXPIRED) | 两个来源都无效后才阻断；恢复任一来源即可重新打开 |
| 7 | 评审进入企业首页 | [P-M03-HOME-ENT](prototype.html#scene=P-M03-HOME-ENT) | 只出现企业内部导入作品，无“我的圈子”及个人授权来源 |

## 3. 页面索引（106 屏全量）

以下 ID 均可用 `#scene=<ID>` 直达（评审壳或 surface 直开均可）。106 场景通过产品操作或 35 个 review_entries 评审入口覆盖；「分类」见图例（[feature-map.md §1](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Ffeature-map.md)）。

### M01 登录与空间承接（14 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M01-LOGIN-PASSWORD](prototype.html#scene=P-M01-LOGIN-PASSWORD) | 登录 · 密码登录 | 直接复用 | G4 login-split 直接复用：品牌故事、登录方式切换、协议说明均为冻结稿样式。 |
| [P-M01-LOGIN-PHONE](prototype.html#scene=P-M01-LOGIN-PHONE) | 登录 · 验证码登录 | 直接复用 | 验证码登录分段复用；“+86 / 发送验证码 / 5 分钟有效”为现有文案。 |
| [P-M01-LOGIN-CODE](prototype.html#scene=P-M01-LOGIN-CODE) | 登录 · 验证码已发送 | 直接复用 | 倒计时重发属于现有行为；验证码错误会内联提示，不弹窗。 |
| [P-M01-LOGIN-CANCEL](prototype.html#scene=P-M01-LOGIN-CANCEL) | 登录 · 用户取消 | 已有状态 / 行为 | 取消后留在登录入口并可重试；不产生副作用（C-R08）。 |
| [P-M01-PERSONAL-PREP](prototype.html#scene=P-M01-PERSONAL-PREP) | 我的空间 · 准备中 | 调整关键页 | 唯一「我的空间」幂等创建；重试不产生第二个空间（PC-F01）。 |
| [P-M01-PERSONAL-PREP-FAIL](prototype.html#scene=P-M01-PERSONAL-PREP-FAIL) | 我的空间 · 准备失败 | 调整关键页 | 准备失败给出重试入口并说明幂等；不阻塞重新登录。 |
| [P-M01-REOPEN](prototype.html#scene=P-M01-REOPEN) | 重开 · 登录恢复 | 已有状态 / 行为 | 过期会话要求重新登录；恢复后核对访问权，不自动重做业务动作。 |
| [P-M01-INVITE-BROWSER](prototype.html#scene=P-M01-INVITE-BROWSER) | 邀请确认（浏览器交接） | 跨端交接 | 浏览器端只画交接卡；加入成功仅作为桌面刷新的输入（PC-F05）。 |
| [P-M01-INVITE-MISMATCH](prototype.html#scene=P-M01-INVITE-MISMATCH) | 邀请 · 账号不匹配 | 跨端交接 | 邀请不交给错误账号；改用受邀账号后才能接受。 |
| [P-M01-INVITE-PENDING](prototype.html#scene=P-M01-INVITE-PENDING) | 共享邀请 · 待审批 | 跨端交接 | 共享邀请需 Owner/Manager 审批；批准前企业不出现在可用空间。 |
| [P-M01-REFRESH-FAIL](prototype.html#scene=P-M01-REFRESH-FAIL) | 加入后 · 企业列表刷新失败 | 已有状态 / 行为 | 成员关系已保留；核对同账号后重试，不需要重新接受邀请（C-R01）。 |
| [P-M01-NOT-INSTALLED](prototype.html#scene=P-M01-NOT-INSTALLED) | 未安装 · 下载指引 | 跨端交接 | 同账号登录后企业出现在空间列表；不强制立即安装。 |
| [P-M01-CREATE-ENT](prototype.html#scene=P-M01-CREATE-ENT) | 创建企业（浏览器交接） | 跨端交接 | 创建在浏览器端完成且幂等；进入与否由用户在桌面端决定（PC-F07）。 |
| [P-M01-COLD-START](prototype.html#scene=P-M01-COLD-START) | 冷启动 · 候选目标重验 | 已有状态 / 行为 | 冷启动重验账号/邀请/空间列表；不自动切换空间。 |

### M02 空间切换（10 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M02-SWITCHER](prototype.html#scene=P-M02-SWITCHER) | 空间切换器（下拉） | 集成候选已实现 | 集成候选真实组件：无活动直切，有活动进入确认；切换只影响本机。 |
| [P-M02-CONFIRM](prototype.html#scene=P-M02-CONFIRM) | 切换确认 · 终止 3 项 | 集成候选已实现 | 展示将终止的 App 与助手任务；取消留在原空间（C-R04）。 |
| [P-M02-CONFIRM-PERSONAL](prototype.html#scene=P-M02-CONFIRM-PERSONAL) | 切换确认 · 从我的空间到企业 | 调整关键页 | 个人空间有活动时先确认终止；取消留在我的空间，确认后才进入企业（D-PC-08 / C-R04）。 |
| [P-M02-STOPPING](prototype.html#scene=P-M02-STOPPING) | 终止进度 | 集成候选已实现 | 逐项展示已终止/停止中；全部停止后才提交切换（PC-F06）。 |
| [P-M02-STOP-FAILED](prototype.html#scene=P-M02-STOP-FAILED) | 部分停止失败 | 集成候选已实现 | 1 项失败：重试失败项或取消；已终止项不自动复活（C-R04）。 |
| [P-M02-STOP-CANCEL](prototype.html#scene=P-M02-STOP-CANCEL) | 取消切换 · 仍在原空间 | 集成候选已实现 | 取消的是切换，不撤销已完成的停止——这是关键规则。 |
| [P-M02-TARGET-LOADING](prototype.html#scene=P-M02-TARGET-LOADING) | 目标空间加载中 | 集成候选已实现 | 目录、权限、计量与助手集合一起切换；不展示混合内容。 |
| [P-M02-TARGET-FAILED](prototype.html#scene=P-M02-TARGET-FAILED) | 目标空间加载失败 | 集成候选已实现 | 重试加载或留在原空间；已停止任务保持停止。 |
| [P-M02-ACCESS-LOST](prototype.html#scene=P-M02-ACCESS-LOST) | 目标无权访问 | 集成候选已实现 | 已从切换器移除并说明原因；联系管理员恢复（C-R05）。 |
| [P-M02-SWITCHER-PERSONAL](prototype.html#scene=P-M02-SWITCHER-PERSONAL) | 空间切换器 · 从我的空间打开 | 新增 / 构想 | 个人方向切换：无权目标保留原因说明（C-R05）；有活动切企业先确认（PC-F06）。 |
### M03 首页与全部 Apps（14 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M03-HOME-PERSONAL](prototype.html#scene=P-M03-HOME-PERSONAL) | 首页 · 个人空间（有常用） | 调整关键页 | 固定 Polo 助手 + 最多 5 个常用 App；“我的圈子”与“全部 Apps”并列（D-PC-07 · D-PC-01）。 |
| [P-M03-HOME-ZERO](prototype.html#scene=P-M03-HOME-ZERO) | 首页 · 首登零常用 | 调整关键页 | 零常用引导去全部 Apps；助手卡始终可用，不强迫先配置。 |
| [P-M03-HOME-EMPTY-DIR](prototype.html#scene=P-M03-HOME-EMPTY-DIR) | 首页 · 真空目录 | 调整关键页 | 企业未分发且圈子无作品时的诚实空态，说明何时会出现内容。 |
| [P-M03-HOME-LOAD-FAIL](prototype.html#scene=P-M03-HOME-LOAD-FAIL) | 首页 · 目录加载失败 | 已有状态 / 行为 | 目录失败不阻塞助手；重试幂等（C-R01）。 |
| [P-M03-HOME-OFFLINE](prototype.html#scene=P-M03-HOME-OFFLINE) | 首页 · 离线缓存目录 | 已有状态 / 行为 | 缓存目录标注获取时间；已安装可打开，未安装/更新不可用（C-R07）。 |
| [P-M03-HOME-ENT](prototype.html#scene=P-M03-HOME-ENT) | 首页 · 企业空间（晨星科技） | 调整关键页 | 企业首页按 D-PC-07 不放管理卡；按 D-PC-08 只展示企业作品，不出现个人圈子或圈子通知。 |
| [P-M03-ALL-APPS](prototype.html#scene=P-M03-ALL-APPS) | 全部 Apps · 作品去重与授权来源 | 调整关键页 | 我的空间按作品 ID 去重；同一作品只显示一次，并保留全部有效圈子来源（D-PC-09）。 |
| [P-M03-ALL-APPS-ENT-EMPTY](prototype.html#scene=P-M03-ALL-APPS-ENT-EMPTY) | 全部 Apps · 企业目录为空 | 已有状态 / 行为 | 企业未分发时的空态；与个人隐藏、来源撤下区分展示。 |
| [P-M03-INSPECTOR](prototype.html#scene=P-M03-INSPECTOR) | App 详情（inspector） | 调整关键页 | 来源/版本/状态原因/权限说明；“为何阻断”不归因，只给路径。 |
| [P-M03-MANAGE-HOME](prototype.html#scene=P-M03-MANAGE-HOME) | 管理常用 Apps（上限 5） | 调整关键页 | 上限 5 个在这里生效；Polo 助手固定不占名额（D-PC-07 收口首页方案）。 |
| [P-M03-CONTROLS](prototype.html#scene=P-M03-CONTROLS) | 个人隐藏 / 恢复显示 | 调整关键页 | 只影响本设备的显示；与来源侧撤下/到期分开说明。 |
| [P-M03-HOME-ENT-AFTER-CANCEL](prototype.html#scene=P-M03-HOME-ENT-AFTER-CANCEL) | 首页 · 晨星科技（取消切换后） | 新增 / 构想 | 取消切换不撤销已完成的停止（C-R04）：账目式落点。 |
| [P-M03-HOME-ENT-AFTER-CLOSE](prototype.html#scene=P-M03-HOME-ENT-AFTER-CLOSE) | 首页 · 晨星科技（报价整理已关闭） | 新增 / 构想 | 终止并关闭/单项停止/重试成功的共同落态，顶栏与卡片账目一致。 |
| [P-M03-ALL-APPS-ZERO](prototype.html#scene=P-M03-ALL-APPS-ZERO) | 全部 Apps · 首登零常用 | 新增 / 构想 | 零常用目录态，保留 D-PC-09 去重演示（PC-N01）。 |
### M04 App 容器（10 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M04-APP-VIEW](prototype.html#scene=P-M04-APP-VIEW) | App 容器 · 全屏 FDE 占位 | 调整关键页 | App 占满主内容工作区，内部界面归 FDE；原型用中性占位（D-PC-05 容器边界）。 |
| [P-M04-PREPARE](prototype.html#scene=P-M04-PREPARE) | 准备与权限确认 | 已有状态 / 行为 | 安装对话框复用现有结构：权限说明 + 下载进度 + 确认打开。 |
| [P-M04-PREP-FAILED](prototype.html#scene=P-M04-PREP-FAILED) | 准备失败 | 已有状态 / 行为 | 失败不影响已安装版本；重试幂等，可先用当前版本（C-R02）。 |
| [P-M04-CLOSE-ACTIVE](prototype.html#scene=P-M04-CLOSE-ACTIVE) | 关闭 · 三选项 | 调整关键页 | 取消 / 后台继续 / 终止并关闭；展示正在运行的任务（D-PC-07 收口关闭方案）。 |
| [P-M04-TERM-FAILED](prototype.html#scene=P-M04-TERM-FAILED) | 终止失败 · 标签保留 | 调整关键页 | 终止失败保留标签并可重试；不出现“看似关了、后台还在跑”（C-R03）。 |
| [P-M04-BACKGROUND](prototype.html#scene=P-M04-BACKGROUND) | 后台继续 | 调整关键页 | 后台任务有持续入口（顶栏运行 pill → 运行状态）。 |
| [P-M04-RUNTIME](prototype.html#scene=P-M04-RUNTIME) | 运行状态中心 | 调整关键页 | 按空间列出本机运行项：进入 / 停止 / 全部终止并切换。 |
| [P-M04-PERM-DENIED](prototype.html#scene=P-M04-PERM-DENIED) | OS 权限被拒 | 调整关键页 | 给系统设置路径后由用户主动重试；不自动反复请求（C-R06）。 |
| [P-M04-APP-VIEW-PERSONAL](prototype.html#scene=P-M04-APP-VIEW-PERSONAL) | App 容器 · 我的空间 | 新增 / 构想 | 个人空间中性容器：chrome/标签/运行为我的空间（C-R03 · D-PC-05）。 |
| [P-M04-RUNTIME-PERSONAL](prototype.html#scene=P-M04-RUNTIME-PERSONAL) | 运行状态 · 我的空间 | 新增 / 构想 | 个人空间运行中心：只列当前空间任务（C-R03）。 |
### M05 助手 · 会话（6 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M05-CHAT](prototype.html#scene=P-M05-CHAT) | 助手 · 对话生成中 | 直接复用 | G4 三栏结构（侧栏/会话列表/对话）、会话行、停止按钮均为冻结稿直接复用（D-PC-06）。 |
| [P-M05-NEW](prototype.html#scene=P-M05-NEW) | 助手 · 新会话 | 直接复用 | 空会话占位与建议 chips 复用现有样式。 |
| [P-M05-STOPPED](prototype.html#scene=P-M05-STOPPED) | 助手 · 停止生成 | 直接复用 | 停止保留已生成部分与输入内容（PC-F02）。 |
| [P-M05-QUESTION](prototype.html#scene=P-M05-QUESTION) | 助手 · 追问待回答 | 直接复用 | 问题卡 + 回答/暂不回答；会话状态跨重开保留。 |
| [P-M05-QUESTION-REOPEN](prototype.html#scene=P-M05-QUESTION-REOPEN) | 助手 · 重开后问题恢复 | 直接复用 | 重开恢复问题与草稿；不替用户重复提交（PC-F10）。 |
| [P-M05-CHAT-PERSONAL](prototype.html#scene=P-M05-CHAT-PERSONAL) | 助手 · 报价汇总（我的空间） | 新增 / 构想 | 个人空间会话，含用户气泡；充值链落点（PC-N03）。 |
### M06 助手 · 技能与数据源（5 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M06-SKILLS](prototype.html#scene=P-M06-SKILLS) | 技能 · 授权/已启用/设备准备 | 直接复用 | 技能三态 + 同名来源区分；侧栏技能列表直接复用。 |
| [P-M06-SKILL-DENIED](prototype.html#scene=P-M06-SKILL-DENIED) | 技能 · 启用失败（无授权） | 直接复用 | 无授权给联系作者路径；不影响会话其余部分。 |
| [P-M06-TOOLS](prototype.html#scene=P-M06-TOOLS) | 数据源 / 自动化 / Browser | 直接复用 | 侧栏数据源/自动化与助手内 Browser 均为现有入口。 |
| [P-M06-SKILLS-PERSONAL](prototype.html#scene=P-M06-SKILLS-PERSONAL) | 技能 · 我的空间 | 新增 / 构想 | 个人空间技能页：圈子来源技能在此管理，未授权内联展示（C-R03 · D-PC-08）。 |
| [P-M06-TOOLS-PERSONAL](prototype.html#scene=P-M06-TOOLS-PERSONAL) | 数据源 / 自动化 · 我的空间 | 新增 / 构想 | 个人空间的数据源、自动化与 Browser 入口（PC-F04）。 |
### M07 我的圈子（15 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M07-LIST](prototype.html#scene=P-M07-LIST) | 我的圈子 · 列表 | 新增 / 构想 | 个人空间稳定入口，与「全部 Apps」并列（D-PC-07 收口 M07 入口）；本轮新增页。 |
| [P-M07-EMPTY](prototype.html#scene=P-M07-EMPTY) | 我的圈子 · 空态 | 新增 / 构想 | 说明分享链接、二维码、定向邀请、付费或审批等私域入口与作品获得路径。 |
| [P-M07-DETAIL-FOCUS](prototype.html#scene=P-M07-DETAIL-FOCUS) | 圈子详情 · 已加入 | 新增 / 构想 | 已获得作品 + 订阅信息 + 到期规则；续费/退出都在这里。 |
| [P-M07-JOIN-FREE](prototype.html#scene=P-M07-JOIN-FREE) | 加入免费圈子 | 新增 / 构想 | 免费即时生效；作品自动出现在 Apps。 |
| [P-M07-JOIN-PENDING](prototype.html#scene=P-M07-JOIN-PENDING) | 圈子 · 待审批 | 新增 / 构想 | 共享圈子需 Owner/Manager 审批；批准前不出现作品。 |
| [P-M07-DETAIL-PAID](prototype.html#scene=P-M07-DETAIL-PAID) | 付费订阅详情 | 新增 / 构想 | 价格/周期/手动续费/12 个月上限/支付渠道（浏览器）全在此说明。 |
| [P-M07-PAY-BROWSER](prototype.html#scene=P-M07-PAY-BROWSER) | 圈子支付（浏览器交接） | 跨端交接 | 支付在浏览器完成；桌面端只发起并确认结果。 |
| [P-M07-PAY-RETURN-FAIL](prototype.html#scene=P-M07-PAY-RETURN-FAIL) | 已支付 · 刷新失败 | 新增 / 构想 | 订单已在，不重复扣款；确认前不显示已到期（C-R01）。 |
| [P-M07-RENEW](prototype.html#scene=P-M07-RENEW) | 手动续费 | 新增 / 构想 | 从到期日起算、上限 12 个月；不自动扣款。 |
| [P-M07-EXPIRED](prototype.html#scene=P-M07-EXPIRED) | 圈子到期 | 新增 / 构想 | 仅本圈提供的作品需续费；另有有效来源的同一作品继续可用。 |
| [P-M07-LEAVE](prototype.html#scene=P-M07-LEAVE) | 退出圈子 | 新增 / 构想 | 退出只撤销当前圈子来源；确认前说明哪些作品仍可用。 |
| [P-M07-SOURCE-FALLBACK](prototype.html#scene=P-M07-SOURCE-FALLBACK) | 授权来源更新 · 仍可使用 | 调整关键页 | 同一创作者的晨星增长圈来源撤销后，晨星设计圈仍有效；同一作品保持一个条目。 |
| [P-M07-RENEW-EXPIRED](prototype.html#scene=P-M07-RENEW-EXPIRED) | 手动续费 · 到期恢复 | 新增 / 构想 | 到期后重新购买：起算日立即生效（PC-F03 · A-PAY）。 |
| [P-M07-LEAVE-PAID](prototype.html#scene=P-M07-LEAVE-PAID) | 退出圈子 · 北极星设计圈 | 新增 / 构想 | 付费圈退出确认：只撤销本圈来源（D-PC-09）。 |
| [P-M07-DETAIL-PAID-AFTER-LEAVE](prototype.html#scene=P-M07-DETAIL-PAID-AFTER-LEAVE) | 圈子详情 · 已退出 | 新增 / 构想 | 退出后账目：独有作品不可用可重加，共同授权继续可用。 |
### M08 会话文件（3 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M08-FILES](prototype.html#scene=P-M08-FILES) | 原对话文件 | 直接复用 | 附件与生成文件留在会话内；不建统一文件汇总页（D-PC-03）。 |
| [P-M08-FILE-MISSING](prototype.html#scene=P-M08-FILE-MISSING) | 文件缺失 | 直接复用 | 缺失给重选路径；会话其余内容不受影响（C-R02）。 |
| [P-M08-FILES-PERSONAL](prototype.html#scene=P-M08-FILES-PERSONAL) | 会话文件 · 报价汇总（我的空间） | 新增 / 构想 | 个人会话的附件与生成文件；文件留在原对话（D-PC-03 · C-R03）。 |
### M09 积分不足（9 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M09-PRE-BLOCK](prototype.html#scene=P-M09-PRE-BLOCK) | 发送前积分不足 | 新增 / 构想 | 输入保留、发送不可用；充值走浏览器（PC-N03）。 |
| [P-M09-STREAM-CUT](prototype.html#scene=P-M09-STREAM-CUT) | 生成中不足 · 部分输出 | 新增 / 构想 | 已生成部分保留并如实标注；不假装完成（PC-N03）。 |
| [P-M09-APP-BANNER](prototype.html#scene=P-M09-APP-BANNER) | App 内平台提示（非模态） | 新增 / 构想 | App 内只用非模态横幅；不接管 App 自身界面。 |
| [P-M09-ENT-NOTIFY](prototype.html#scene=P-M09-ENT-NOTIFY) | 企业积分 · 通知 Owner | 新增 / 构想 | Member 不能充值：通知 Owner；额度裁决不在客户端。 |
| [P-M09-USER-STOP](prototype.html#scene=P-M09-USER-STOP) | 用户主动停止 ≠ 积分不足 | 已有状态 / 行为 | 两种停止原因分开展示，避免误导。 |
| [P-M09-BROWSER](prototype.html#scene=P-M09-BROWSER) | 充值（浏览器交接） | 跨端交接 | 浏览器完成支付；到账以桌面端核对为准。 |
| [P-M09-CHECKING](prototype.html#scene=P-M09-CHECKING) | 返回后 · 单次查询中 | 新增 / 构想 | 返回只做一次查询；会话与草稿保留，不自动发送（PC-N03）。 |
| [P-M09-NOT-YET](prototype.html#scene=P-M09-NOT-YET) | 未到账 / 查询失败 | 新增 / 构想 | 保持阻断并保留重试；不重复发起多次查询。 |
| [P-M09-RESUMED](prototype.html#scene=P-M09-RESUMED) | 到账解除 · 由用户决定 | 新增 / 构想 | 解除后不自动发送/续写；是否继续由用户决定（已冻结）。 |

### M10 账号菜单与设置（6 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M10-MENU](prototype.html#scene=P-M10-MENU) | 账号菜单 · 有管理资格 | 调整关键页 | 管理入口（企业管理/创作者工作台/充值账单）统一收口在账号菜单（D-PC-07）。 |
| [P-M10-MENU-NOPRIV](prototype.html#scene=P-M10-MENU-NOPRIV) | 账号菜单 · 无资格 | 调整关键页 | 无资格时不显示管理入口，而不是灰置。 |
| [P-M10-SETTINGS](prototype.html#scene=P-M10-SETTINGS) | 设置 · 账号安全 | 直接复用 | 设置页复用现有 11 页结构与导航。 |
| [P-M10-SETTINGS-APPEARANCE](prototype.html#scene=P-M10-SETTINGS-APPEARANCE) | 设置 · 外观 | 直接复用 | 主题等个人偏好随账号，不随空间。 |
| [P-M10-ADMIN-BROWSER](prototype.html#scene=P-M10-ADMIN-BROWSER) | 企业管理后台（浏览器交接） | 跨端交接 | 后台独立登录；桌面端只保留入口（D-PC-07）。 |
| [P-M10-ADMIN-RETURN](prototype.html#scene=P-M10-ADMIN-RETURN) | 返回后 · 资格刷新 | 已有状态 / 行为 | 返回重新核对资格；责任以后台数据为准。 |

### M11 异常与恢复（14 屏）

| 屏 ID | 标题 | 分类 | 说明与依据 |
| --- | --- | --- | --- |
| [P-M11-REAUTH](prototype.html#scene=P-M11-REAUTH) | 会话过期 · 重新登录 | 已有状态 / 行为 | 登录后回到上次空间与页面；运行任务原地等待（C-R08）。 |
| [P-M11-REVOKE](prototype.html#scene=P-M11-REVOKE) | 运行中被移除 | 调整关键页 | 终止本机企业活动后回安全入口；个人空间仍可用（PC-F11）。 |
| [P-M11-PERSONAL-RESTRICTED](prototype.html#scene=P-M11-PERSONAL-RESTRICTED) | 个人也受限 · 安全页 | 调整关键页 | 最小操作集：联系管理员 / 退出登录；不归因。 |
| [P-M11-BLOCKED-WITHDRAWN](prototype.html#scene=P-M11-BLOCKED-WITHDRAWN) | 作品 · 分发被撤下 | 已有状态 / 行为 | 保留安装但不可启动；状态原因如实展示。 |
| [P-M11-BLOCKED-EXPIRED](prototype.html#scene=P-M11-BLOCKED-EXPIRED) | 作品 · 最后一个来源失效 | 已有状态 / 行为 | 仅当最后一个来源也失效才阻断；恢复任一有效来源后重新打开。 |
| [P-M11-BLOCKED-VERSION](prototype.html#scene=P-M11-BLOCKED-VERSION) | 作品 · 版本紧急阻断 | 已有状态 / 行为 | 安全问题紧急阻断；升级路径可见（PC-F08）。 |
| [P-M11-OFFLINE-HOME](prototype.html#scene=P-M11-OFFLINE-HOME) | 离线打开 | 已有状态 / 行为 | 缓存可用范围如实标注；联网自动续上（C-R07）。 |
| [P-M11-OFFLINE-RUNNING](prototype.html#scene=P-M11-OFFLINE-RUNNING) | 运行中断网 | 调整关键页 | 本地可继续、联网步骤等待；用户可选择终止（C-R07）。 |
| [P-M11-CONTRACT](prototype.html#scene=P-M11-CONTRACT) | 需要升级 Polo | 集成候选已实现 | 集成候选 ContractGate：最低版本阻断企业空间，个人空间不受影响。 |
| [P-M11-CONTRACT-DL](prototype.html#scene=P-M11-CONTRACT-DL) | 正在下载更新 | 集成候选已实现 | 后台下载；可用个人空间，不被强制等待。 |
| [P-M11-CONTRACT-FAIL](prototype.html#scene=P-M11-CONTRACT-FAIL) | 更新没有完成 | 集成候选已实现 | 幂等重试，不出现半更新状态；重试/帮助路径可见。 |
| [P-M11-SPACE-ERROR](prototype.html#scene=P-M11-SPACE-ERROR) | 空间列表加载失败 | 集成候选已实现 | 集成候选 space-error 卡：重试或离线继续（缓存）。 |
| [P-M11-REOPEN-RECOVERY](prototype.html#scene=P-M11-REOPEN-RECOVERY) | 重开恢复 | 调整关键页 | 恢复会话与标签；运行任务核对状态，不假装完成（PC-F10）。 |

合计 **92** 屏。
## 4. 失败恢复对照（C-R01—C-R08）

POO-70 已冻结的 8 条「共同恢复契约」逐一映射到原型屏幕：

| 契约 | 冻结的要求（摘要） | 原型中的用户可见行为 | 对应屏 |
| --- | --- | --- | --- |
| C-R01 会话 / 账号 | 会话过期重新登录重验后才恢复；不自动执行原动作 | 重登后回到安全入口，核对账号与访问权；过期前的动作不自动重放 | [P-M11-REAUTH](prototype.html#scene=P-M11-REAUTH)、[P-M01-REOPEN](prototype.html#scene=P-M01-REOPEN) |
| C-R02 空 / 失败 | 空态与失败态分别展示，不拿其他空间缓存填充 | 首页真空目录、目录加载失败、企业目录为空三态分立；离线缓存单独标注 | [P-M03-HOME-EMPTY-DIR](prototype.html#scene=P-M03-HOME-EMPTY-DIR)、[P-M03-HOME-LOAD-FAIL](prototype.html#scene=P-M03-HOME-LOAD-FAIL)、[P-M03-ALL-APPS-ENT-EMPTY](prototype.html#scene=P-M03-ALL-APPS-ENT-EMPTY)、[P-M03-HOME-OFFLINE](prototype.html#scene=P-M03-HOME-OFFLINE) |
| C-R03 上下文 | 异步回执只作用于已提交空间；旧回执不污染新空间 | 切换后助手集合整体切换；终止进度只反映切换时锁定的任务集 | [P-M02-TARGET-LOADING](prototype.html#scene=P-M02-TARGET-LOADING)、[P-M02-STOPPING](prototype.html#scene=P-M02-STOPPING) |
| C-R04 取消 / 中断 | 已完成的终止不被回滚；部分终止后取消切换不自动复活 | 取消切换留在原空间，已终止项保持终止；失败项单独重试 | [P-M02-STOP-CANCEL](prototype.html#scene=P-M02-STOP-CANCEL)、[P-M02-STOP-FAILED](prototype.html#scene=P-M02-STOP-FAILED) |
| C-R05 重新打开 | 恢复身份、重验权限；不重发旧 Prompt、不把崩溃猜成成功 | 重开先登录恢复，再核对会话/草稿/任务状态并如实标注 | [P-M11-REOPEN-RECOVERY](prototype.html#scene=P-M11-REOPEN-RECOVERY)、[P-M05-QUESTION-REOPEN](prototype.html#scene=P-M05-QUESTION-REOPEN) |
| C-R06 桌面权限 | OS 拒绝给系统设置路径；用户授权后由用户主动重试 | 权限被拒不自动重试；给「打开系统设置」路径，返回后由用户点重试 | [P-M04-PERM-DENIED](prototype.html#scene=P-M04-PERM-DENIED) |
| C-R07 数据转移 | 切空间从不搬数据；allowlist 内导出导入 | 切换只换集合与权限；离线只开缓存可用项，未安装/更新不可用 | [P-M02-SWITCHER](prototype.html#scene=P-M02-SWITCHER)、[P-M11-OFFLINE-HOME](prototype.html#scene=P-M11-OFFLINE-HOME) |
| C-R08 Browser 返回 | Browser 完成只是该端事实；需同账号验证与自身刷新 | 支付/加入成功后桌面做一次查询/刷新；失败给出重试且不伪造成功 | [P-M01-REFRESH-FAIL](prototype.html#scene=P-M01-REFRESH-FAIL)、[P-M09-CHECKING](prototype.html#scene=P-M09-CHECKING)、[P-M09-NOT-YET](prototype.html#scene=P-M09-NOT-YET)、[P-M07-PAY-RETURN-FAIL](prototype.html#scene=P-M07-PAY-RETURN-FAIL)、[P-M10-ADMIN-RETURN](prototype.html#scene=P-M10-ADMIN-RETURN) |

## 5. 跨端交接说明

浏览器端不在本卡交付范围：桌面原型只画**交接卡**（chrome 为 bridge 的屏），卡片上明确「另一端负责」。共 8 屏：

| 屏 | 标题 | 桌面端职责（卡片上画什么） | 浏览器端职责（另一端负责，不在本卡范围） |
| --- | --- | --- | --- |
| [P-M01-INVITE-BROWSER](prototype.html#scene=P-M01-INVITE-BROWSER) | 邀请确认（浏览器交接） | 展示邀请信息与「确认加入」 | 浏览器完成加入；成功只作为桌面刷新输入 |
| [P-M01-INVITE-MISMATCH](prototype.html#scene=P-M01-INVITE-MISMATCH) | 邀请 · 账号不匹配 | 展示邀请与当前账号不匹配 | 浏览器拒绝把邀请交给错误账号 |
| [P-M01-INVITE-PENDING](prototype.html#scene=P-M01-INVITE-PENDING) | 共享邀请 · 待审批 | 展示待审批状态 | 浏览器等待 Owner/Manager 审批 |
| [P-M01-NOT-INSTALLED](prototype.html#scene=P-M01-NOT-INSTALLED) | 未安装 · 下载指引 | 下载指引 | 浏览器只引导下载；装不装、何时装由用户决定 |
| [P-M01-CREATE-ENT](prototype.html#scene=P-M01-CREATE-ENT) | 创建企业（浏览器交接） | 创建表单入口 | 浏览器完成创建（幂等）；是否进入由用户在桌面决定 |
| [P-M07-PAY-BROWSER](prototype.html#scene=P-M07-PAY-BROWSER) | 圈子支付（浏览器交接） | 圈子订阅支付 | 浏览器完成支付；桌面同账号验证后刷新 |
| [P-M09-BROWSER](prototype.html#scene=P-M09-BROWSER) | 充值（浏览器交接） | 积分充值 | 浏览器完成充值；桌面发起一次到账查询 |
| [P-M10-ADMIN-BROWSER](prototype.html#scene=P-M10-ADMIN-BROWSER) | 企业管理后台（浏览器交接） | 企业管理后台入口 | 后台在浏览器独立登录；桌面不内嵌 |

**交接共同规则**：另一端完成 ≠ 桌面已完成。桌面端拿到的是「去查一次」的输入；查询成功才解除阻断，失败如实展示可重试（见 §4 C-R08）。
## 6. 已解决项与后续输入

本轮没有新增必须由产品 owner 裁决的客户端行为。下列历史待决已按确认结果或责任边界重新分类：

| 项目 | 当前状态 | 处理 |
| --- | --- | --- |
| 企业首页管理入口 | 已确认（D-PC-07） | 企业首页不放管理卡；有资格的入口只在账号菜单 |
| 个人有活动时切企业 | 已确认（D-PC-08 / C-R04） | 已补 `P-M02-CONFIRM-PERSONAL`；取消留在个人空间，确认后才切换 |
| App 共用容器帧 | 已确认（D-PC-05） | 保留一个 Polo 容器布局与中性 FDE 占位，不设计 App 内部页面 |
| 常用 Apps 上限、续费、Member 通知的展示文案 | 行为已确认，视觉文案待复看 | 当前文案仅用于高保真走查；若修改行为再同步主说明 |
| 圈子价格、周期、充值套餐与金额 | 缺真实商业输入 | 原型中的数字是演示数据；正式页面接入前由 POL-94/对应业务 owner 提供，不由客户端代选 |
| “分支：”虚线按钮 | 已移除产品表面 | 44 个评审虚线按钮已从产品表面移除，对应失败/取消/交接状态改为 35 个 review_entries 评审入口；Plan 时把每个 review_entry 映射到真实触发或测试入口，不要求用户批准为产品按钮 |
| 同一作品能否分发到多个圈子 | 已确认（D-PC-09） | 可多圈分发；我的空间按作品去重并保留全部有效来源；单一来源失效继续可用，最后来源失效才阻断。POL-94 旧单圈限制已被替代 |
| [P-M11-SUPPORT-BROWSER](prototype.html#scene=P-M11-SUPPORT-BROWSER) | 联系管理员（浏览器交接） | 跨端交接 | 支持请求在浏览器创建，桌面保留当前状态（生成边界）。 |

## 7. 已知限制

- **UI 基准为 POO-41 G4 冻结稿**：窗口 chrome（64px workbench-bar 单顶栏：brand-lockup + 标签页 + 运行 pill/空间切换器/通知/头像）、`system-screen`（登录/门禁/交接全屏）、`modal-layer` 居中对话框、`toast`、G4 组件语言与 token 全部内联自 `polo-client-g4-ui/design-demos`（2026-08-11 产品用户确认冻结）的 `product.css` 原文；本原型仅以 G4 token 补充冻结稿未覆盖的状态组件。
- **v2 契约的实现差异**：v2 要求场景容器内无 `position: fixed`，故 modal-layer / toast / system-screen / auth-ambient 四类叠层改为 `absolute` 锚定在 100vh 场景容器内——视觉与交互不变（逐类断言恰 1 处替换）；v1 的旁注条、演示控制区等评审 chrome 已从产品表面剥离，只保留在评审壳。
- **虚构数据**：所有人名、企业、圈子、App、价格均为演示数据；不代表真实目录或定价。
- **App 内部为中性占位**：FDE 区域不猜测任何真实 App 的业务界面（D-PC-05 容器边界）。
- **浏览器端只画交接卡**：8 个 bridge 屏表达责任边界与桌面侧行为，不代表浏览器端设计。
- **对话框以独立屏呈现**：安装/关闭/续费等对话框画成独立场景以便链接直达；真实实现中多为当前视图上的叠层。
- **视口切换是真实视口**：评审壳的「视口」下拉改变 iframe 的真实 CSS 视口（innerWidth/innerHeight 精确等于所选尺寸，冒烟已验证），非缩放模拟；正式验收截图见 [visual-acceptance.md](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fvisual-acceptance.md)。
- **不修改产品代码**：本卡只含文档与原型；Electron/Admin/Browser 源码零改动、零发布。

## 8. 本轮验证证据（master-r10 v2-4 内容边界收口）

三类检查分别记录，不互相替代：

- **结构（structure）**：`sync_manifest.py` + `validate_prototype.py --previous prototype-manifest-before-master-r10.json` 通过——v2 high_fidelity，92 scenes，1339 transitions，0「分支：」transitions，35 review_entries，6 arrival=review steps，56 changed_scenes，0 removed_scenes；surface actions 与 declared transitions 严格匹配；source sha256 与 `--previous` 基线 compare 通过。
- **语义（semantic，独立 context）**：用 deep-reasoner 子代理（独立 context，不继承生成者自评）做三轮复查。第一轮发现 13 屏「责任以后台数据为准」+ 4 屏「幂等」等硬词残留→第二轮清理；第二轮复查发现 18 硬词虽清零但 13 处同义改写残留（不会重复创建/不会自动恢复/保持停止/才提交切换/一起加载/不归因/最低版本阻断/标签保留/不需要重复安装/未产生副作用）→第三轮清理；第三轮复查结论：**达标**——可见区不含需求说明/设计理由/机制说明/责任免责/非动作保证/评审代号，剩余「不会/自动」句式经语义判定均为合法产品安抚、动作范围澄清或状态说明。独立审查 trace 见会话记录。
- **浏览器（browser，抽样）**：playwright headless 对第三轮 14 个 scene 渲染验证——全部含合法文案、无违规文案、0 JS 错误，截图存 `screenshots/r3-verify/`。**未做完整 92 场景×2 视口 coverage 与 1339 transition rendered control 全集证据**（当前环境能力不足）；`quality-report.json` 因此**未生成**——按 skill「Missing browser or independent review capability means incomplete, never an invented pass」原则，不伪造完整 browser pass。完整 browser coverage 与 `quality-report.json` 留待具备全集截图能力时补。


## v3 迁移记录（2026-09-19）

- 输入基础与操作分类：本次为 product-ui-prototype v2→v3 **就地迁移（incremental）**，对象仅为本 bundle 既有 v2 产物（prototype.html 旧评审控制台、surface.html 产品页、prototype-manifest.json v2 与本记录）；未按 rebuild 隔离规则重新生成产品 HTML/CSS/JS，产品文案、布局与交互除分支场景约定清理外不变。
- 操作分组：① manifest 升级 v3（schema_version/files/default_story/review_entries 补齐，revision → poo70-ux-r4-v3-8）；② 评审控制台按 v3 模板生成 review.html；③ surface.html 更名 prototype.html 并同步嵌入 manifest；④ 分支场景约定清理（详见下）；⑤ 运行时适配（next-step hint 支持；POL-114 另含状态物化与通道清理）。

### 分支场景约定清理明细

- v2 遗留问题修复：118 个空 label 转换（其中多数为顶栏「通知」等图标按钮）以控件可见文本/aria-label 回填；P-M01-REFRESH-FAIL 在 v2 已不可达，补 review_entries；story S2 第 11 步（P-M11-REOPEN-RECOVERY→P-M03-HOME-ENT）无申报转换，改 arrival:review。
- 演示控件清理：（演示）模拟到期 ×2、（演示）模拟下载失败、（演示）网络已恢复 ×2 共 5 处移除，目标场景（P-M07-EXPIRED、P-M11-CONTRACT-FAIL 已有评审入口；P-M03-HOME-PERSONAL 可经真实操作可达）不受影响；（演示）重新发送 改为真实文案「重新发送」，（演示）全部停止，继续切换 去掉演示前缀。
- 产品页运行时为纯旧代协议实现，整体替换为 v3 模板运行时（补 next-step hint 上报）。
- 迁移后交付件：review.html / prototype.html / prototype-manifest.json / quality-report.json；surface.html 与旧 v2 控制台退出交付。


### 语义评审修复轮（2026-09-19）

- 独立语义评审发现漏网演示控件：P-M11-OFFLINE-RUNNING 的「（演示）网络已恢复」（T-P-M11-OFFLINE-RUNNING-014-P-M04-APP-VIEW），已按同约定移除（该场景保留真实「重试连接」；目标场景 P-M04-APP-VIEW 另有 41 处真实入口）。复验通过。