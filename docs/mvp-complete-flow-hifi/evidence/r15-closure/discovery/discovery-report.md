verdict: revise

只读发现轮；不代表最终独立语义审查、全覆盖或生产 Acceptance。本轮无修改。证据仅写入 /tmp/polo-closure-discovery/。来源为当前唯一 SoT docs/client-journey-review/spec.md（master-r15-sot-cleanup）；原型为 docs/mvp-complete-flow-hifi/prototype.html、prototype-manifest.json，统一入口为同目录 review.html。未读旧审查结论。

## Closure
用户已有业务账号、有效空间资格、圈子权益或企业分发作品 → 桌面登录与当前空间首页 → 选定有权作品、显式操作/授权 → 正确空间打开正确 App，或明确停止/退出/恢复 → 容器、目录、运行列表与权益状态一致。业务输出和历史由第三方 App 负责；Polo 负责授权、容器和状态真实性。

## 先于页面推导的业务义务与覆盖

| 义务与权威来源 | 角色、自然入口、前置 | 页面/动作映射及终态 | 恢复及交接要求 | 本轮状态 |
|---|---|---|---|---|
| 登录、唯一个人空间、认证恢复；PC-F01/C-R01 | 有业务账号的用户，桌面启动；有效身份 | M01 LOGIN → PERSONAL-PREP → HOME-ZERO；系统生成个人空间 | 登录取消、账号暂停、准备失败不得假成功；重开重验 | 静态映射已读；账号输入校验和全部失败未浏览器覆盖 |
| 企业邀请/创建承接；PC-F05/C-R08 | 受邀人/创建者，Browser 完成事实；同账号 | M01 INVITE-BROWSER → RETURN → ENTERPRISE-READY → 主动进入 | 共享邀请待审批不得授权；错账号/冷启动/刷新失败保留原目标 | 静态映射已读；跨端真实资格与创建未验证 |
| 安全空间切换；PC-F06 | 有效个人/企业列表；当前 App/助手/后台活动 | M02 SWITCHER/CONFIRM/STOPPING/TARGET；全停后整体切换 | 取消不复活已停止；失败只重试失败项；旧回执不提交 | 场景及脚本静态覆盖；个人→企业直接首页路径缺少停止进度，待浏览器进一步确认；不记通过 |
| 当前空间完整目录和同作品来源；PC-F02/07、§13.3 | 已授权作品，首页搜索/来源筛选 | M03 HOME/ALL-APPS 与 M04 各 App；同作品去重、不同作品正确打开 | 目录加载失败不是空态；最近使用不越过撤权 | 已用 brand、growth、report 操作；发现退出后目录仍开放失权作品 F-D01 |
| 容器关闭/后台/终止；PC-F02、§13.2 | 打开的同空间 App，运行入口/标签 × | M04 RUNTIME-PERSONAL → REPORT-STOPPED | 真正停止应反映到全部运行消费者；重开不自动重发 | 浏览器 F-D02；其他 App、停止失败、后台再聚焦未全测 |
| 文件权限及准备；C-R06/PC-F02 | 用户主动选择材料，最小所选文件权限 | M04 PREPARE、PREP-FAILED、APP-CONTRACT | 拒绝留原页不执行；OS 拒绝说明设置路径，授权后主动重试 | 静态已读；OS 与真实 Runtime 无证据；不能把允许/拒绝同样回容器直接认定执行越权 |
| 个人圈子加入/订阅/续费；PC-F03 | 分享 URL/二维码、已有成员；Browser 权威价格订单 | M07 PUBLIC-WEB/RETURN、月年续费及原单结果 | 未知查原单；同账号回查；不能自动启用；无企业圈子 | 静态映射已读；新购、续费上限、错账号、支付未知未浏览器全测 |
| 圈子退出及逐来源撤权；PC-F03、D-PC-09 | 现有成员，从订阅确认退出 | M07 DETAIL-PAID-SUBSCRIPTION → LEAVE-PAID → AFTER-LEAVE | 只撤对应来源；共享作品保留，唯一来源作品不可新启；所有消费者一致 | 浏览器 F-D01；data/year 有专门 session state，但 growth/paid 未统一；最后来源恢复/重新加入待测 |
| 积分不足及主动回查；PC-N03 | 平台明确 insufficient_credit；个人/Owner vs Member | M09 APP-BANNER/BROWSER 与助手接收 | 仅主动单次查询，未到账不解除，到账不重放；保持空间/订单 | 静态已读；App 路径和 Owner/Member 跨端未浏览器全测；交其他助手审查范围复用 |
| 设置、资格管理与 Browser 返回；PC-F09 | 当前账号，有效创作者或相应企业资格 | M10 MENU/SETTINGS → Browser 交接 → 原安全上下文 | 独立鉴权；取消留原账号页；创作者/企业目标不混 | 浏览器 F-D03/F-D04；设备设置保存/失败、资格只读未全测 |
| 离线、重开、撤权；PC-F08/10 | 当前对象中断/启动，已存内容仅合法归属 | M11 OFFLINE-HOME/REOPEN/RESTRICTED | 不新开 App/助手/AI；恢复重验，再由用户决定继续 | 浏览器 F-D05；重开页静态 toast 不构成逐任务已核对证据，撤权全停未测 |
| 契约不兼容；PC-F11 | 启动/登录版本检查失败 | M11 CONTRACT/CONTRACT-DL/CONTRACT-FAIL | 取消或失败仍阻断，升级后重新检查才进入 | 浏览器 F-D06；当前允许个人业务，缺少成功重查实际演示证据 |

