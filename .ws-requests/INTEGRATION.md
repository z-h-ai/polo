# .ws-requests 台单 · 集成处置记录（POO-70 HiFi，2026-09-22）

主 agent 在集成分支 `POO-70/feat/hifi-electron` 上对五份台单的逐条处置结论。

## 已接线（本次集成提交）

- **ws-space #1（AccountMenu 接线）**：已在 `tab-browser/TabShell.tsx` 挂载
  `SpaceSwitchIntegration`——`SpaceSwitchFlowProvider`（deps.commitSwitch →
  `organization.onSelectOrganization`）+ `SpaceSwitchBridge`（把 AccountMenu 空间行的
  onSelectOrganization 重定向到 `flow.requestSwitch`）+ `<SpaceSwitchFlow/>` 对话框。
  无运行活动源时退化为直切，与接入前行为一致；活动源接入后确认/停止/加载全流程自动生效。

## 集成缺口（需要后端/主进程通道或产品决策，未在本轮 renderer-only 范围内）

| 台单项 | 缺口 | 前置条件 |
| --- | --- | --- |
| WS-HOME-APPS #1 | 运行任务数据源（AppRuntimeTasksProvider 的 tasks/onStopTask/openTask） | 主进程停止通道 + SDK 后台事件 |
| WS-HOME-APPS #4 | inspector「查看运行记录」定位 | 随 #1 |
| WS-HOME-APPS #7 | 终止失败语义的真实停止通道 | 随 #1 |
| WS-HOME-APPS #8 | 通知中心数据源（含 stopAllAndSwitchSpace→安全切换确认） | 通知事件源；接线时复用本次 SpaceSwitchIntegration |
| WS-HOME-APPS #2/#3 | 圈子目录数据注入与「查看圈子详情」路由；onOpenCircleApp | 圈子服务端数据通道（另见 ws-circles 台单同项） |
| WS-HOME-APPS #5 | 常用区 vs 最近区并存收口 | 产品决策（当前两区并存，常用区为 HiFi 方向） |
| ws-circles §1/§3 | 圈子真实数据、页面路由、CreditsGate 挂到真实 composer、TabBar.account 透传管理入口 props | 服务端数据 + App.tsx 产品接线（demo 已自证） |
| ws-circles §4 | STREAM-CUT 消息内行内标注渲染（键 credits.streamCut.inlineNote 已备） | app-shell 会话渲染侧接线 |
| ws-assistant-skills #1 | 个人空间圈子 Skill 目录数据源（DiscoverableSkill） | 同圈子数据通道 |
| ws-assistant-skills #2/#3 | 启停持久化与安装动作真实化的接线点（面板已接 creatorSkillInstall/Uninstall） | 后端 enablement 字段 |
| ws-login | useAuthFlow adapter 接入 App.tsx（真实 phone-auth RPC + 空间 bootstrap） | 登录流程替换的产品决策（现有 admin 登录仍在用） |
| ws-shared → ws-home-apps | HomePage 已按约调用 HomeSurfaceSlots；circlesEntry 未注入（无数据源时不伪造入口，见 ws-circles §1） | 同圈子数据通道 |

## 原语晋升诉求（ws-login / ws-circles）

HifiActionButton / InlineAlert / SystemProgressBar / FlowButton 仍在各 WS 目录内联实现，
API 对齐 g4。晋升到 `components/hifi/` 属后续重构项（当前 5 处内联实现零冲突、行为一致），
不阻塞验收；晋升时一并统一 hifi 卡片阴影口径（login-split 的 shadow-panel→shadow-modal-small
等效替换先例，见 ws-shared 台单 §2）。

## reviewer 备注的后续项（非阻塞）

- RuntimeCenter 弹层补「全部停止并切换空间」尾部（原型 RUNTIME 场景有此 transition；随 #1/#8 接线）
- HomePage recordRecent updater 内持久化写（1c7bba20 既有遗留，幂等，低风险）
- skills-manager demo 的 PanelPreview 缺 onDeleteSkill stub（demo 内确认页早退）
- DiscoverSkillsList 翻页失败时已加载条目整体隐藏的 UX 降级
- SkillsManagerPanel 注释提到的 onSkillsChanged prop 不存在（行为由 installedFromDiscover 兜底）
- circles EXPIRED 共享作品来源行与原型措辞差、sourceFallback 键预留分支
