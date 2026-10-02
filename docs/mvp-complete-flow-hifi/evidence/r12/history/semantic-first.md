# R12 独立语义复核：第一轮（未完成 browser 复核）

复核者：/root/semantic_review。只读复核，未读生成者 review.md、自评、旧 quality 报告。允许输入已读取：当前 `docs/client-journey-review/spec.md`、SOURCE-EVIDENCE.md、SCENE-TRACEABILITY.md、设计技能；助手最终 src/mvp、被复用 src/source/PoloShell.jsx 与 EmptyChat.jsx；统一 manifest/review/prototype。技能规范仅作为复核指令。

结论：存在明确违背已确认产品规则的逻辑问题，当前不能判 semantic passed。下列均是原型操作含义问题，不因是演示而免除。浏览器证据待接收；本轮据源码/manifest 可重现。

## F01（高）查看/取消/卸载改变了技能授权、本人启用和版本

- 场景/控件：A-{personal,enterprise}-restricted → 卸载本机副本 → remove → 取消 → detail；installed → 管理版本 → detail；updated → 管理版本 → detail。所有 legacy 组合也受影响。
- 观察：restricted 声明已失效/未启用/保留副本；remove 固定有效/已启用/就绪，取消落 detail 固定有效/已启用/1.0.0。因此点卸载甚至取消即可把已撤权限变回有效。installed 查看详情从未启用变已启用；updated 查看详情从 1.1.0 降到 1.0.0。卸载 legacy 未启用技能也落 uninstalled 固定已启用。停用内置技能还把当前圈子技能的设备状态改为内置。
- 定位：src/mvp/scenes.mjs:20-26、50-59、89-101；Assistant.jsx:36-49。
- 规则/依据：Spec PC-F04:266/268（三态区分；明确启停）；PC-F08:305（取消不能绕过拒绝）；设计技能要求三态。
- 推荐：技能实例状态独立保存 authorization/enabled/device/version/builtin；查看详情、返回、取消不改变任何状态；卸载仅改本机副本；明确启用才改本人启用。若继续纯场景建模，目标场景必须携带来源状态且保持取消返回原状态。覆盖 2 空间所有 legacy 组合。

## F02（高）原会话无权仍可打开会话文件；断网/积分阻断可经文件页或新建绕过

- 场景/控件：A-*-deleted → 查看会话文件 → files；A-*-offline/preblock/cut → 查看会话文件 → files → 发送；所有受限场景都有新建会话 → new → 发送。
- 观察：scenes.mjs:31 通用导航、38 无条件添加文件入口；35 又让所有 files 场景可发送。deleted 明示“原会话已删除或你已无权访问”，但文件页恢复固定原对话和内容。offline 通过文件页/新建恢复发送，未先重验；积分不足同理。
- 规则/依据：Spec PC-F04:267/270（合法访问、删除/无权不误投）；PC-F10:319-320（离线阻止新执行，恢复先验证）；PC-N03:333/339（阻断不能因导航解除）。
- 推荐：把 scope/session 的权限、联网、费用阻断作为独立上下文约束。导航不解除约束；无权会话不提供可读文件，合法历史可查看但发送仍禁用。仅重验/主动查询成功解除对应条件。

## F03（高）新建会话混入旧消息/附件，问题未绑定会话

- 场景/控件：任一会话输入并发送、选附件，点击新建会话；等待回答输入草稿后切其他会话。
- 观察：runtime.js drafts/submitted/attachments 只按 scope 存储，无 session ID；act(new) 没有创建或切换数据；Assistant.jsx:24 在 new 也渲染 getSubmitted(scope)。因此新建对话带出旧消息/附件；question 草稿也只是 scope:question，不能证明原问题不投到新会话。deleted 仍渲染 submitted。
- 规则/依据：Spec PC-F04:265/267/270；原对话归属与回答只投原会话。
- 推荐：最小引入会话 ID 和问题 ID，数据以 scope+session 隔离；新建创建独立空会话；新会话发送不能插入固定的旧会话 fixture（当前 generating 总会先画预置旧用户消息/回复）。保留原会话入口以验证恢复。

## F04（高）重新选择文件实际没有选择文件，直接宣称恢复

- 场景/控件：A-*-missing 的重新选择文件 → reselected → 打开文件。
- 观察：scenes.mjs:42 直接跳 reselected，没有文件选择、取消或选择成功条件；Assistant.jsx:28 继续展示旧附件名称/固定内容。
- 规则/依据：Spec PC-F04:267 明确“文件已移动/删除给明确说明与重新选择入口，不替用户伪造恢复”。
- 推荐：重新选择触发文件选择器；取消保持 missing；实际选择成功后显示新文件名/来源，绑定原会话；不要以点击按钮代替成功。

## F05（中）数据源取消认证等同连接成功，空凭证也可连接；自动化/浏览器错画 MCP 状态

