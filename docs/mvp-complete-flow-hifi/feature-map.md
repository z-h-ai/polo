# POO-70 · MVP 完整流程高保真 — 一页功能地图

日期：2026-09-17 · 分支 `POO-70/docs/client-journey-policy-interview` · 修订 `poo70-master-r9-v2-3` · 评审壳：[prototype.html](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fprototype.html) · 产品表面：[surface.html](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fsurface.html)

**用途**：产品 owner 用一个浏览器标签完成 MVP 全流程视觉评审。本页回答“每个模块覆盖了什么、画的是什么、依据是什么”；逐步走查见 [review.md](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Freview.md)；机器可读追溯见 [prototype-manifest.json](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fprototype-manifest.json)。

**原型形态（v2 契约）**：`surface.html` 为纯产品表面，91 场景的交互全部静态声明为 1364 条 transitions（master-r9 / D-PC-08 修订后），不含任何演示控制代码；`prototype.html` 为评审壳，集中承载页面索引、页面说明、本轮评审、故事播放与视口切换。两文件离线零网络请求，由 `validate_prototype.py` 以 manifest 精确校验（嵌入与文件 canonical 一致、边集一致、sha256 源绑定）。

**输入基线（不可混称）**：
- 产品结论权威：POO-70 `spec.md`（已接受，D-PC-04），快照存于本卡 `sources/poo70-spec.md`
- 模块方案：POO-70 `module-review.md`（M01—M11），快照存于本卡 `sources/poo70-module-review.md`
- 现状差异：POO-70 `implementation-delta-review.md`，快照存于本卡 `sources/poo70-implementation-delta-review.md`
- 设计系统：本卡 `docs/DESIGN.md`；真实样式令牌：本卡 `sources/renderer-index.css`（取自 `apps/electron/src/renderer/index.css` @ dev `01f4447c`）
- 设计 Skill（high_fidelity 绑定）：`.agents/skills/polo-ai-design-system`（revision `poo71-adopt-1`，authority = POO-41 G4 冻结稿，含 SKILL.md + 4 个 source 快照与 sha256）
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

### M02 空间切换 — 覆盖：9 屏 · 完整（集成候选 + 已确认补页）
用户价值：切空间先讲清楚代价；部分失败可恢复、可取消，且不产生半状态。
代表屏：`P-M02-SWITCHER` → `P-M02-CONFIRM` → `P-M02-STOPPING` → `P-M02-STOP-FAILED`
场景追溯：PC-F06、C-R04/C-R05
要点：无活动直切、有活动先确认；`P-M02-CONFIRM-PERSONAL` 补齐个人空间有活动时切企业的确认；全部终止后才提交切换；「取消切换」不撤销已完成的停止；目标加载失败可重试或留在原空间；无权目标从切换器移除并给原因。

### M03 首页与全部 Apps — 覆盖：11 屏 · 完整（调整关键页）
用户价值：常用 App 一步直达；个人目录聚合多个圈子的有效权益，企业目录只展示企业向本人分发的作品，来源可查、可解释。
代表屏：`P-M03-HOME-PERSONAL`、`P-M03-ALL-APPS`、`P-M03-INSPECTOR`
场景追溯：PC-F02/PC-F07、PC-N01（零常用引导）、D-PC-01/D-PC-07
要点：固定 Polo 助手 + 最多 5 个常用（上限在管理对话框生效）；零常用/真空目录/加载失败/离线缓存四种首页态；详情 inspector 给来源、版本、状态原因，“为何被阻断”不归因、只给路径。

### M04 App 容器 — 覆盖：8 屏 · 完整（调整关键页）
用户价值：App 像浏览器里的网站一样占满工作区；关闭、后台、权限都有确定行为。
代表屏：`P-M04-APP-VIEW`（中性 FDE 占位）→ `P-M04-CLOSE-ACTIVE` → `P-M04-TERM-FAILED`
场景追溯：PC-N02、D-PC-05、C-R03/C-R06
要点：App 内部全部归 FDE，原型只画占位；关闭三选项「取消 / 后台继续 / 终止并关闭」；终止失败保留标签、不出现“看似关了、后台还在跑”；OS 权限被拒给系统设置路径后由用户主动重试。

### M05 助手 · 会话 — 覆盖：5 屏 · 完整（直接复用）
用户价值：提问、停止、追问、重开恢复，全部沿用现有助手框架。
代表屏：`P-M05-CHAT` → `P-M05-STOPPED` / `P-M05-QUESTION-REOPEN`
场景追溯：PC-F04、D-PC-06
要点：G4 三栏结构与停止/追问/重开交互直接复用；停止保留已生成部分；重开恢复问题与草稿、不替用户重复提交。

### M06 助手 · 技能与数据源 — 覆盖：3 屏 · 完整（直接复用）
用户价值：技能按来源区分、授权状态如实；数据源/自动化/Browser 均为现有入口。
代表屏：`P-M06-SKILLS`（同名技能 + 授权/已启用/设备准备三态）、`P-M06-SKILL-DENIED`
场景追溯：PC-F04、D-PC-06
要点：同名技能按来源并列不合并；无授权给“联系作者”路径，不影响会话其余部分。

### M07 我的圈子 — 覆盖：11 屏 · 完整（本轮新增，需评审）
用户价值：圈子是作品来源：加入、订阅、续费、到期、退出全程有据。
代表屏：`P-M07-LIST`（个人空间稳定入口，与「全部 Apps」并列）→ `P-M07-DETAIL-FOCUS` → `P-M07-RENEW`
场景追溯：PC-F03、D-PC-07（M07 入口收口）
要点：列表/空态/免费加入/待审批/付费详情/手动续费（从到期日起算、上限 12 个月）/到期（作品保留但不能启动）/退出（先停任务、作品按来源策略处理）。

