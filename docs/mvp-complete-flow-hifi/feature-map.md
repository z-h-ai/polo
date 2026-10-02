# 当前功能地图 · 跨端收口 r13

当前唯一产品说明：[spec.md](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2F..%2Fclient-journey-review%2Fspec.md)（master-r13）；同一评审入口：[review.html](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Freview.html)。本轮消费已确认规则；新增页面呈现待复看。

| 模块 | 本轮状态 | 实际使用与恢复 |
| --- | --- | --- |
| M01 登录与空间承接 | 更新邀请返回 | 网页确认成员后，桌面主动刷新，再自行进入企业；指定身份与共享邀请审批仍保留 |
| M02 空间切换 | 保留 | 无活动切换；有活动确认终止、失败/取消、目标失权恢复沿现有方案 |
| M03 首页与全部 Apps | 保留 | 当前空间授权目录、去重来源、常用 App 与空状态沿现有方案 |
| M04 App 容器 | 保留 | 全工作区 App 容器；内部交互/结果归 FDE；后台、关闭和权限恢复沿现有方案 |
| M05 助手会话 | 直接复用 | 使用现有源码表面与框架，本轮不调整 |
| M06 技能与数据源 | 直接复用 | 安装/启停/版本/来源与连接恢复沿现有源码 |
| M07 我的圈子 | 更新 | 分享页自助加入；返回同账号核对；日历月/年续费与上限；失败查原单，登录后保留原目标 |
| M08 原对话文件 | 直接复用 | 附件与生成文件留原对话；独立文件汇总页延后 |
| M09 积分与恢复 | 保留 | 用户主动单次查询，恢复后不自动发送/续写/重试；不与圈子订阅混账 |
| M10 账号与管理入口 | 保留 | 偏好、资格入口与另一端独立会话沿现有方案 |
| M11 异常恢复与客服 | 更新 | 原异常打开客服，只复制有权可见信息；返回原对象；企业管理员/平台客服各守责任 |

SDK/API 产品、跨 App 结果聚合、独立文件汇总页仍延后或移出容器责任。当前付费圈子范围消费 POL-114 r26 / POL-115 D-OPS-15，不能沿用旧“首发延期”作当前结论。

本轮复看三条故事：`R13-circle-handoff`（加入与核对）、`R13-enterprise-handoff`（企业邀请与主动进入）、`R13-support`（原订单异常与恢复）。月/年续费、账号不一致、客服不可用等分支由页面索引进入。本轮验证覆盖与限制见 [review.md](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Freview.md)；不以这三条故事代表其他模块重新完成产品或视觉验收。

---

## r12 维护分工（继续适用，历史轮次说明）


打开 [review.html](review.html) 完成同一入口走查。M01/M02/M03/M04/M07/M10/M11 继续维护于 MVP；M05/M06/M08 和助手内 M09 由新助手源码维护。M09 浏览器与 App 提示仍属 MVP。下方“当前助手完整场景映射”由源码导出，覆盖每个场景、来源与补充差异；旧 r11 统计不代表本轮数量。

评审控制台的页面索引按模块展示完整地图；故事覆盖个人与企业会话、技能获取与启用、设备准备、版本/卸载/来源变化、原对话文件、积分/预算恢复。异常结果可从页面索引进入，不添加模拟失败按钮。兼容场景只复用状态参数和组件，不重复维护界面。

默认工作区由系统准备；助手仅静态显示空间归属。新布局待复看。验证入口与结果见 [review.md](review.md) 和 [quality-report.json](quality-report.json)。

---

## 历史 r11 功能地图（以下描述仅适用于当时版本）

# POO-70 · MVP 完整流程高保真 — 一页功能地图

日期：2026-09-23 · 分支 `POO-70/docs/client-journey-policy-interview` · 当前原型修订 `poo70-desktop-ux-r11-zh-skill-terminology` · [评审壳](review.html) · [产品表面](prototype.html)

**用途**：产品 owner 用一个浏览器标签完成 MVP 全流程视觉评审。本页回答“每个模块覆盖了什么、画的是什么、依据是什么”；逐步走查见 [review.md](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Freview.md)；机器可读追溯见 [prototype-manifest.json](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fprototype-manifest.json)。

**当前原型形态（v3 契约）**：`prototype.html` 是纯产品表面，`review.html` 是评审壳；187 场景、4,545 条声明跳转，以 `prototype-manifest.json` 为机器可读索引。中文界面的用户文案统一称「技能」；场景 ID 与技术文件名保留 `SKILL`。旧截图与旧版验收只代表其生成时的修订，不作为 r11 当前视觉验收。

**输入基线（不可混称）**：
- 产品结论权威：POO-70 `spec.md`（已接受，D-PC-04），快照存于本卡 `sources/poo70-spec.md`
- 模块方案：POO-70 `module-review.md`（M01—M11），快照存于本卡 `sources/poo70-module-review.md`
- 现状差异：POO-70 `implementation-delta-review.md`，快照存于本卡 `sources/poo70-implementation-delta-review.md`
- 设计系统：本卡 `docs/DESIGN.md`；真实样式令牌：本卡 `sources/renderer-index.css`（取自 `apps/electron/src/renderer/index.css` @ dev `01f4447c`）
- 设计 Skill（high_fidelity 绑定）：`.agents/skills/polo-ai-design-system`（当前 revision `poo70-dpc10-v3-account-space-entry`，视觉令牌 authority = POO-41 G4 冻结稿；入口差异按 D-PC-10）
- 集成候选参照：C-INT `integration/pol68-g5-client` @ `3dc20ca`（空间切换器、ContractGate、新首页 IA 等“集成候选已实现”屏的依据）

