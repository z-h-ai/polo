<!-- POO-70:app-boundary-r6:start -->
## 最新确认：App 容器边界与剩余视觉范围（D-PC-05）

FDE 负责 App 内部交互；App 打开后占据 Polo 主要内容工作区，类似浏览器中的网站。Polo 负责容器及平台能力，不统一设计每个 App 的材料、执行和结果页面。第一条主流程至打开 App 已获认可；不扩张为所有异常或完整视觉签核。V1 内部业务样例不属于 Polo 验收，后续只画 App 占位及容器控制；原 V1 仍是上一轮页面证据，尚未重画。新 SDK/API 继续延后。

[原话与确认边界](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fsources%2Fuser-decision-r6.md) · [剩余视觉走查清单](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-coverage.md)

推荐下一条 J-PC-04：Polo 助手 → 材料 → Skills → 提问/追问 → 原对话文件与恢复。剩余场景已有功能确认；尚未页面走查，不重新询问已有结论。继续不编码。
<!-- POO-70:app-boundary-r6:end -->

# 客户端视觉走查 V1：负责人交付 App，成员使用

状态：已确认功能方案上的首次灰度页面提案；视觉尚未签核。用户指定本轮先视觉、不启动产品编码；暂不推进工程 Plan。本次只走一条共同旅程，不代表全部客户端功能已经视觉对齐。

[打开一页功能地图与可点击线框](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-v1%2Fprototype.html) · [本条共同旅程泳道图](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-v1%2Fproduct-flow.html) · [保留的原完整流程画布](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fproduct-flow.html)

## 1. 一页功能地图

本轮只走 J-PC-08：负责人建企业、邀请、导入启用，成员在桌面找到并使用 App。功能方案已确认；本次新增线框布局待视觉审阅。

|模块|能力与入口|本轮覆盖/延期|已有与待补|
|---|---|---|---|
|M01 登录与进入空间|登录、个人空间、邀请与创建返回|本轮：邀请返回；创建仅交接|登录/个人空间/刷新已有基础；跨端待验收|
|M02 个人与企业切换|空间选择、终止全部、失败返回|本轮：无活动切入企业；有活动未覆盖|切换状态机已有；全资源隔离待验收|
|M03 首页与全部 Apps|常用入口、来源/版本、个人控制|本轮：零常用、目录与空/错态|目录已有；零常用引导与闭环待补|
|M04 App 使用与运行|准备、权限、打开/关闭、同空间后台|本轮：准备、执行、错误；关闭/后台未覆盖|运行基础已有；Tab全生命周期待集成验证|
|M05 Polo 助手|对话、附件、提问/回答、停止|尚未覆盖|助手已有；全面隔离与恢复待验证|
|M06 Skills 与工具|助手内启停、来源、工具上下文|尚未覆盖|部分组件已有；授权/启用同步待补|
|M07 我的圈子|加入、详情、手动续费、退出|尚未覆盖；无市场/自动续费|关系摘要已有；详情与回跳待补|
|M08 内容与文件去向|App自管；助手文件在原对话|本轮：App结果责任；文件页延后|附件基础已有；旧聚合范围待裁剪|
|M09 积分与充值|阻断、通知Owner、单次主动查询|本轮：成员不足提示；充值往返未覆盖|计量/支付基础已有；桌面闭环待验收|
|M10 账号与管理入口|账号偏好、按资格跳浏览器后台|仅浏览器交接；设置/找回未覆盖|设置已有；资格菜单与恢复待补|
|M11 异常与重开|撤权、断网、恢复、升级指引|本轮：撤权/准备与执行失败；重开/升级未覆盖|部分限制已有；完整异常链待验证|


## 2. 故事和跨端责任

小林是启明设计的负责人，小王是新成员。小林拿到交付方提供的“报价整理 App”，希望小王用它处理客户需求表。企业后台和浏览器邀请页只显示交接摘要，真实页面布局由 POL-113 负责；本卡展示成员桌面。