- 场景/控件：A-*-sourceauth 空字段 → 保存并连接；sourceauth/sourcefailed/sourcedenied → 取消；automations/browser。
- 观察：connect、cancel 全落 sources 固定已连接（scenes:61-64，Assistant:53-57）；取消失败/权限拒绝清空阻断。automations/browser 也显示 MCP 已连接/read_file/write_file/run_command，没表现各自基线功能。
- 规则/依据：Spec PC-F04:269/271、C-R06；SCENE-TRACEABILITY 的数据源认证/取消状态、AutomationsRegion 与 BrowserEmptyState/BrowserRegion 来源；SOURCE-EVIDENCE 仅证明组件基线，不授权虚构成功。
- 推荐：空凭证阻止提交；取消返回原连接状态；认证/连接失败结果维持可重试。自动化与浏览器至少复用各自空态组件，不能把 MCP 连接表当两个功能的产品页面。

## F06（高）企业部分来源失效场景出现个人圈子授权

- 场景/控件：A-enterprise-fallback，详情/状态。
- 观察：Assistant.jsx:48 无 scope 限定，显示“晨星增长圈已失效；晨星设计圈的授权仍然有效”；相同页面来源字段又是企业共享。
- 规则/依据：Spec D-PC-08/09、PC-F07:294-295，企业不得继承个人圈子。
- 推荐：仅个人生成多圈 fallback；企业若需分发来源状态，用有依据的企业实例授权，不能拿圈子补授权。

## F07（中）充值返回“还没有”会丢失原来的部分输出状态；预算与充值混用

- 场景/控件：personal-cut → 去充值 → P-M09-BROWSER-STREAM → 返回 Polo → personal-return → 还没有；enterprise-budgetowner → 调整预算 → BROWSER-BUDGET → ownerreturn。
- 观察：personal-return 的还没有总落 preblock，Assistant.jsx fresh 包括 preblock，隐藏原部分输出；与“仅关闭询问”不符。预算也汇入 ownerreturn（处理企业额度）→ checking（正在查询本次充值结果），未保持预算阻断原因。企业 notified 固定说已通知所有者，之后查询默认充值结果，无预算分别恢复。
- 规则/依据：Spec PC-N03:334/336/338/339。
- 推荐：返回提示保留 origin（发送前/生成中/预算）与角色；还没有返回原状态而非固定 preblock；预算查询核对预算，到账不能抵消预算；查询失败/未到账保留对应原因。Owner 查询后失败也应保留 Owner 处理入口，避免变成通知自己。

## F08（中）统一故事仍宣称旧的设备启用规则与未确认共享流程

- 场景/控件：manifest S-LOCAL-SKILLS 描述“安装、启用、更新和卸载都管理这台 Mac 上的副本”；S-TEAM-SHARE 仍呈现“提交企业审核”“审核中”，4 步全部重定向同一 discover。
- 观察：助手已移除共享提交动作，但统一入口叙述仍把不存在的流程当本轮故事；启用规则与 Spec 的账号+空间+作品同步到本人设备冲突。
- 规则/依据：Spec PC-F04:266、设计技能的不迁移旧管理能力；父任务明确补已确认 MVP。
- 推荐：修订技能故事为授权/本人启用/本机准备三条状态；从活跃故事移除无依据的共享提交故事，历史旧链接可以保留中性兼容入口，不能给“审核中”结果。

## 目前已确认的正向事实（不代表审批）

- 助手真实 mvp 路径不渲染旧 Workspace 创建/切换、远程工作区、组织管理按钮；SourcePoloShell 的 mvp 分支将空间作为静态标签。
- 当前费用按钮在 assistant 内区分个人去充值与企业成员通知；查询仅由 query 动作触发，无定时查询代码；resumed 使用正常发送按钮，不提供自动续写。
- 统一 review 通过 surfaces + 两个常驻 iframe 切换，未发现为跨端跳转主动丢弃 assistant iframe；进一步需 browser 验证草稿保留和真实 DOM。
- 产品组件中未发现为评审刻意增加“模拟失败”等按钮；失败结果可从 review entries 进入。

尚未做 browser 核实、全 262 场景渲染覆盖、最终散列绑定。以上不能转写为通过结论，修复后需受影响场景重新复核。

## F09（中，遗漏）空/权限状态和实际工具权限交互覆盖不足

- 当前 assistant 场景没有空技能列表/空数据源列表，也没有工具/文件的实际权限请求、取消/拒绝后恢复场景；仅技能无授权、数据源无访问权限和连接表的“允许/询问”文案。
- 依据：Spec PC-F04:268（无额外技能不可虚构开通）、C-R02:227（真实空与失败分开）、C-R06:231（主动选择材料才请求；拒绝留原页；OS 设置路径 + 主动重试）；SCENE-TRACEABILITY 已有 ResourceEmptyPanels/PermissionRequest 源组件。
- 推荐：复用既有空态与必要权限界面，并增加对应明确 review scene。首次权限请求应由相关真实动作触达，拒绝不把连接或执行改成成功。对于声称补齐 M06 的本轮，不能只列出 read_file 允许/write_file 询问作为权限恢复的证据。
