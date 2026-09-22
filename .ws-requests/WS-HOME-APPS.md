# WS-HOME-APPS 跨 WS 诉求台单（POO-70）

分支：`ws-home-apps`。本文件列出本工作流交付中留给主 agent / 其他 WS 的接线点与数据契约。

## 1. 运行任务数据源（主 agent，最高优先）

- 组件：`components/tab-browser/AppRuntimeTasksContext.tsx` 的 `AppRuntimeTasksProvider`。
- 现状：Provider 未在产品内挂载（默认 context 为空），TabBar 行为与接入前完全一致；运行 pill、关闭三选项拦截、运行状态中心全部就绪，仅等数据。
- 诉求：把真实运行事件（App SDK 后台请求 + 助手生成任务）接入 Provider：
  - `tasks: RuntimeTask[]`（受控；停止成功后由调用方移除条目）
  - `onStopTask(task) => Promise<void>`（失败 reject；映射到主进程停止通道）
  - `openTask(task)`（聚焦产生任务的标签页；未提供时运行中心不显示「打开」）
  - 建议挂载点：TabShell 根（`components/tab-browser/TabShell.tsx` 外层）。
- TabBar 已内置：运行 pill（`runningCount > 0` 时出现，点击开合运行中心弹层）；关闭按钮拦截（`runningTasksForTab` 命中先弹 `AppCloseDialog`）。

## 2. 圈子来源目录数据（ws-circles-account）

- 契约形状：`CircleSourcedApp { appId, name, iconUrl?, sources: { circleId, circleName, creator, valid }[] }`（定义在 `components/tab-browser/AllAppsPage.tsx`）。
- 现状：HomePage 内 `circleSourcedApps` 为空数组（标注点在 HomePage.tsx），目录页圈子区不出现；去重（D-PC-09）、blocked、inspector 圈子来源展示已由单测与 demo 覆盖。
- 诉求：确认真实来源数据结构并注入 HomePage；同时提供圈子应用的打开通道（AllAppsPage 的 `onOpenCircleApp`，未传时「打开」按钮不渲染）。

## 3. 「查看圈子详情」入口（ws-circles-account）

- AllAppsPage 圈子卡预留了到圈子详情页（P-M07-DETAIL-*）的跳转，但跳转能力归 ws-circles；需要其提供路由/回调后补一行按钮。

## 4. inspector「查看运行记录」（主 agent，随 #1）

- `AppInspector` 的 `onViewRuntime` prop 已预留；接线后应打开运行中心并定位该应用的条目。

## 5. 常用区与「最近使用」并存（主 agent 收口决策）

- 本分支落地了 HiFi 常用区（固定助手卡 + 用户自选 ≤5，`home-pinned-apps` 本设备偏好）。
- 既有「最近使用」自动记录区保留（既有测试依赖），当前两区并存；HiFi 方向以常用区为准，主 agent 可决定合并或移除最近区。

## 6. 空间类型判定（ws-space）

- HomePage 以 `activeOrganization?.type === 'creator_space'` 判定个人空间（企业空间隐藏常用区/我的圈子/外部快捷方式，D-PC-08）。若空间类型口径调整请同步。

## 7. 终止失败语义（主 agent，接入 #1 时对齐）

- `AppCloseDialog.onStopTasks(tasks) => Promise<RuntimeTask[]>`：resolve 值为停止失败的子集；空数组 = 全部成功 → 关闭标签。取消/返回不复活已停止任务（C-R03）。

## 8. 通知中心数据源（主 agent，P-M04-NOTIFY-*）

- 组件：`components/tab-browser/AppNotificationsContext.tsx` 的 `AppNotificationsProvider` + `components/tab-browser/NotificationCenter.tsx`。
- 现状：Provider 未在产品内挂载（默认 context 为空），TabBar 不出现铃铛，行为与接入前完全一致；demo（`registry/app-container.tsx` P-M04-NOTIFY-ENT/-PERSONAL）与组件单测已覆盖。
- 诉求：把真实通知事件接入 Provider：
  - `notifications: AppNotification[]`（受控；新通知在前；`{ id, kind: access|background|version|assistant|app, title, description?, timeLabel?, unread?, onOpen }`）
  - `onOpen` 为整行点击的主操作：失权「查看原因」→ inspector/失权说明；后台完成 → 打开运行中心；圈子新版本 → 圈子详情（ws-circles 路由）。
  - `onStopAllAndSwitchSpace`（可选）：企业空间弹层尾部「全部停止并切换空间」；应先走安全切换确认（与 #1 的停止通道共用），再进入空间切换流程。
  - 建议挂载点：与 #1 同层（TabShell 根）；已读状态（打开弹层/点击行清圆点）由调用方在 `notifications` 中维护。