| 步骤 | 谁、在哪里操作 | 操作和可观察结果 | 本轮页面 |
| --- | --- | --- | --- |
| 1 | 小林 / 浏览器企业后台 | 创建企业并承担付款责任，成为唯一 Owner；允许分步配置，不以先充值作为创建前置 | 跨端交接卡，不重画企业后台 |
| 2 | 小林 / 成员与邀请 | 发指定成员邀请；本条使用匹配账号确认后加入，共享邀请另有待审批分支 | 跨端交接卡 |
| 3 | 小林 / 企业工具页 | 上传包、检查通过，然后明确启用；全体有效成员和后续新成员都有权，无需分组 | 检查通过但未启用、检查失败、已启用交接状态 |
| 4 | 小王 / 浏览器邀请页 | 同账号确认邀请，再打开已安装 Polo；未安装则安装后同账号登录重取列表 | 成员确认/账号不符/待审批交接状态 |
| 5 | 小王 / 客户端空间列表 | 刷新有效企业列表，再主动进入启明设计，不自动切换 | 刷新前、失败、成功可选企业、访问失效 |
| 6 | 小王 / 企业首页、全部 Apps | 零常用仍能看到助手和“全部 Apps”；从企业目录核对来源、版本和状态 | 首页、目录、真空目录、加载失败 |
| 7 | 小王 / 首次准备 | 查看来源/版本与必要权限，确认后准备打开；取消不执行 | 准备确认、失败、系统权限拒绝 |
| 8 | 小王 / App 自有页面 | 选择客户需求表，核对材料，主动生成摘要；完整或部分结果由 App 展示 | 示例 App：材料、运行、停止、结果、部分输出、网络失败 |

成功路径前提：企业/成员/作品均有效，Owner 已准备本次计算所需的企业余额；企业没有个人试用积分。余额不足作为成员阻断分支演示，完整充值返回另走 M09。负责人“已启用”不能证明成员设备已准备；成员“可见”也不能证明已经执行成功。

**App 内容是演示，不是 Polo 统一结果 UI 规范。** 线框没有结果保存到 Polo 的步骤，没有独立文件页，也不产生真实邀请、通知、订单或执行。

## 3. 本次需要用页面看清楚的节点

- 刷新与切换分开：浏览器加入成功后，客户端先取得有权列表；列表出现企业后仍要用户主动选择。
- 常用与全部目录分开：零常用不是没 App。主动作是“查看全部 Apps”，不自动配置常用。
- 看得到与可打开分开：首次准备展示必要信息，权限拒绝/准备失败分别反馈；不会让用户重新加入企业来解决准备失败。
- 打开与执行分开：App 打开后先选材料，用户明确执行；平台不自动触发任务。
- 完整、部分和未知分开：示例完整结果为 3 项合计 1,950，部分结果明确只有 2 项合计 1,860；断网/未知不冒充成功。

灰度布局、按钮主次和文案位置是本轮提案。沿用已确认功能，不将临时颜色/示例 App 内页面当作新视觉规范。

## 4. 主要失败恢复

| 失败 | 在哪里恢复 | 不应发生 |
| --- | --- | --- |
| 导入检查失败/未启用 | Owner 在企业后台处理检查或明确启用；通过交接再回成员目录 | 直接放行失败包、让成员反复加入、增加逐人分发 |
| 邀请账号不符/待审批 | 浏览器换受邀账号；或等待合法审批，再返回桌面 | 用错误账号取得资格、审批前显示企业内容 |
| 企业列表刷新失败 | 桌面重刷，保留已成立成员事实 | 把 Browser 成功当桌面完成或重复加入 |
| 真正没有已启用 App | 联系企业管理员核对；管理员处理后成员重载 | 用加载错误冒充空目录或个人授权补企业授权 |
| 首次准备失败/权限拒绝 | 重试准备、处理系统权限后用户重试，或回目录 | 未许可读取文件、准备失败却标运行成功 |
| 断网/执行失败 | 核对网络与权限后回材料，用户再决定是否执行 | 恢复网络后自动重跑 |
| 部分结果 | 在 App 内看已返回部分，自行决定下一步 | 算成完整结果、推入 Polo 统一结果页 |
| 积分不足 | 成员通知 Owner，保留材料和阻断；完整查询/恢复另走 M09 | 通知后自动解除、成员看到企业财务、自动续跑 |
| 成员失权 | 阻止操作、核对停止并安全回个人；个人失败则受限页 | 继续展示企业资料、把企业内容迁个人、借重登恢复撤权 |