**UI 基准（2026-09-16 重做）**：全部窗口 chrome（G4 workbench-bar 单顶栏）、token 与组件语言内联自 POO-41 `polo-client-g4-ui/design-demos`（2026-08-11 产品用户确认冻结，98 scenes 全通过）的 `product.css`；本卡不再使用自造窗口样式。

---

## 1. 图例：每个屏的来源分类

| 标注 | 含义 |
| --- | --- |
| 直接复用 | M05/M06/M08 助手框架等，按 D-PC-06 直接复用 POO-41 G4 冻结稿界面，不做新稿 |
| 调整关键页 | 需要按已确认规则调整后制作的关键页（首页、App 容器、账号菜单等） |
| 新增 / 构想 | 本轮为补齐 MVP 流程新画的页（我的圈子、积分不足流程），须 owner 评审 |
| 集成候选已实现 | C-INT `3dc20ca` 已有实现的还原（空间切换对话框、ContractGate、space-error） |
| 已有状态 / 行为 | 现有客户端已具备的状态或行为，本轮如实呈现 |
| 跨端交接 | 浏览器端职责，桌面原型只画交接卡并标注“另一端负责”（邀请、支付、充值、管理后台） |

---

## 2. 一页功能地图

### M01 登录与空间承接 — 覆盖：14 屏 · 完整（含跨端）
用户价值：登录后一定有一个可用的「我的空间」；企业加入不阻塞个人使用。
代表屏：`P-M01-LOGIN-PASSWORD` → `P-M01-PERSONAL-PREP` → `P-M03-HOME-ZERO`
场景追溯：PC-F01（首登/我的空间）、PC-F05（浏览器邀请）、PC-F07（创建企业）、C-R01/C-R08
要点：空间准备幂等（重试不产生第二个空间）；浏览器加入成功只是桌面刷新的输入；错账号不吞邀请；冷启动重验候选目标、不自动切空间。

### M02 空间切换 — 覆盖：11 屏 · 完整（集成候选 + 已确认补页）
用户价值：切空间先讲清楚代价；部分失败可恢复、可取消，且不产生半状态。
代表屏：`P-M10-MENU-ENT` → `P-M02-SWITCHER` → `P-M02-CONFIRM` → `P-M02-STOPPING` → `P-M02-STOP-FAILED`
场景追溯：PC-F06、C-R04/C-R05
要点：顶栏只显示当前空间；头像菜单 →「切换空间」进入空间列表。同一账号下无活动直切、有活动先确认；`P-M02-CONFIRM-PERSONAL` 补齐个人空间有活动时切企业的确认；全部终止后才提交切换；「取消切换」不撤销已完成的停止；目标加载失败可重试或留在原空间；失权目标从切换列表移除，并由通知提供「查看原因」路径；本轮推荐待复看。

### M03 首页与全部 Apps — 覆盖：16 屏 · 完整（调整关键页）
用户价值：常用 App 一步直达；个人目录聚合多个圈子的有效权益，企业目录只展示企业向本人分发的作品，来源可查、可解释。
代表屏：`P-M03-HOME-PERSONAL`、`P-M03-ALL-APPS`、`P-M03-INSPECTOR`
场景追溯：PC-F02/PC-F07、PC-N01（零常用引导）、D-PC-01/D-PC-07
要点：固定 Polo 助手 + 最多 5 个常用（上限在管理对话框生效）；零常用/真空目录/加载失败/离线缓存四种首页态；详情 inspector 给来源、版本、状态原因，“为何被阻断”不归因、只给路径。

### M04 App 容器 — 覆盖：18 屏 · 完整（调整关键页）
用户价值：App 像浏览器里的网站一样占满工作区；关闭、后台、权限都有确定行为。
代表屏：`P-M04-APP-VIEW`（中性 FDE 占位）→ `P-M04-CLOSE-ACTIVE` → `P-M04-TERM-FAILED`
场景追溯：PC-N02、D-PC-05、C-R03/C-R06
要点：App 内部全部归 FDE，原型只画占位；关闭三选项「取消 / 后台继续 / 终止并关闭」；终止失败保留标签、不出现“看似关了、后台还在跑”；OS 权限被拒给系统设置路径后由用户主动重试。

### M05 助手 · 会话 — 覆盖：7 屏 · 完整（直接复用）
用户价值：提问、停止、追问、重开恢复，全部沿用现有助手框架。
代表屏：`P-M05-CHAT` → `P-M05-STOPPED` / `P-M05-QUESTION-REOPEN`
场景追溯：PC-F04、D-PC-06
要点：G4 三栏结构与停止/追问/重开交互直接复用；停止保留已生成部分；重开恢复问题与草稿、不替用户重复提交。

