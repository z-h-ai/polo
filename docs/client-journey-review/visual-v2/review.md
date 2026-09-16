<!-- POO-70:assistant-accepted-r7:start -->
## 已确认：助手流程与现有框架直接复用（D-PC-06）

用户确认上一轮文字流程，并明确现有 AI 助手功能已经实现、流程已跑通、整体框架直接复用。已有对话、附件、Skills、追问及既有恢复交互沿用；助手本条走查收口。V2 线框保留为历史演示，不作为重做要求，也不再作为待视觉批准的实施前置。

[已确认助手文字流程](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fassistant-user-flows.md) · [确认原话与固定依据](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fsources%2Fuser-decision-r7.md)

其他客户端旅程继续分别走查。下一条为 J-PC-02：运行中从企业切到个人空间，先用文字说明场景。已有共享规则和 D-PC-01—05 均保留，不编码。
<!-- POO-70:assistant-accepted-r7:end -->

<!-- POO-70:assistant-text-review:start -->
## 当前方式：先用文字核对助手流程

[助手用户流程与场景（文字版）](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fassistant-user-flows.md)

用户指出 Skills、附件等能力已有实现，要求先用文字描述场景。正常能力直接沿用，重点核对空间/授权、等待回答、失败恢复和原对话内容；不将 V2 线框默认作为改版要求。本文说明产品预期，尚不声称已经完成实际实现差异审计。沿用已有功能确认，未新增产品决定、视觉批准或编码授权。

<!-- POO-70:assistant-text-review:end -->

# 第二条视觉旅程：Polo 助手、Skills 与原对话文件

状态：功能沿 D-PC-04，FDE App 责任沿 D-PC-05；本次只是 Polo 自有助手的灰度页面提案。用户尚未确认本轮布局，未启动产品编码。不会把前一条“至打开 App 没问题”扩张为此条已批准。

[打开可点击线框](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-v2%2Fprototype.html) · [已有完整流程画布，选择 J-PC-04](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fproduct-flow.html) · [剩余视觉清单](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fclient-journey-review%2Fvisual-coverage.md)

## 故事：小王整理一份客户需求

前提：小王已在启明设计企业空间，成员资格与本次计算条件有效；企业已提供“需求整理”Skill，但小王尚未启用，本机也未准备。示例材料与 Skill 名称不形成新的业务能力承诺。

| 步骤 | 页面、动作与可观察结果 | 对应节点 |
| --- | --- | --- |
| 1 | 首页固定助手 → 企业对话空状态 → 新建对话；没有其他空间的历史 | N-ASSIST-LIST / empty |
| 2 | 输入任务，选择“客户需求表.csv”；发送前可编辑；演示文件来自内置样例 | N-ASSIST-CHAT / ready、material-ready |
| 3 | 在助手内管理 Skills，查看企业来源、版本与当前使用资格；明确点“启用需求整理” | N-ASSIST-SKILL / ready |
| 4 | 启用选择已保存，但本机仍在准备；成功后返回对话。准备失败保留本人启用，不冒充授权失效 | N-ASSIST-SKILL / preparing、enabled、prepare-failed |
| 5 | 用户主动发送；助手按任务需要使用仍有权且已启用的能力。Skill 是可选能力，不作为普通提问前置 | N-ASSIST-CHAT / running |
| 6 | 助手询问摘要读者；小王可选内部项目组/客户，并填写补充说明；提交产生一条可读回答，继续原任务 | N-ASSIST-QUESTION / ready、answered |
| 7 | 完整回复及“需求摘要.md”实际保存在原对话；点文件预览；回列表重新打开原对话，不重新生成 | N-ASSIST-CHAT / saved、reopened、file-open |

画面让三个状态各自可见：**有使用资格 / 本人已启用 / 当前设备已准备**。本人启用按本人和当前空间保存并同步，不替其他成员启用；不将个人 Skill 带入企业。

## 怎样点击

