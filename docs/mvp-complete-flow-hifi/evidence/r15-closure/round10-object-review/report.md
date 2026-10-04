verdict: ready

# POO-70 客户端原型最终语义复查（object/obligation 视角）· r15-closure round10-object-review

评审人：zcode-subagent-object-final-r15c（全新上下文独立评审，业务对象、权限边界与生命周期视角）
评审对象：`poo70-workbench-r15-closure`（docs/mvp-complete-flow-hifi/review.html 内嵌 prototype.html + design-demos/polo-client-source-baseline/prototype.html 双表面）
方法：SoT 独立导出义务分母 → 全量渲染普查 → 真实点击链探测 → 版本稳定性核对。只读评审，除本目录外未修改任何文件，未读取任何禁止输入（evidence/ 历史报告、sources/ 其余文件、tools/、.pipeline、git 历史、CONTEXT.md 等均未读）。

## 1. 覆盖量（总量统计）

- 义务分母：23 项（PC-F01—11 共 11、PC-N01—04 共 4、C-R01—08 共 8），全部参与评审；无页面呈现的义务保留在分母并单独说明。
- 全量渲染普查：manifest 全部 **424 个场景**（mvp 188 + assistant 236）× **3 个声明视口**（desktop-1440x900 / desktop-1024x768 / desktop-800x600）= **1272 次场景×视口观测，全部成功**（nav_ok=1272/1272，场景无错位）；采集可见文本与可见控件清单存入 `raw/census.jsonl`，关键场景截图 70 张。
- 页面错误（pageerror）：**0**；外部网络请求：**0**（纯离线产物，无 http/https 加载）。
- 真实点击动作：**1371 次**（场景导航点击 1272 + 转场/动作按钮点击与输入动作 99，含少量失败重试与文件选择动作）。
- 点击链：18 条主链（round1/round2）+ 2 条聚焦链（部分停止后重确认、导入文件格式边界），每条链独立 Reset，全部经壳内 `data-scene-link` 进入起点、经原型内已渲染 `data-transition` 控件推进。
- 版本稳定性：四个产物文件 SHA-256 起止一致（见 §5）。

## 2. 闭环主线结论

按业务对象主线（producer → 来源 → 持久身份 → 验证 → 消费者 → 恢复）逐对象复核，未发现有效缺口：

- **空间/上下文**：个人与企业目录、助手会话、技能、来源筛选、运行入口强隔离（P-M03-HOME-ENT 无「我的圈子」、来源筛选仅企业来源；A-personal-* 与 A-enterprise-* 全套场景分离；切换器不含圈子/创作者/staff）。
- **作品/来源**：同一作品按稳定身份去重（首页每作品仅一卡、详情保留全部有效来源「晨星增长圈、晨星设计圈」）；逐来源失效/恢复成立——退出增长圈后共享作品仍可打开（PR1b），退出唯一来源圈后该应用只能重新加入、多来源应用仍可打开（PR2b）；到期（续费恢复）与主动退出（重新加入）入口区分正确（P-M07-EXPIRED vs P-M07-DETAIL-PAID-AFTER-LEAVE）。
- **技能本机状态**：授权/本人启用/设备准备三态分开展示；同名内置与圈子技能独立启停（PR5b：停用内置后圈子同名状态不变，且明示"不使用圈子版本，也不依赖圈子订阅"）；资格失效后卸载/取消不恢复资格、原对话保留（PR6）；运行任务不热切换版本（更新文案明示）。
- **运行记录**：终止三分支（取消/后台继续/停止并关闭）与终止失败留可恢复状态成立；运行入口与停止结果一致——部分停止（2/3）后取消切换，已停项不复活、重新确认仅列剩余 1 项（PR8b/PR8c，真实点击链跨页面状态连续）；停止失败重试后自动进入目标（PR9）；未知/进行中一律不写成成功（A-enterprise-ownerchecking 停在"正在查询"、P-M11-REVOKE 保留"停止中"）。
- **订单/订阅权益**：续费原订单身份明确（SUB-20261002-0183），同一订单重复查询结果逐字一致、不再次延长（PR3 两次查询日期完全相同）；连续权益推进以独立订单呈现；达提前购买上限不建新单、仍可查原单（PR4b）；月付 12 个日历月上限、年付下一年度周期、到期后从支付成功时刻起算均有页面承载。
- **助手消息/附件/待答问题**：发送前阻断不建消息、生成中保留部分输出、主动停止不报积分不足；Member 仅"已通知所有者"不暴露 Owner 财务；返回桌面"已完成，查询结果"单次查询、"还没有"仅关闭；解除阻断后由用户主动发送（PR10b）；待答问题提交需输入（禁用空提交）、回答仅形成一条消息原会话续答、暂不回答不续答（PR16/PR17b）。
- **导出包/导入对象**：导出仅允许内容、不含凭证/数据源/工具授权/隐藏上下文；导入先核对后确认、取消/格式失败不产生任何对象（真实文件注入验证："文件格式不受支持，未导入任何内容"）；owner 不明旧数据保持隔离不可打开（A-*-legacy-isolation）。
- **设置/管理入口**：按资格显示——个人菜单显示企业管理（北方贸易·所有者）与创作者工作台；企业 Member 上下文（小王·晨星科技·成员）账号菜单不渲染企业财务入口（渲染级反向可达图验证 P-M09-BROWSER-MENU-ENT 无任何来源按钮）；创作者资格失效仅保留责任只读且取消回原菜单（PR13）；管理交接保留所选企业对象。
- **桌面主动核对跨端**：圈子/企业/充值三组交接均为"浏览器完成只是该端事实"，返回后要求主动查询原订单/资格，且明确"返回不代表到账或刷新成功"。