### M06 助手 · 技能与数据源 — 覆盖：67 屏 · 完整（直接复用）
用户价值：技能按来源区分、授权状态如实；数据源/自动化/Browser 均为现有入口。
代表屏：`P-M06-SKILLS`（同名技能 + 授权/已启用/设备准备三态）、`P-M06-SKILL-DENIED`
场景追溯：PC-F04、D-PC-06
要点：同名技能按来源并列不合并；无授权给“联系作者”路径，不影响会话其余部分。

### M07 我的圈子 — 覆盖：16 屏 · 完整（本轮新增，需评审）
用户价值：圈子是作品来源：加入、订阅、续费、到期、退出全程有据。
代表屏：`P-M07-LIST` → `P-M07-DETAIL-FOCUS` → `P-M07-SOURCE-FALLBACK`；最后来源失效见 `P-M11-BLOCKED-EXPIRED`
场景追溯：PC-F03、D-PC-07（M07 入口收口）、D-PC-09（作品去重与逐来源失效）
要点：列表/空态/免费加入/待审批/付费详情/手动续费（从到期日起算、上限 12 个月）/到期/退出按来源撤权；其他有效来源继续使用；最后来源失效才阻断。

### M08 会话文件 — 覆盖：3 屏 · 完整（直接复用）
用户价值：附件与生成文件留在原对话，可找回，缺失有出路。
代表屏：`P-M08-FILES`、`P-M08-FILE-MISSING`
场景追溯：D-PC-03（不做统一文件汇总页）
要点：通过原对话打开合法可访问文件；缺失给重新选择入口、不伪造恢复。

### M09 积分不足 — 覆盖：12 屏 · 完整（本轮新增，需评审）
用户价值：不足时容器级提示、不丢内容；充值走浏览器；到账后由用户决定是否继续。
代表屏：`P-M09-PRE-BLOCK` → `P-M09-BROWSER`（交接）→ `P-M09-CHECKING` → `P-M09-RESUMED`
场景追溯：PC-N03、D-PC-04/D-PC-07
要点：发送前阻断（输入保留、发送不可用）；生成中不足保留部分输出并如实标注；App 内只用非模态横幅；企业 Member 通知 Owner、不代做额度裁决；返回后单次查询、到账只解除阻断、不自动发送/续写；用户主动停止与积分不足分开展示。

### M10 账号菜单与设置 — 覆盖：9 屏 · 完整（调整关键页）
用户价值：头像菜单集中放「切换空间」、按资格出现的管理入口与个人偏好；顶栏持续显示当前空间。
代表屏：`P-M10-MENU`（企业管理/创作者工作台/充值与账单）、`P-M10-MENU-NOPRIV`
场景追溯：PC-F09、D-PC-07、D-PC-10
要点：无资格时不显示管理入口（不灰置）；企业后台在浏览器独立登录，桌面只保留入口；返回后重新核对资格。

### M11 异常与恢复 — 覆盖：14 屏 · 完整
用户价值：任何异常都有安全落点：能重试的幂等重试，不能用的说明原因，受限时给最小出路。
代表屏：`P-M11-CONTRACT`（需要升级 Polo）→ `P-M11-CONTRACT-FAIL`；`P-M11-REVOKE`；`P-M11-REOPEN-RECOVERY`
场景追溯：PC-F08/PC-F10/PC-F11、C-R02/C-R07/C-R08、D-PC-05
要点：版本紧急阻断给升级路径（ContractGate 三态为集成候选还原）；运行中被移除先终止企业活动再回安全入口；个人也受限时只留联系管理员/退出；离线打开如实标注缓存可用范围；重开恢复核对状态、不假装完成。

---

## 3. 覆盖统计

以下数量取自当前 r9 manifest；“覆盖”表示原型中存在场景，不代表产品已实现或视觉已验收。

| 模块 | 场景数 |
| --- | ---: |
| M01 登录与空间承接 | 14 |
| M02 空间切换 | 11 |
| M03 首页与全部 Apps | 16 |
| 应用容器与按需能力 | 18 |
| M05 助手 · 会话 | 7 |
| 本机技能与助手能力 | 67 |
| M07 我的圈子 | 16 |
| M08 会话文件 | 3 |
| M09 积分不足 | 12 |
| M10 账号菜单与设置 | 9 |
| M11 异常与恢复 | 14 |
| **合计** | **187** |

## 4. 已冻结结论在原型中的落点