## 5. 本轮覆盖与尚未覆盖

“本轮已呈现/检查”表示原型的页面和按钮已检查，不是用户已确认视觉，更不是实际产品验收。

- **本轮客户端已呈现：**M01 邀请返回与刷新；M02 无运行时切入企业；M03 零常用首页/目录/空错态；M04 首次准备/权限/主动执行/停止/失败；M08 App 自管结果责任；M09 成员不足提示；M11 部分输出、断网和撤权安全恢复。
- **仅跨端交接：**负责人创建企业、邀请成员、导入/检查/启用、Owner 费用准备；邀请页账号核对/待审批。企业后台详细页面由 POL-113 走查，本卡不签核另一端视觉。
- **同模块尚未覆盖：**无邀请首登完整登录页；有活动时空间切换；配置常用/隐藏/停用/恢复；App 关闭三选项/后台重开；充值完整往返；冷启动、升级、会话过期和所有失效组合。
- **整个模块尚未页面走查：**M05 助手对话、附件和追问；M06 Skills/高级工具；M07 圈子/订阅；M10 账号偏好/管理入口；M08 助手文件与允许转移。
- **已决定延后/移出，不当作缺页：**独立文件汇总页、App 结果聚合、创作者新 SDK/API。

功能确认 D-PC-01—04 保持不变。本轮没有新发现必须重问的产品歧义；页面反馈可按场景名称或 V01-ID 定位。后续继续其他旅程，不能用这一条覆盖全部功能。

## 6. 场景映射与来源

共同旅程 J-PC-08 复用 PC-F01/02/05/07/08/10、PC-N01/02/03 和 ENT-F01/03/07 的相应边界；不重编号旧 J-PC-01—07、N-FIRST-* 或 D-PC-01—04。新增 B-PC08-* 是跨端流程分支，B-V01-* 是本轮页面操作，二者通过下表页面的同一 journey/node/state 定位。完整 Mermaid 源码见 flow.md，回写本卡正文，页面 manifest 是派生映射。