## 3. 义务矩阵全表

状态取值：checked-no-gap / finding / awaiting-evidence / deferred / not-applicable。

| ID | 义务 | 入口/授权/动作/终态/恢复/交接 映射 | 状态 | 关键证据 |
| --- | --- | --- | --- | --- |
| PC-F01 | 首次登录与唯一个人空间 | 桌面启动；密码/验证码登录、取消留入口；幂等个人空间准备（失败可重试、无第二空间入口）；暂停账号拒绝 | checked-no-gap | P-M01-LOGIN-*、PERSONAL-PREP(-FAIL)、REOPEN 普查文本 |
| PC-F02 | 个人 App 找到/启动/使用/重开 | 首页完整目录（最近使用默认、频率可选）；打开→权限确认（仅本次选中文件）→准备→App Tab；关闭三分支；权限拒绝给系统设置路径+主动重试 | checked-no-gap | P-M03-HOME-*、P-M04-PREPARE/CLOSE-ACTIVE/TERM-FAILED/PERM-DENIED/BACKGROUND 普查+PR14/15 |
| PC-F03 | 圈子加入/付费/续费/退出 | 桌面无粘贴/输入分享链接入口（空态指系统浏览器）；列表「我的圈子+查看圈子内容，管理订阅」；详情「应用/技能」；退出仅在订阅区；日历月/年、12 个月上限、无自动扣款；重复查询不延长；到期/退出/重新加入入口区分 | checked-no-gap | P-M07-LIST(-RENEWED)/DETAIL-*/RENEW*/EXPIRED、PR3/PR4b/PR18b |
| PC-F04 | Skills 与助手 | 助手卡片「管理技能/打开助手」并列；同名内置/圈子分别展示、详情名称唯一；授权≠启用≠设备准备；启停独立；待答问题回答/暂不回答 | checked-no-gap | A-personal-skills/detail/builtinoff、PR5b/PR16/PR17b |
| PC-F05 | 企业邀请/创建进桌面 | 指定邀请绑定账号、共享邀请待审批不列空间；刷新失败保留成员事实可重试；错账号提示；冷启动/未安装指引 | checked-no-gap | P-M01-INVITE-*/REFRESH-FAIL/COLD-START/NOT-INSTALLED/CREATE-ENT 普查 |
| PC-F06 | 安全切换与取消 | 一次确认「停止全部并切换」；进度页已停止 n/N、无成功/失败选择按钮；取消不复活已停项；重确认按实际剩余推进；终止失败只重试失败项；目标失败留原空间 | checked-no-gap | P-M02-*、PR8b/PR8c（2/3→重确认仅剩 1 项）/PR9 |
| PC-F07 | 企业消费 | 企业目录仅分发作品；无个人圈子混入；企业空目录联系管理员；个人/企业同名实例互不覆盖；Member 无财务 | checked-no-gap | P-M03-HOME-ENT/ALL-APPS-ENT-EMPTY、A-enterprise-* 全套 |
| PC-F08 | 撤权/企业受限/作品失效 | 逐来源失效；最后来源失效才阻断并给原因；普通到期≠紧急全停≠版本暂停≠移除（分别文案）；被移除安全回个人、旧缓存不可续访问；治理暂停 Manager/Owner 动作区分 | checked-no-gap | PR1b/PR2b、P-M11-BLOCKED-*/REVOKE/ACCESS-LOST/GOVERNANCE-* |
| PC-F09 | 账号/偏好/管理跳转 | 按资格显示企业管理/创作者工作台/责任只读；当前企业非 Owner 无企业账单入口；交接保留所选企业、取消回原菜单；助手偏好未保存处理 | checked-no-gap | P-M10-MENU(-ENT/-RESPONSIBILITY)、PR12b/PR13、渲染反向可达图 |
| PC-F10 | 离线/部分结果/重开 | 离线不新开执行、本地步骤可继续；缓存明示"已保存"时间戳且在线核对失败可重试，不当授权依据；重开恢复已保存内容且任务状态逐项核对 | checked-no-gap | P-M11-OFFLINE-*/SPACE-ERROR/REOPEN-RECOVERY、A-*-offline |
| PC-F11 | 契约不兼容 | 阻断业务+升级/帮助；升级失败/取消仍阻断；成功重查后进入、原任务不自动执行 | checked-no-gap | P-M11-CONTRACT/FAIL/READY/DL/HELP 普查 |
| PC-N01 | 真空目录/无记录/加载失败 | 无使用记录仍展示授权应用；真空诚实空态；加载失败≠空（重试入口） | checked-no-gap | P-M03-HOME-ZERO/EMPTY-DIR/LOAD-FAIL、ALL-APPS-ZERO |
| PC-N02 | 重开内容归 App | 重开先恢复身份/空间/权限；不重发旧 Prompt、重新打开不自动执行 | checked-no-gap | P-M01-REOPEN、P-M11-REOPEN-RECOVERY、P-M11-REVOKE 文案 |
| PC-N03 | 积分阻断与充值人工恢复 | 发送前不建消息；生成中保留部分输出；App 非模态留在原页；Member 仅通知 Owner；单次查询、未到账/失败保留阻断、"还没有"仅关闭；解除后用户主动发送；切空间旧订单不侵入 | checked-no-gap | A-personal-preblock/cut、P-M09-APP-BANNER、PR10/PR10b、PR11 |
| PC-N04 | 待答问题与重开恢复 | 提交需内容（空提交禁用）；回答一条消息原会话续答；暂不回答不续答；重开恢复以场景承载（见限制） | checked-no-gap（重开重放子项 awaiting-evidence，见 §7） | PR16/PR17b、A-personal-answered/deferred、P-M11-REOPEN-RECOVERY |
| C-R01 | 会话/账号 | 登录过期重新验证；退出保留本机文件；账号受限页 ACC-0182 | checked-no-gap | P-M01-REOPEN、P-M11-PERSONAL-RESTRICTED |
| C-R02 | 空/失败区分 | 加载/零条/失败/受限分别呈现；失败不拿他空间缓存填充 | checked-no-gap | PC-N01 同组场景、SPACE-ERROR |
| C-R03 | 上下文一致 | 目录/助手/技能/运行随空间整体切换；圈子不是空间；owner 不明数据隔离 | checked-no-gap | A-personal-* vs A-enterprise-*、SWITCHER、legacy-isolation |
| C-R04 | 取消/中断 | 取消留原入口；已完成不被回滚；部分停止后取消不复活；未知不写成成功 | checked-no-gap | PR2b（取消退出）/PR8b/PR8c/PR18b、ownerchecking/REVOKE 文案 |
| C-R05 | 重新打开 | 先恢复身份空间、重验权限契约再显示；不自动重发 | checked-no-gap | REOPEN-RECOVERY（"任务状态已逐项核对"）、REVOKE 文案 |
| C-R06 | 桌面权限 | 仅必要权限、说明范围与费用承担；拒绝/取消留原页不启动；OS 拒绝给设置路径+用户主动重试 | checked-no-gap | P-M04-PREPARE/PERM-DENIED（含"系统设置→隐私与安全性→文件与文件夹"）、PR14 |
| C-R07 | 数据转移 | 显式 allowlist（不含凭证/隐藏上下文）；导入先核对后确认建立新对话；取消/格式失败无半成品；owner 不明隔离。两份同名材料成功分支身份区分 awaiting-evidence | checked-no-gap（同名材料子项 awaiting-evidence，见 §7） | A-*-transfer-*、PR7b、PR7d/PR4（真实文件注入失败分支）、legacy-isolation |
| C-R08 | Browser 返回 | 对端完成只是该端事实；同账号验证+自身刷新；错账号/过期目标拒绝；支付查询受单次限制 | checked-no-gap | P-M07-PAY-RETURN/RENEW-RETURN/ACCOUNT-MISMATCH/REJOIN-BROWSER、P-M01-INVITE-* |
| — | 视觉/无障碍达标 | SoT 明确页面呈现待复看、无障碍无法评估（§7 政策表） | not-applicable | 超出本轮语义评审边界 |