| 冻结结论 | 出处 | 原型落点 |
| --- | --- | --- |
| 保留首页；零常用引导“全部 Apps”，不自动挑选 | D-PC-01 | `P-M03-HOME-ZERO`、`P-M03-HOME-PERSONAL` |
| App 负责业务内容/保存/找回；Polo 只做容器与授权 | D-PC-02 | `P-M04-APP-VIEW`、`P-M03-INSPECTOR` |
| 独立“文件”汇总页延后；文件留原对话 | D-PC-03 | `P-M08-FILES`（无任何汇总页） |
| 本轮整体方案与 C-R06 恢复交互接受 | D-PC-04 | 全部失败恢复屏（见 review.md §5） |
| FDE 负责 App 内部；App 占满主要内容工作区 | D-PC-05 | `P-M04-APP-VIEW` 中性占位（App Tab 隐藏 TopBar） |
| 助手整体框架直接复用 | D-PC-06 | `P-M05-*`、`P-M06-*`、`P-M08-*`（标注“直接复用”） |
| M03/M04 关闭/M07 入口/M09 提示方案 + M10 管理入口统一账号菜单 | D-PC-07 | 首页布局、`P-M04-CLOSE-ACTIVE`、`P-M07-LIST`、`P-M09-*`、`P-M10-MENU` |
| 圈子只聚合到个人空间；企业无圈子；私域不等于仅邀请；有活动切企业先确认 | D-PC-08 | `P-M03-ALL-APPS`、`P-M03-HOME-ENT`、`P-M07-EMPTY`、`P-M02-CONFIRM-PERSONAL` |
| 同一作品可多圈分发；我的空间按作品去重；单一来源失效继续可用，最后来源失效才阻断 | D-PC-09 | `P-M03-ALL-APPS`、`P-M07-LEAVE`、`P-M07-SOURCE-FALLBACK`、`P-M07-EXPIRED`、`P-M11-BLOCKED-EXPIRED`、`P-M03-HOME-ENT` |
| 顶栏静态显示当前空间；头像菜单进入空间列表 | D-PC-10 | `P-M10-MENU`、`P-M10-MENU-ENT`、`P-M02-SWITCHER`、`P-M02-SWITCHER-PERSONAL` |

---

## 5. 当前原型边界与证据

- 仅更新离线原型和 POO-70 设计文档；Electron、Admin 与浏览器产品代码未因本轮入口调整而改变。
- 浏览器端邀请、支付、充值和管理后台仍以交接场景表示；App 内部业务界面仍由 App 负责。
- 产品表面位于 `prototype.html`，故事导航、场景索引、分支状态注入和说明位于 `review.html`。没有产品可触发操作的异常态使用 `review_entries`，不放伪造按钮。
- 当前 v3 结构检查通过；r9 空间入口与 r10 失权通知的真实点击、视口检查分别见 `build/space-entry-r9/browser-check.json`、`build/revoked-space-r10/browser-check.json`。完整质量状态仍为 `incomplete`，见 `quality-report.json`。
<!-- assistant-r12-map -->

## 当前助手完整场景映射（源码导出）

以下覆盖唯一有效助手来源。上方 r11 模块描述是历史；新页面均待复看。验证见 `quality-report.json` 与 `evidence/r12/`。