### M08 会话文件 — 覆盖：2 屏 · 完整（直接复用）
用户价值：附件与生成文件留在原对话，可找回，缺失有出路。
代表屏：`P-M08-FILES`、`P-M08-FILE-MISSING`
场景追溯：D-PC-03（不做统一文件汇总页）
要点：通过原对话打开合法可访问文件；缺失给重新选择入口、不伪造恢复。

### M09 积分不足 — 覆盖：9 屏 · 完整（本轮新增，需评审）
用户价值：不足时容器级提示、不丢内容；充值走浏览器；到账后由用户决定是否继续。
代表屏：`P-M09-PRE-BLOCK` → `P-M09-BROWSER`（交接）→ `P-M09-CHECKING` → `P-M09-RESUMED`
场景追溯：PC-N03、D-PC-04/D-PC-07
要点：发送前阻断（输入保留、发送不可用）；生成中不足保留部分输出并如实标注；App 内只用非模态横幅；企业 Member 通知 Owner、不代做额度裁决；返回后单次查询、到账只解除阻断、不自动发送/续写；用户主动停止与积分不足分开展示。

### M10 账号菜单与设置 — 覆盖：6 屏 · 完整（调整关键页）
用户价值：所有管理入口在账号菜单按资格出现；设置只管个人偏好。
代表屏：`P-M10-MENU`（企业管理/创作者工作台/充值与账单）、`P-M10-MENU-NOPRIV`
场景追溯：PC-F09、D-PC-07
要点：无资格时不显示管理入口（不灰置）；企业后台在浏览器独立登录，桌面只保留入口；返回后重新核对资格。

### M11 异常与恢复 — 覆盖：13 屏 · 完整
用户价值：任何异常都有安全落点：能重试的幂等重试，不能用的说明原因，受限时给最小出路。
代表屏：`P-M11-CONTRACT`（需要升级 Polo）→ `P-M11-CONTRACT-FAIL`；`P-M11-REVOKE`；`P-M11-REOPEN-RECOVERY`
场景追溯：PC-F08/PC-F10/PC-F11、C-R02/C-R07/C-R08、D-PC-05
要点：版本紧急阻断给升级路径（ContractGate 三态为集成候选还原）；运行中被移除先终止企业活动再回安全入口；个人也受限时只留联系管理员/退出；离线打开如实标注缓存可用范围；重开恢复核对状态、不假装完成。

---

## 3. 覆盖统计

| 模块 | 屏数 | 分类构成 | 完整度 |
| --- | --- | --- | --- |
| M01 登录与空间承接 | 14 | reuse 3 · adjust 2 · state 4 · cross 5 | 完整 |
| M02 空间切换 | 9 | integ 8 · adjust 1 | 完整（集成候选 + 已确认补页） |
| M03 首页与全部 Apps | 11 | adjust 8 · state 3 | 完整 |
| M04 App 容器 | 8 | adjust 6 · state 2 | 完整 |
| M05 助手会话 | 5 | reuse 5 | 完整（直接复用） |
| M06 技能与数据源 | 3 | reuse 3 | 完整（直接复用） |
| M07 我的圈子 | 11 | new 10 · cross 1 | 完整（新增，需评审） |
| M08 会话文件 | 2 | reuse 2 | 完整（直接复用） |
| M09 积分不足 | 9 | new 7 · state 1 · cross 1 | 完整（新增，需评审） |
| M10 账号菜单与设置 | 6 | adjust 2 · reuse 2 · state 1 · cross 1 | 完整 |
| M11 异常与恢复 | 13 | adjust 4 · state 5 · integ 4 | 完整 |
| **合计** | **91** | 91 场景 · 1364 条 transitions，全部自 `P-M01-INVITE-BROWSER` 可达（BFS 91/91） | M01—M11 全覆盖 |

---

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

---

## 5. 生成边界（原型不做什么）

- **不修改产品代码**：本卡只含文档与原型；Electron/Admin/Browser 源码零改动。
- **浏览器端只画交接卡**：邀请、支付、充值、管理后台共 8 屏标注“另一端负责”，不代表浏览器端设计。
- **App 内部为中性占位**：FDE 区域不猜测任何真实 App 的业务界面。
- **不依赖网络/账号/支付/AI**：全部数据为虚构演示数据（小王、晨星科技、数据工坊等），可离线打开。
- **dev 与集成候选不混称**：还原自 C-INT `3dc20ca` 的屏标注“集成候选已实现”；其余均以本 worktree（dev `01f4447c`）样式与 POO-70 结论为准。
- **「分支：」虚线按钮是评审入口**：无自然产品入口的失败/取消路径（登录验证码→冷启动、切换器→无权目标、重开恢复→追问恢复等）以虚线「分支：」按钮保证可达；它是评审分支入口，不是产品设计，产品化时须映射到真实触发或测试入口（review.md §6）。
- **评审 chrome 只在评审壳**：页面索引、页面说明、本轮评审、故事播放、视口切换、Back/Reset 全部在 `prototype.html`；`surface.html` 不含任何此类内容（校验器以字符串与结构双重断言）。
- **构建工具链**：`tools/extract_scenes.py`（自 v1 提取 90 场景 + 补分支边）→ `tools/build_surface.py`（组装 surface）→ `tools/build_manifest.py` / `tools/build_review.py` / `tools/sync_manifest.py` → `tools/rebuild_master_r9.py`（同步 D-PC-08 与新增确认页）→ `tools/smoke_review.py`（1364 边逐条点击核对）→ `tools/audit_viewports.py`（91×2 溢出/可达审计 + 37 张截图）。