主路径：新建对话 → 选择示例材料 → 管理 Skills → 启用需求整理 → 顶部“模拟设备准备成功” → 回到对话 → 发送消息 → 顶部“模拟助手需要补充信息” → 填写并提交回答 → 顶部“模拟完整回复已保存” → 打开文件 → 返回原对话 → 回到对话列表 → 重新打开。

顶部深色区是走查控制，不是产品按钮。选择材料仅载入内置数据；AI 返回、网络异常与其他设备状态由这里模拟。实际产品不要求用户手工宣布“处理成功”。输入消息、选择回答、编辑补充说明会真实反映到后续演示页面；不请求真实网络、文件、AI 或权限。

## 失败恢复与取消

| 情况 | 原型中的恢复 | 保留的规则 |
| --- | --- | --- |
| 文件权限拒绝 | 重新选择材料或返回编辑 | 未读取文件，不发起依赖它的生成 |
| Skill 准备失败 | 重试准备，或停用返回对话 | 授权、本人启用、本机准备不同 |
| Skill 启用/调用前失权 | 拒绝并返回对话，用户重新考虑能力与任务 | 不用旧记录绕过授权 |
| 主动停止 | 保留已保存部分，回输入 | 不写成积分不足，不自动续写 |
| 网络中断 | 部分内容 → 检查连接和会话 → 写新消息 → 主动发送 | 联网不自动续写或重发 |
| 暂不回答追问 | 停在等待状态，以后回仍有效问题 | 不生成答案，不触发自动继续 |
| 回答提交结果未知 | 核对原问题状态；本例查询到已接收，展示一条回答与真实进度 | 不直接重复提交 |
| 问题已被另一设备回答 | 展示实际状态，本地草稿不再次提交 | 不转投其他会话 |
| 问题期间重开 | 模拟重新核验原空间与原会话，恢复该问题已有草稿，用户继续编辑 | 本功能已有恢复，不扩张为全部表单恢复 |
| 文件已删除/移动 | 明确找不到；重新选择已有备份只形成新附件待发送 | 不伪造找回，不自动生成 |
| 原会话已删除/无权 | 不展示内容，回有权入口 | 不把企业资料、草稿或回答搬到新会话 |

## 本轮覆盖与仍未覆盖

- 已制作并由 Agent 检查：M05 助手主路径与上述恢复；M06 Skill 明确启用/停用、准备及失权；M08 原对话文件预览、重开和缺失反馈。**待用户视觉走查，不等于接受或实现验收。**
- 本条未展开：Skills 多来源同名/版本深链/其他设备同步全过程；Sources、Automations、Browser 和高级工具深层配置；助手允许的跨空间导出/导入；所有模型/附件类型。
- 仍需其他旅程：J-PC-02 运行中切空间、J-PC-03 完整充值往返、J-PC-05 圈子、J-PC-06 账号/失效/升级、J-PC-07 App 容器运行管理、首页个人控制、无邀请首登。
- 前条 D-PC-05 保持：App 内部业务设计由 FDE 负责，不在这里重新画 App 业务页；独立文件汇总及新创作者 SDK/API 延后。

## 来源与编号

本条复用 J-PC-04、N-ASSIST-LIST/SKILL/CHAT/QUESTION。原有 state 保留含义，A02-*、B-A02-* 仅细化本轮页面与动作；新 state 是既有规则下的页面细分，不替换旧节点/分支或增加产品批准。原 flow.json/product-flow.html 原样保留；Spec/本卡正文仍为结论权威。来源正文、完整模块方案和 Spec 的快照及哈希见 prototype-manifest.json。