## 4. 输入责任（独立性声明）

- 允许输入之外未读任何文件；未运行仓库任何检查/构建脚本；未访问 git 历史与作者评审结论。
- 实际读取并核对哈希的输入：spec.md（SoT）、closure-r13-inputs.json（跨端已确认来源摘录）、prototype-manifest.json、review.html、prototype.html、quality-report.md（仅 semantic probes 方法节）。
- 全部结论只基于 SoT 正文与我对当前产物的直接渲染观察/点击观察；普查与探测的原始 JSONL、截图、脚本均保留在本目录可复核。

## 5. 产物生命周期表（版本稳定性）

| 文件 | SHA-256（开始） | SHA-256（结束） | 一致 |
| --- | --- | --- | --- |
| docs/mvp-complete-flow-hifi/prototype-manifest.json | 7b34e3bea36cc112dbaa936ce836a198f12b5edafaddf576f6faae09ebc98c47 | 同左 | 是 |
| docs/mvp-complete-flow-hifi/prototype.html | 13911b0b01d394fae7468ee01264d86c677f43b697a8a0b8c8ee82afc1f5b4c4 | 同左 | 是 |
| docs/mvp-complete-flow-hifi/review.html | 21c5514a83edeebf3a720f5b4b540dba2746224f38a802134ed96d8a4a1fd6a3 | 同左 | 是 |
| design-demos/polo-client-source-baseline/prototype.html | 0ab2e73a760d4c4fa4f3d584267e58165404e36660744d63326db05e10d77eb8 | 同左 | 是 |