| 场景 | 归属 / 依据 | 基线与补充 | 验证 |
|---|---|---|---|
| [新会话 · 我的空间](review.html#scene=A-personal-new) `A-personal-new` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [原会话 · 我的空间](review.html#scene=A-personal-conversation) `A-personal-conversation` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在生成 · 我的空间](review.html#scene=A-personal-generating) `A-personal-generating` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已停止 · 我的空间](review.html#scene=A-personal-stopped) `A-personal-stopped` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [等待回答 · 我的空间](review.html#scene=A-personal-question) `A-personal-question` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [重开后恢复问题 · 我的空间](review.html#scene=A-personal-reopen) `A-personal-reopen` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已回答 · 我的空间](review.html#scene=A-personal-answered) `A-personal-answered` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [暂不回答 · 我的空间](review.html#scene=A-personal-deferred) `A-personal-deferred` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [问题已过期 · 我的空间](review.html#scene=A-personal-expired) `A-personal-expired` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [原会话不可访问 · 我的空间](review.html#scene=A-personal-deleted) `A-personal-deleted` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [回答未提交 · 我的空间](review.html#scene=A-personal-answerfailed) `A-personal-answerfailed` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [网络已断开 · 我的空间](review.html#scene=A-personal-offline) `A-personal-offline` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [服务暂时不可用 · 我的空间](review.html#scene=A-personal-service) `A-personal-service` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [重新验证完成 · 我的空间](review.html#scene=A-personal-restored) `A-personal-restored` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本次生成已完成 · 我的空间](review.html#scene=A-personal-completezero) `A-personal-completezero` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [原对话附件与生成文件 · 我的空间](review.html#scene=A-personal-files) `A-personal-files` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [查看生成文件 · 我的空间](review.html#scene=A-personal-viewer) `A-personal-viewer` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [查看原对话附件 · 我的空间](review.html#scene=A-personal-attachment) `A-personal-attachment` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [文件已移动或删除 · 我的空间](review.html#scene=A-personal-missing) `A-personal-missing` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已重新选择材料 · 我的空间](review.html#scene=A-personal-reselected) `A-personal-reselected` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源与工具 · 我的空间](review.html#scene=A-personal-sources) `A-personal-sources` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源需要认证 · 我的空间](review.html#scene=A-personal-sourceauth) `A-personal-sourceauth` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源连接失败 · 我的空间](review.html#scene=A-personal-sourcefailed) `A-personal-sourcefailed` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源权限被拒绝 · 我的空间](review.html#scene=A-personal-sourcedenied) `A-personal-sourcedenied` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [自动化 · 我的空间](review.html#scene=A-personal-automations) `A-personal-automations` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [助手浏览器 · 我的空间](review.html#scene=A-personal-browser) `A-personal-browser` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [返回后待查询 · 我的空间](review.html#scene=A-personal-return) `A-personal-return` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [发送前积分不足 · 我的空间](review.html#scene=A-personal-preblock) `A-personal-preblock` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [生成因积分不足停止 · 我的空间](review.html#scene=A-personal-cut) `A-personal-cut` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在查询 · 我的空间](review.html#scene=A-personal-checking) `A-personal-checking` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [尚未到账 · 我的空间](review.html#scene=A-personal-notyet) `A-personal-notyet` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [查询失败 · 我的空间](review.html#scene=A-personal-queryfailed) `A-personal-queryfailed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [积分可用 · 我的空间](review.html#scene=A-personal-resumed) `A-personal-resumed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能 · 我的空间](review.html#scene=A-personal-skills) `A-personal-skills` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [获取技能 · 我的空间](review.html#scene=A-personal-discover) `A-personal-discover` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能详情 · 我的空间](review.html#scene=A-personal-acquire) `A-personal-acquire` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已启用 · 设备待准备 · 我的空间](review.html#scene=A-personal-enabledpending) `A-personal-enabledpending` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在准备本机 · 我的空间](review.html#scene=A-personal-installing) `A-personal-installing` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [设备准备失败 · 我的空间](review.html#scene=A-personal-installfailed) `A-personal-installfailed` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已安装 · 我的空间](review.html#scene=A-personal-installed) `A-personal-installed` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已启用 · 我的空间](review.html#scene=A-personal-enabled) `A-personal-enabled` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-detail) `A-personal-detail` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [版本已更新 · 我的空间](review.html#scene=A-personal-updated) `A-personal-updated` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [更新失败 · 我的空间](review.html#scene=A-personal-updatefailed) `A-personal-updatefailed` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 我的空间](review.html#scene=A-personal-remove) `A-personal-remove` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机已卸载 · 我的空间](review.html#scene=A-personal-uninstalled) `A-personal-uninstalled` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [未获授权 · 我的空间](review.html#scene=A-personal-denied) `A-personal-denied` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [最后来源失效 · 我的空间](review.html#scene=A-personal-restricted) `A-personal-restricted` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [部分来源失效 · 我的空间](review.html#scene=A-personal-fallback) `A-personal-fallback` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [来源恢复 · 我的空间](review.html#scene=A-personal-reauthorized) `A-personal-reauthorized` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [内置技能已停用 · 我的空间](review.html#scene=A-personal-builtinoff) `A-personal-builtinoff` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [内置技能已启用 · 我的空间](review.html#scene=A-personal-builtinon) `A-personal-builtinon` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [新会话 · 晨星科技](review.html#scene=A-enterprise-new) `A-enterprise-new` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [原会话 · 晨星科技](review.html#scene=A-enterprise-conversation) `A-enterprise-conversation` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在生成 · 晨星科技](review.html#scene=A-enterprise-generating) `A-enterprise-generating` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已停止 · 晨星科技](review.html#scene=A-enterprise-stopped) `A-enterprise-stopped` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [等待回答 · 晨星科技](review.html#scene=A-enterprise-question) `A-enterprise-question` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [重开后恢复问题 · 晨星科技](review.html#scene=A-enterprise-reopen) `A-enterprise-reopen` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已回答 · 晨星科技](review.html#scene=A-enterprise-answered) `A-enterprise-answered` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [暂不回答 · 晨星科技](review.html#scene=A-enterprise-deferred) `A-enterprise-deferred` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [问题已过期 · 晨星科技](review.html#scene=A-enterprise-expired) `A-enterprise-expired` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [原会话不可访问 · 晨星科技](review.html#scene=A-enterprise-deleted) `A-enterprise-deleted` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [回答未提交 · 晨星科技](review.html#scene=A-enterprise-answerfailed) `A-enterprise-answerfailed` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [网络已断开 · 晨星科技](review.html#scene=A-enterprise-offline) `A-enterprise-offline` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [服务暂时不可用 · 晨星科技](review.html#scene=A-enterprise-service) `A-enterprise-service` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [重新验证完成 · 晨星科技](review.html#scene=A-enterprise-restored) `A-enterprise-restored` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本次生成已完成 · 晨星科技](review.html#scene=A-enterprise-completezero) `A-enterprise-completezero` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [原对话附件与生成文件 · 晨星科技](review.html#scene=A-enterprise-files) `A-enterprise-files` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [查看生成文件 · 晨星科技](review.html#scene=A-enterprise-viewer) `A-enterprise-viewer` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [查看原对话附件 · 晨星科技](review.html#scene=A-enterprise-attachment) `A-enterprise-attachment` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [文件已移动或删除 · 晨星科技](review.html#scene=A-enterprise-missing) `A-enterprise-missing` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已重新选择材料 · 晨星科技](review.html#scene=A-enterprise-reselected) `A-enterprise-reselected` | 助手 / PC-F04 / D-PC-03 | SourcePoloShell + files 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源与工具 · 晨星科技](review.html#scene=A-enterprise-sources) `A-enterprise-sources` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源需要认证 · 晨星科技](review.html#scene=A-enterprise-sourceauth) `A-enterprise-sourceauth` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源连接失败 · 晨星科技](review.html#scene=A-enterprise-sourcefailed) `A-enterprise-sourcefailed` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源权限被拒绝 · 晨星科技](review.html#scene=A-enterprise-sourcedenied) `A-enterprise-sourcedenied` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [自动化 · 晨星科技](review.html#scene=A-enterprise-automations) `A-enterprise-automations` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [助手浏览器 · 晨星科技](review.html#scene=A-enterprise-browser) `A-enterprise-browser` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [返回后待查询 · 晨星科技](review.html#scene=A-enterprise-return) `A-enterprise-return` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业返回后待查询 · 晨星科技](review.html#scene=A-enterprise-ownerreturn) `A-enterprise-ownerreturn` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [发送前积分不足 · 晨星科技](review.html#scene=A-enterprise-preblock) `A-enterprise-preblock` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [生成因积分不足停止 · 晨星科技](review.html#scene=A-enterprise-cut) `A-enterprise-cut` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在查询 · 晨星科技](review.html#scene=A-enterprise-checking) `A-enterprise-checking` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [尚未到账 · 晨星科技](review.html#scene=A-enterprise-notyet) `A-enterprise-notyet` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [查询失败 · 晨星科技](review.html#scene=A-enterprise-queryfailed) `A-enterprise-queryfailed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [积分可用 · 晨星科技](review.html#scene=A-enterprise-resumed) `A-enterprise-resumed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业积分不足 · 晨星科技](review.html#scene=A-enterprise-notify) `A-enterprise-notify` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已通知所有者 · 晨星科技](review.html#scene=A-enterprise-notified) `A-enterprise-notified` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业预算已达上限 · 晨星科技](review.html#scene=A-enterprise-budget) `A-enterprise-budget` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [所有者处理企业预算 · 晨星科技](review.html#scene=A-enterprise-budgetowner) `A-enterprise-budgetowner` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [所有者处理企业积分 · 晨星科技](review.html#scene=A-enterprise-ownerblock) `A-enterprise-ownerblock` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业积分可用 · 晨星科技](review.html#scene=A-enterprise-ownerresumed) `A-enterprise-ownerresumed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能 · 晨星科技](review.html#scene=A-enterprise-skills) `A-enterprise-skills` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [获取技能 · 晨星科技](review.html#scene=A-enterprise-discover) `A-enterprise-discover` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能详情 · 晨星科技](review.html#scene=A-enterprise-acquire) `A-enterprise-acquire` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已启用 · 设备待准备 · 晨星科技](review.html#scene=A-enterprise-enabledpending) `A-enterprise-enabledpending` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在准备本机 · 晨星科技](review.html#scene=A-enterprise-installing) `A-enterprise-installing` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [设备准备失败 · 晨星科技](review.html#scene=A-enterprise-installfailed) `A-enterprise-installfailed` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已安装 · 晨星科技](review.html#scene=A-enterprise-installed) `A-enterprise-installed` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已启用 · 晨星科技](review.html#scene=A-enterprise-enabled) `A-enterprise-enabled` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-detail) `A-enterprise-detail` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [版本已更新 · 晨星科技](review.html#scene=A-enterprise-updated) `A-enterprise-updated` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [更新失败 · 晨星科技](review.html#scene=A-enterprise-updatefailed) `A-enterprise-updatefailed` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 晨星科技](review.html#scene=A-enterprise-remove) `A-enterprise-remove` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机已卸载 · 晨星科技](review.html#scene=A-enterprise-uninstalled) `A-enterprise-uninstalled` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [未获授权 · 晨星科技](review.html#scene=A-enterprise-denied) `A-enterprise-denied` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [最后来源失效 · 晨星科技](review.html#scene=A-enterprise-restricted) `A-enterprise-restricted` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [来源恢复 · 晨星科技](review.html#scene=A-enterprise-reauthorized) `A-enterprise-reauthorized` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [内置技能已停用 · 晨星科技](review.html#scene=A-enterprise-builtinoff) `A-enterprise-builtinoff` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [内置技能已启用 · 晨星科技](review.html#scene=A-enterprise-builtinon) `A-enterprise-builtinon` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-local-100-0-0) `A-personal-legacy-local-100-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-detail-100-0-0) `A-personal-legacy-detail-100-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 我的空间](review.html#scene=A-personal-legacy-remove-100-0-0) `A-personal-legacy-remove-100-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-local-100-0-1) `A-personal-legacy-local-100-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-detail-100-0-1) `A-personal-legacy-detail-100-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 我的空间](review.html#scene=A-personal-legacy-remove-100-0-1) `A-personal-legacy-remove-100-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-local-100-1-0) `A-personal-legacy-local-100-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-detail-100-1-0) `A-personal-legacy-detail-100-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 我的空间](review.html#scene=A-personal-legacy-remove-100-1-0) `A-personal-legacy-remove-100-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-local-100-1-1) `A-personal-legacy-local-100-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-detail-100-1-1) `A-personal-legacy-detail-100-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 我的空间](review.html#scene=A-personal-legacy-remove-100-1-1) `A-personal-legacy-remove-100-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-local-110-0-0) `A-personal-legacy-local-110-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-detail-110-0-0) `A-personal-legacy-detail-110-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 我的空间](review.html#scene=A-personal-legacy-remove-110-0-0) `A-personal-legacy-remove-110-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-local-110-0-1) `A-personal-legacy-local-110-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-detail-110-0-1) `A-personal-legacy-detail-110-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 我的空间](review.html#scene=A-personal-legacy-remove-110-0-1) `A-personal-legacy-remove-110-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-local-110-1-0) `A-personal-legacy-local-110-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-detail-110-1-0) `A-personal-legacy-detail-110-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 我的空间](review.html#scene=A-personal-legacy-remove-110-1-0) `A-personal-legacy-remove-110-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-local-110-1-1) `A-personal-legacy-local-110-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 我的空间](review.html#scene=A-personal-legacy-detail-110-1-1) `A-personal-legacy-detail-110-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 我的空间](review.html#scene=A-personal-legacy-remove-110-1-1) `A-personal-legacy-remove-110-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-local-100-0-0) `A-enterprise-legacy-local-100-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-detail-100-0-0) `A-enterprise-legacy-detail-100-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 晨星科技](review.html#scene=A-enterprise-legacy-remove-100-0-0) `A-enterprise-legacy-remove-100-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-local-100-0-1) `A-enterprise-legacy-local-100-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-detail-100-0-1) `A-enterprise-legacy-detail-100-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 晨星科技](review.html#scene=A-enterprise-legacy-remove-100-0-1) `A-enterprise-legacy-remove-100-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-local-100-1-0) `A-enterprise-legacy-local-100-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-detail-100-1-0) `A-enterprise-legacy-detail-100-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 晨星科技](review.html#scene=A-enterprise-legacy-remove-100-1-0) `A-enterprise-legacy-remove-100-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-local-100-1-1) `A-enterprise-legacy-local-100-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-detail-100-1-1) `A-enterprise-legacy-detail-100-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 晨星科技](review.html#scene=A-enterprise-legacy-remove-100-1-1) `A-enterprise-legacy-remove-100-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-local-110-0-0) `A-enterprise-legacy-local-110-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-detail-110-0-0) `A-enterprise-legacy-detail-110-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 晨星科技](review.html#scene=A-enterprise-legacy-remove-110-0-0) `A-enterprise-legacy-remove-110-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-local-110-0-1) `A-enterprise-legacy-local-110-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-detail-110-0-1) `A-enterprise-legacy-detail-110-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 晨星科技](review.html#scene=A-enterprise-legacy-remove-110-0-1) `A-enterprise-legacy-remove-110-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-local-110-1-0) `A-enterprise-legacy-local-110-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-detail-110-1-0) `A-enterprise-legacy-detail-110-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 晨星科技](review.html#scene=A-enterprise-legacy-remove-110-1-0) `A-enterprise-legacy-remove-110-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-local-110-1-1) `A-enterprise-legacy-local-110-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [技能版本 · 晨星科技](review.html#scene=A-enterprise-legacy-detail-110-1-1) `A-enterprise-legacy-detail-110-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载确认 · 晨星科技](review.html#scene=A-enterprise-legacy-remove-110-1-1) `A-enterprise-legacy-remove-110-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载已失效副本 · 我的空间](review.html#scene=A-personal-restricted-remove) `A-personal-restricted-remove` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已失效副本已卸载 · 我的空间](review.html#scene=A-personal-restricted-uninstalled) `A-personal-restricted-uninstalled` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 我的空间](review.html#scene=A-personal-uninstalled-100-0-0) `A-personal-uninstalled-100-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 我的空间](review.html#scene=A-personal-uninstalled-100-0-1) `A-personal-uninstalled-100-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 我的空间](review.html#scene=A-personal-uninstalled-100-1-0) `A-personal-uninstalled-100-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 我的空间](review.html#scene=A-personal-uninstalled-100-1-1) `A-personal-uninstalled-100-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 我的空间](review.html#scene=A-personal-uninstalled-110-0-0) `A-personal-uninstalled-110-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 我的空间](review.html#scene=A-personal-uninstalled-110-0-1) `A-personal-uninstalled-110-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 我的空间](review.html#scene=A-personal-uninstalled-110-1-0) `A-personal-uninstalled-110-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 我的空间](review.html#scene=A-personal-uninstalled-110-1-1) `A-personal-uninstalled-110-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [卸载已失效副本 · 晨星科技](review.html#scene=A-enterprise-restricted-remove) `A-enterprise-restricted-remove` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已失效副本已卸载 · 晨星科技](review.html#scene=A-enterprise-restricted-uninstalled) `A-enterprise-restricted-uninstalled` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 晨星科技](review.html#scene=A-enterprise-uninstalled-100-0-0) `A-enterprise-uninstalled-100-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 晨星科技](review.html#scene=A-enterprise-uninstalled-100-0-1) `A-enterprise-uninstalled-100-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 晨星科技](review.html#scene=A-enterprise-uninstalled-100-1-0) `A-enterprise-uninstalled-100-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 晨星科技](review.html#scene=A-enterprise-uninstalled-100-1-1) `A-enterprise-uninstalled-100-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 晨星科技](review.html#scene=A-enterprise-uninstalled-110-0-0) `A-enterprise-uninstalled-110-0-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 晨星科技](review.html#scene=A-enterprise-uninstalled-110-0-1) `A-enterprise-uninstalled-110-0-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 晨星科技](review.html#scene=A-enterprise-uninstalled-110-1-0) `A-enterprise-uninstalled-110-1-0` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [本机副本已卸载 · 晨星科技](review.html#scene=A-enterprise-uninstalled-110-1-1) `A-enterprise-uninstalled-110-1-1` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [暂无额外技能 · 我的空间](review.html#scene=A-personal-empty-skills) `A-personal-empty-skills` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [暂无数据源 · 我的空间](review.html#scene=A-personal-empty-sources) `A-personal-empty-sources` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源未连接 · 我的空间](review.html#scene=A-personal-sourcedisconnected) `A-personal-sourcedisconnected` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在连接数据源 · 我的空间](review.html#scene=A-personal-sourceconnecting) `A-personal-sourceconnecting` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [需要文件访问权限 · 我的空间](review.html#scene=A-personal-permission) `A-personal-permission` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [文件访问权限被拒绝 · 我的空间](review.html#scene=A-personal-permissiondenied) `A-personal-permissiondenied` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [访问权限已授予 · 我的空间](review.html#scene=A-personal-permissiongranted) `A-personal-permissiongranted` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [暂无额外技能 · 晨星科技](review.html#scene=A-enterprise-empty-skills) `A-enterprise-empty-skills` | 助手 / PC-F04 / PC-F07 / PC-F08 | SourcePoloShell + skills 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [暂无数据源 · 晨星科技](review.html#scene=A-enterprise-empty-sources) `A-enterprise-empty-sources` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [数据源未连接 · 晨星科技](review.html#scene=A-enterprise-sourcedisconnected) `A-enterprise-sourcedisconnected` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在连接数据源 · 晨星科技](review.html#scene=A-enterprise-sourceconnecting) `A-enterprise-sourceconnecting` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + sources 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [需要文件访问权限 · 晨星科技](review.html#scene=A-enterprise-permission) `A-enterprise-permission` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [文件访问权限被拒绝 · 晨星科技](review.html#scene=A-enterprise-permissiondenied) `A-enterprise-permissiondenied` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [访问权限已授予 · 晨星科技](review.html#scene=A-enterprise-permissiongranted) `A-enterprise-permissiongranted` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [生成中断后返回 · 我的空间](review.html#scene=A-personal-returnstream) `A-personal-returnstream` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在查询充值 · 我的空间](review.html#scene=A-personal-checkingstream) `A-personal-checkingstream` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [生成中断 · 未到账 · 我的空间](review.html#scene=A-personal-notyetstream) `A-personal-notyetstream` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [生成中断 · 查询失败 · 我的空间](review.html#scene=A-personal-failedstream) `A-personal-failedstream` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [生成中断 · 积分可用 · 我的空间](review.html#scene=A-personal-resumedstream) `A-personal-resumedstream` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业积分 · 正在查询 · 晨星科技](review.html#scene=A-enterprise-ownerchecking) `A-enterprise-ownerchecking` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业积分 · 尚未恢复 · 晨星科技](review.html#scene=A-enterprise-ownerpending) `A-enterprise-ownerpending` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业积分 · 查询失败 · 晨星科技](review.html#scene=A-enterprise-ownerfailed) `A-enterprise-ownerfailed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业预算 · 返回后待查询 · 晨星科技](review.html#scene=A-enterprise-budgetreturn) `A-enterprise-budgetreturn` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业预算 · 正在查询 · 晨星科技](review.html#scene=A-enterprise-budgetchecking) `A-enterprise-budgetchecking` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业预算 · 尚未恢复 · 晨星科技](review.html#scene=A-enterprise-budgetpending) `A-enterprise-budgetpending` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业预算 · 查询失败 · 晨星科技](review.html#scene=A-enterprise-budgetfailed) `A-enterprise-budgetfailed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业预算 · 已恢复可用 · 晨星科技](review.html#scene=A-enterprise-budgetresumed) `A-enterprise-budgetresumed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [恢复发送 · 我的空间](review.html#scene=A-personal-availability) `A-personal-availability` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [恢复发送 · 晨星科技](review.html#scene=A-enterprise-availability) `A-enterprise-availability` | 助手 / PC-F04 / PC-N04 / PC-F10 | SourcePoloShell + chat 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [已通知所有者调整预算 · 晨星科技](review.html#scene=A-enterprise-budgetnotified) `A-enterprise-budgetnotified` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [正在核对企业预算 · 晨星科技](review.html#scene=A-enterprise-budgetmemberchecking) `A-enterprise-budgetmemberchecking` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业预算仍受限 · 晨星科技](review.html#scene=A-enterprise-budgetmemberpending) `A-enterprise-budgetmemberpending` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [预算查询失败 · 晨星科技](review.html#scene=A-enterprise-budgetmemberfailed) `A-enterprise-budgetmemberfailed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
| [企业预算恢复 · 晨星科技](review.html#scene=A-enterprise-budgetmemberresumed) `A-enterprise-budgetmemberresumed` | 助手 / PC-N03 | SourcePoloShell + credits 共享组件；本轮状态补充 | 见 r12 浏览器证据 |