已延后/范围外：独立跨会话文件汇总、新 SDK/API、App 内部业务结果/统一历史、公开市场、企业圈子、管理端写操作、生产实现验收。其责任没有移回 Polo。

## Inputs and artifacts
用户负责账号认证材料、选择作品/空间、同意费用、选择文件以及明确退出/停止；系统负责空间/作品稳定身份、授权来源、版本、运行状态、订单回查上下文及恢复状态。本轮发现均是已确认规则或系统状态传播问题，不需要用户新增产品裁决。

关键产物生命周期：账号/空间资格由身份服务产生、桌面重验消费；作品授权由圈子或企业分发产生、目录/打开/技能共同消费；运行记录由容器产生、停止/后台入口/切空间共同消费；原订单由 Browser 权威支付产生、桌面主动回查消费；Browser 跳转上下文由来源账号页产生，返回须仍属原账号/空间。当前原型将部分状态编码为独立场景，造成跨页面消费者恢复 fixture 的反例。

## Findings

### F-D01 圈子退出后唯一来源作品仍能新开（pending repair）
依据：Spec PC-F03/D-PC-09（退出仅撤来源，最后来源失效才不可用）、§13.13（唯一来源应用只能重新加入）。
反例：P-M07-DETAIL-PAID-SUBSCRIPTION 的「退出圈子」→ P-M07-LEAVE-PAID「确认退出」→ P-M07-DETAIL-PAID-AFTER-LEAVE 已显示成员资格结束，但品牌语气分析仍显示打开；点顶部首页，再点 [data-app-key="brand"] 的「打开」，进入 P-M04-APP-BRAND。退出确认页已明确该作品仅晨星设计圈提供。
建议：维护逐圈子成员与逐作品有效来源状态，退出即时同步详情、首页、列表、后台和技能消费者；最后来源失效拦新启动。另一个有效来源的会议纪要整理应继续打开。复测增长圈、设计圈依次退出以及反顺序；data/year 的局部状态不应替代统一规则。
证据：unified-paid-leave-confirm.png、unified-paid-leave-result.png、unified-paid-leave-home.png、unified-paid-leave-brand-open.png；unified-browser-results.json 对应条目。

### F-D02 停止成功后运行列表将同一任务复活（pending repair）
依据：Spec PC-F02、PC-F06、§13.2 要求执行状态真实、已停止不自动重启。
反例：P-M04-RUNTIME-PERSONAL「数据报表生成器」行点「停止」→ P-M04-REPORT-STOPPED 显示后台请求已停止 → 顶栏「后台任务」→ P-M04-RUNTIME-PERSONAL，同一作品又显示「运行中」及「停止」。用户没有重新启动。
建议：以同空间同实例状态更新运行列表、顶栏数量、关闭、切空间确认；停止成功不能仅跳说明页。对报价整理停止并关闭、部分停止后取消做同类回归。
证据：unified-report-before.png、unified-report-stopped.png、unified-report-running-again.png。