起止哈希文件：`raw/hashes-start.txt`、`raw/hashes-end.txt`。评审期间产物未发生变化。

## 6. Outside-in 已执行核对清单（反例回放，均真实点击）

1. 同一订单重复查询：PR3 两次"查询原订单和资格"，结果文本逐字一致（有效至 2026-12-02），未再次延长。
2. 达上限：PR4b 达上限场景无新建订单/支付码，仍可查原单。
3. 退出顺序反例：PR1b（先退增长圈，共享作品会议纪要仍可打开）+ PR2b（再退设计圈，品牌语气分析只能重新加入、会议纪要仍可打开）；取消退出资格不变（PR2b step1 后详情仍付费有效）。
4. 同名技能独立：PR5b 停用内置→圈子同名"未启用·未安装·1.0.0"不变；启用回滚一致；PR6 失效后卸载/取消均不恢复调用资格。
5. 导入对象边界：PR7b 取消导入不建对象；真实文件注入（非约定格式）返回"文件格式不受支持，未导入任何内容"——无半成品。
6. 取消切换不复活已停任务：PR8b 到达停止进度后立即取消（0/3 全部保持运行中）；PR8c 从 2/3 取消态重新选择空间→再次确认仅列剩余 1 项（已停两项未被重新列为运行）。
7. 终止失败：PR9 重试失败项后自动完成停止并进入目标空间（STOPPING→TARGET-LOADING→HOME-PERSONAL）。
8. 角色边界：企业 Member 账号菜单无企业财务入口（渲染反向可达图：P-M09-BROWSER-MENU-ENT 无来源）；治理场景 Manager=联系所有者/Owner=浏览器处理；创作者失效仅责任只读（PR13）；管理交接取消回原菜单且保留企业对象（PR12b）。
9. Owner 充值往返：PR10 去充值→返回→"还没有"仅关闭→再次进入→单次查询→查询中定格不冒充成功；PR10b 解除后需用户主动输入并发送。
10. Member 预算：PR11 查询后停在核对中，保留"企业预算仍受限"。
11. 权限拒绝：PR14 稍后再说留原页不启动；PERM-DENIED 提供系统设置路径与主动重试。
12. 支付取消：PR18b 取消前往回详情；返回后仅核对原订单不自动到账。
13. 待答问题：PR16 暂不回答不续答；PR17b 空提交被禁用、输入后提交仅形成一条消息。
14. 关闭三分支：PR15 取消留原页/后台继续→运行入口可见/停止并关闭路径存在。
15. 渲染普查全局：424×3 视口全成功、0 pageerror、0 外部请求；已替代规则（常用配置/5 个上限/第二排导航/查看全部应用/管理本机技能/自动续费/宽限期/30 天/付款方常驻标签/英文 Skill 字样）在全部渲染文本中零残留。