| 页面场景 | 对应节点 / 状态 | 页面责任 |
| --- | --- | --- |
| V01-MAP · 一页功能地图 | N-PC08-MAP / ready | 评审导航 |
| V01-CREATE · 负责人创建企业 | N-ENT-01 / handoff | 另一端交接摘要 |
| V01-INVITE-OWNER · 负责人邀请小王 | N-PC08-INVITE / sent | 另一端交接摘要 |
| V01-TOOLS-CHECKED · 交付包通过检查，尚未启用 | N-PC08-TOOLS / checked | 另一端交接摘要 |
| V01-TOOLS-FAILED · 工具未达到可交付条件 | N-PC08-TOOLS / failed | 另一端交接摘要 |
| V01-TOOLS-ENABLED · 负责人已完成本次交付 | N-PC08-TOOLS / enabled | 另一端交接摘要 |
| V01-INVITE-MEMBER · 成员在浏览器确认邀请 | N-FIRST-AUTH / ready | 另一端交接摘要 |
| V01-WRONG-ACCOUNT · 当前账号不匹配邀请 | N-FIRST-AUTH / rejected | 另一端交接摘要 |
| V01-PENDING · 共享邀请等待审批 | N-FIRST-AUTH / pending | 另一端交接摘要 |
| V01-SPACES · 回到 Polo，核对加入结果 | N-FIRST-SPACES / refresh | 本端线框；App内容为示例 |
| V01-SPACES-FAILED · 企业列表刷新失败 | N-FIRST-SPACES / failed | 本端线框；App内容为示例 |
| V01-SPACES-READY · 企业已出现，尚未自动切换 | N-FIRST-SPACES / ready | 本端线框；App内容为示例 |
| V01-HOME · 零常用首页，去哪里找 App | N-FIRST-HOME / ready | 本端线框；App内容为示例 |
| V01-APPS · 全部 Apps：当前企业有权目录 | N-FIRST-APPS / ready | 本端线框；App内容为示例 |
| V01-EMPTY · 当前没有可用工作 App | N-FIRST-HOME / empty | 本端线框；App内容为示例 |
| V01-CATALOG-FAILED · 目录加载失败，不是空目录 | N-FIRST-APPS / failed | 本端线框；App内容为示例 |
| V01-PREP · 首次准备与必要权限 | N-FIRST-OPEN / ready | 本端线框；App内容为示例 |
| V01-PREP-FAILED · 准备未完成 | N-FIRST-OPEN / failed | 本端线框；App内容为示例 |
| V01-PERMISSION · 所需文件权限未授予 | N-FIRST-OPEN / permission-denied | 本端线框；App内容为示例 |
| V01-APP · App 打开后，仍由用户选择材料 | N-FIRST-RUN / ready | 本端线框；App内容为示例 |
| V01-INPUT · 核对材料，再主动执行 | N-FIRST-RUN / input-ready | 本端线框；App内容为示例 |
| V01-RUNNING · App 正在处理 | N-FIRST-RUN / running | 本端线框；App内容为示例 |
| V01-RESULT · 在 App 内取得结果 | N-FIRST-RESULT / shown | 本端线框；App内容为示例 |
| V01-STOPPED · 用户停止了本次处理 | N-FIRST-RUN / stopped | 本端线框；App内容为示例 |
| V01-RUN-FAILED · 网络或执行失败 | N-FIRST-RUN / interrupted | 本端线框；App内容为示例 |
| V01-PARTIAL · 只取得部分内容 | N-FIRST-RUN / partial | 本端线框；App内容为示例 |
| V01-CREDIT · 企业计算积分不足 | N-PC08-CREDIT / blocked | 本端线框；App内容为示例 |
| V01-CREDIT-NOTIFIED · 通知 Owner 的演示反馈 | N-PC08-CREDIT / contacted | 本端线框；App内容为示例 |
| V01-REVOKED · 企业访问权已失效 | N-FIRST-RUN / revoked | 本端线框；App内容为示例 |
| V01-PERSONAL · 安全回到个人空间 | N-PC08-RECOVER / personal | 本端线框；App内容为示例 |
| V01-SAFE · 个人空间也暂不可加载 | N-PC08-RECOVER / restricted | 本端线框；App内容为示例 |

来源：POO-70 `c08ed7a0ec6853324ac92c5d4cc1b7cdcea0438fabb51e4e031a6d2f59ebdbf3`，POL-112 `c7545bbe507571abb840e75dd5891f5fb6b4c38cbc4884215389a1172e9e5545`，POL-113 `7e763b3f1f86f0a05ef5d835996f4d34f9deebe20c7c718bff9ce20f86126d9e`；完整正文快照保存在 visual-v1/sources。POL-113 的后续工程 Plan 不是本次视觉或实现授权。

## 7. 原型检查证据

- 31 个页面状态、53 个操作分支；在 1440×900 与 1024×768 两个桌面尺寸共点击验证 106 次跳转，并检查返回、重置、场景选择和直达链接。
- 无 JavaScript 异常、无横向溢出、无网络请求；离线 Mermaid 正常渲染。最后文案调整后复查受影响的 6 个页面。
- 原型 manifest 与派生流程图校验通过。这些只证明演示可用，不是实际产品执行、发布验收或用户视觉批准。
- 证据位置：本工作树 `.pipeline/sdlc/POO-70/visual-review/browser-check.json`、`targeted-check.json` 与 `screenshots/`。

## 8. 与企业端本轮线框交接

[打开 POL-113 企业端视觉走查](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-admin-dir%2FPOL-113%2Fdocs%2Fenterprise-journey-policy-interview%2Fdocs%2Fenterprise-interview-prep%2Fvisual-walkthrough-r1%2Fprototype.html)。收口时刷新发现企业端也已新增视觉提案（正文 f32091add5b8059047aa525ecce130d227f609e32811d0a47d46cec7e5581f33）；比对确认只是新增走查记录，r6 产品结论未变化。本卡保留小王/启明设计示例，另一端 Alice/甲企业是相同角色与企业的示例称谓，不是额外身份或产品分支。企业端详细创建、邀请、导入启用与付款界面在该链接；本卡仍只签核自己负责的客户端页面。