### F-D03 创作者工作台误指向企业管理（pending repair）
依据：Spec PC-F09，管理交接必须按对应资格与目标。
反例：P-M10-MENU 在我的空间打开「创作者工作台（资格有效）」→ P-M10-ADMIN-BROWSER，却显示「北方贸易 · 企业管理后台」「所有者」「成员、名单和企业账单」。静态同类：P-M10-SETTINGS 与 SETTINGS-ENT 的企业管理/创作者两个按钮均指同一场景。
建议：明确区分企业目标与创作者目标的 Browser 交接摘要，保留各自资格复验与正确接收页；不要仅改按钮名称。
证据：unified-creator-before.png、unified-creator-after.png。

### F-D04 管理交接取消会强切企业空间（pending repair）
依据：Spec PC-F09（取消停留账号页）、C-R08/PC-F06（同账号安全目标重验，不能绕过切换）。
反例：从我的空间 P-M10-MENU 发起上述管理交接，P-M10-ADMIN-BROWSER 点「取消」→ P-M03-HOME-ENT，当前空间变成晨星科技；既非原我的空间，也非交接目标北方贸易，没有安全切换过程。静态「在浏览器打开」→ ADMIN-RETURN 也硬编码晨星科技。
建议：保存发起来源页与账号/空间候选，取消原路返回；实际 Browser 返回复验来源与资格后回安全原上下文，不能借返回动作变更空间。
证据：unified-creator-before.png、unified-creator-after.png、unified-creator-return.png。

### F-D05 离线页允许新打开 App，并丢失离线事实（pending repair）
依据：Spec PC-F10 明确离线不得新开 App/助手/AI 执行，恢复须重验。
反例：P-M11-OFFLINE-HOME 显示当前离线。直接点品牌语气分析「打开」→ P-M04-APP-BRAND 正常容器，离线提示消失；没有点重试连接或显示任何授权重验。页面甚至宣称「已安装的 App 能打开」，与 Spec 的新开限制冲突。Brand 不属于页面列明的后台报表实例。
建议：离线只保留当前已合法打开/保存内容的范围，首页新启动动作阻断并指向主动恢复；恢复时保留原选择并重新校验，不自动发起。
证据：unified-offline-before.png、unified-offline-app-open.png。

### F-D06 契约不兼容允许绕过升级继续业务（pending repair）
依据：Spec PC-F11「无法安全理解服务端契约时阻止业务」「未公开发布阶段不提供旧语义降级运行」「升级失败/取消留阻断页及帮助，不开放业务」。
反例：P-M11-CONTRACT 说明个人空间不受影响，点「先用个人空间」→ HOME-PERSONAL → 增长打法手册「打开」→ APP-GROWTH。静态同类 CONTRACT-DL 提供先用个人空间；CONTRACT-FAIL「暂不升级，继续使用」也直达首页。
建议：统一升级门禁、取消/失败留阻断、提供重试和帮助；新增升级完成后重验成功的明确接收状态，再进入安全首页。不需新增产品选择。
证据：unified-contract-before.png、unified-contract-after.png、unified-contract-app-open.png。

## Outside-in 后续复验
1. 已退出设计圈：共享会议纪要仍可打开；唯一来源品牌语气不能从详情、首页、最近使用、旧通知或旧 Tab 新启动。再退出增长圈后会议纪要也失权。
2. 在运行入口停止报表：回首页、运行列表、切空间确认均看到同一任务已停；用户显式新启动以前不出现运行中。
3. 我的空间打开创作者工作台：显示创作者目标；取消仍在我的空间账号页。有企业任务时从企业发起/返回也不绕过安全切换。
4. 离线选未打开的 App：保留离线与原选择，不进入已启动状态；重连后核对权限成功只恢复可操作资格。
5. 不兼容版本取消或下载失败：始终不能打开个人/企业 App、助手或执行；仅升级后重新检查成功解除门禁。

## 证据与限制
浏览器脚本 probe.py 和 probe_unified.py 直接操作真实可见控件；后者从统一 review.html 进入相应场景，再点击产品控件。browser-results.json 和 unified-browser-results.json 包含每一步可见文本与场景。fingerprints.json 记录本次文件散列；主会话已开始并发修复，之后的结果必须重新绑定新版本，不能把本次失败截图当修复后证据。

未覆盖：真实登录/API/权限/支付/安装；全部 M01 认证返回、M02 双向切换失败和旧回执、M03 全部筛选排序及重开、M04 所有对象/关闭分支与 OS 拒绝、M07 月年续费及新购全部状态、M09 角色/原订单回查、M10 资格失效与保存失败、M11 全部撤权/重開。助手 M05/M06/M08 及跨表面状态由主会话其他审查负责。读过场景不等于已验证通过。