## 7. 发现（findings）

无未解决有效缺口（findings=[]）。以下为覆盖限制（awaiting evidence），不构成对当前原型的有效缺口，因 SoT 本身将其排除在本阶段之外：

- **AE-1（C-R07 子项）两份同名材料导入成功分支的对象身份区分**：导入接受 `.polo-transfer` 内部格式，SoT 明确"生产 allowlist 与文件格式仍由 POO-62 实施设计确定"，离线评审无法构造合法导出包重放"预览/新对象/打开结果都指向第二份"。已验证失败分支（格式不符→不建对象）与场景文案（确认后建立新对话、打开结果属于所选文件）。状态：awaiting evidence。
- **AE-2（PC-N04 子项）重开后草稿恢复的真实重放**：原型以场景承载恢复态（REOPEN-RECOVERY"已恢复上次的对话和页面·任务状态已逐项核对"），离线原型无法真实重启进程验证草稿保留。状态：awaiting evidence。
- **AE-3**：无真实客服二维码资产（SoT 明确本轮仅覆盖未配置/加载失败），真实扫码联系不在范围。

## 8. 限制与交付边界

- 本轮为离线原型的语义评审：结论适用于 `poo70-workbench-r15-closure` 的哈希绑定产物，不等于生产验收、真实 Electron 实现、支付、跨端部署或 AI 运行验收（SoT §12/§13 同此边界）。
- 普查在每个场景前执行 Reset 后经页面索引导航，采集的是各场景独立可达状态；跨场景状态连续性由 §6 的真实点击链覆盖。
- 探测链中少量步骤依赖原型条件渲染（如"查看续费限制"按钮仅在达上限场景渲染），已改由对应状态场景直接进入并完成点击验证。
- 视觉与布局（b82fa1e5 风格、Header 分隔线等）与无障碍达标按 SoT 待用户复看/另行收口，本轮未评。
- 浏览器进程已全部关闭（含首次运行遗留的 headless shell），无残留。

## 9. 证据清单（本目录）

- `report.md`、`semantic.json`
- `raw/census.jsonl`（1272 行场景×视口观测）、`raw/census-summary.json`、`raw/census-errors.log`（空）
- `raw/probes.jsonl`、`raw/probes2.jsonl`、`raw/probes3.jsonl`、`raw/probes4.jsonl` 及对应 summary
- `raw/obligations-derived.json`（自 SoT 独立推导的义务分母）、`raw/scene-list.json`、`raw/transitions-assistant.json`
- `raw/hashes-start.txt`、`raw/hashes-end.txt`
- `census.py`、`probes.py`、`probes2.py`（评审自有脚本）
- `screenshots/`（70 张关键场景截图 @1440）