| 页面 ID | 节点 / 状态 | 页面 |
| --- | --- | --- |
| A02-EMPTY | N-ASSIST-LIST / empty | 当前企业还没有助手对话 |
| A02-COMPOSE | N-ASSIST-CHAT / ready | 新建对话，选择材料 |
| A02-FILE-DENIED | N-ASSIST-CHAT / denied | 所选材料无法读取 |
| A02-MATERIAL | N-ASSIST-CHAT / material-ready | 材料已选，去启用 Skill |
| A02-SKILLS | N-ASSIST-SKILL / ready | 当前空间的 Skills |
| A02-ENABLED | N-ASSIST-SKILL / preparing | 已启用，本机仍在准备 |
| A02-PREP-FAILED | N-ASSIST-SKILL / prepare-failed | 设备准备失败，启用选择仍保留 |
| A02-READY | N-ASSIST-SKILL / enabled | Skill 已可供当前助手使用 |
| A02-SKILL-DENIED | N-ASSIST-SKILL / denied | Skill 不再允许使用 |
| A02-PREPARED | N-ASSIST-CHAT / skill-ready | 核对输入，主动发送 |
| A02-RUNNING | N-ASSIST-CHAT / running | 助手正在处理材料 |
| A02-STOPPED | N-ASSIST-CHAT / stopped | 已主动停止生成 |
| A02-PARTIAL | N-ASSIST-CHAT / partial | 网络中断，保留实际部分 |
| A02-RECOVERED | N-ASSIST-CHAT / recovered | 连接恢复，仍由用户决定下一步 |
| A02-FOLLOWUP | N-ASSIST-CHAT / followup | 保留历史，再写一条消息 |
| A02-FOLLOWUP-RUNNING | N-ASSIST-CHAT / followup-running | 主动发送的新消息在处理 |
| A02-QUESTION | N-ASSIST-QUESTION / ready | 助手等你回答 |
| A02-QUESTION-RESTORED | N-ASSIST-QUESTION / restored | 回到原问题，保留已有回答草稿 |
| A02-DEFERRED | N-ASSIST-QUESTION / cancelled | 暂不回答，助手不会继续 |
| A02-UNKNOWN | N-ASSIST-QUESTION / submit-unknown | 回答提交状态尚未确定 |
| A02-ANSWERED | N-ASSIST-QUESTION / answered | 原会话只有一条回答，继续处理 |
| A02-STALE | N-ASSIST-QUESTION / stale | 问题已被其他设备回答 |
| A02-LATEST | N-ASSIST-QUESTION / latest | 查看服务端已有回答 |
| A02-RESULT | N-ASSIST-CHAT / saved | 回复与生成文件在原对话 |
| A02-LIST | N-ASSIST-LIST / ready | 从当前空间对话列表找回 |
| A02-REOPENED | N-ASSIST-CHAT / reopened | 重新打开已保存的原对话 |
| A02-FILE | N-ASSIST-CHAT / file-open | 从原对话打开生成文件 |
| A02-FILE-MISSING | N-ASSIST-CHAT / missing | 原文件已经不存在 |
| A02-RESELECTED | N-ASSIST-CHAT / replacement-selected | 选择了新附件，未恢复旧文件 |
| A02-NO-ACCESS | N-ASSIST-CHAT / unavailable | 原会话已删除或不可访问 |

## 待决事项

没有新增必须重问的产品规则。Skills 面板布局、三状态提示和追问/文件呈现是本次待视觉审阅的设计；如用户反馈改变产品结果，再单独记录变更决定。

## 原型检查证据

30 个页面状态、56 个操作分支；1440×900 与 1024×768 两个桌面尺寸共验证 112 次页面跳转，返回、重置、场景切换、直达链接均通过。未发现脚本异常、横向溢出或网络请求。补充检查了用户编辑消息、追问选项/草稿、提交未知后仅一条回答、文件读者一致、原对话重开及部分输出后新消息保留；最后调整只复查受影响的后续消息路径与重置。manifest 校验通过。

证据位于本工作树 `.pipeline/sdlc/POO-70/assistant-review/` 的 browser-check.json、interaction-check.json 和 screenshots。仅证明离线演示可操作，不是实际产品执行、真实持久化或正式验收。
