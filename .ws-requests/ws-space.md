# WS-SPACE（ws-space）跨工作流诉求台单

分支：`ws-space` · 基础：集成分支 154ded3b（已含 ws-shared）

## 1. → 集成（主 agent）：AccountMenu 子菜单接线点

本工作流**未改 AccountMenu.tsx**。切换事务流的公开入口：

```tsx
import { SpaceSwitchFlowProvider, useSpaceSwitchFlow } from '@/components/organization/useSpaceSwitchFlow'
import { SpaceSwitchFlow } from '@/components/organization/SpaceSwitchFlow'
```

- App 根部挂载一次：`<SpaceSwitchFlowProvider deps={…}><AppShell /><SpaceSwitchFlow /></SpaceSwitchFlowProvider>`
  （Provider 只提供 context + 状态机，不渲染 UI；`<SpaceSwitchFlow />` 渲染 M02 七态对话框）
- 接线点：`AccountMenu.tsx` 中 space 行的
  `onClick={() => organization.onSelectOrganization(item.id)}`（约 L113）改为
  `useSpaceSwitchFlow().requestSwitch({ id: item.id, name: item.name })`；
  或由 app 层把 `onSelectOrganization` 实现为转发到 requestSwitch（不动 AccountMenu）。
- `deps`（真实环境实现，demo 用脚本注入）：
  - `getRunningActivities()`：当前空间运行项账目（App 任务 + 助手生成）——运行中心/ws-home-apps 的运行项源
  - `stopActivity(activity)`：停止单项，resolve false/throw 即失败
  - `loadTargetSpace(target)`：目录/权限/计量/助手一起加载；返回
    `{ok:true}` / `{ok:false,cause:'load-error'}` / `{ok:false,cause:'access-lost'}`
  - `commitSwitch(target)`：全部停止+加载成功后调用（实现里转发 `onSelectOrganization`）
- 无运行项时 requestSwitch 直切（跳过确认）——R9「无活动直切」。

## 2. → ws-home-apps：顶栏运行数账目（取消/失败落态）

C-R04 核心规则「取消的是切换，不撤销停止；顶栏运行数=未成功停止项数」：
flow api 暴露 `stoppedCount` / `remainingRunningCount` / `stopProgress`。
在 stopCancel / targetFailed(留在原空间) 落态后，TabBar 的运行 pill 应读取
实际运行中心状态（已停止项已在运行中心移除，失败项保留）——需要 ws-home-apps
确认停止动作与运行中心账目联动；本流程层只保证不复活已停止项。

## 3. → 集成：失权通知「查看原因」（R10/C-R05）

失权说明态已实现（`accessLost` phase，P-M02-ACCESS-LOST 同构：
原因/当前空间不受影响/联系管理员恢复）。列表移除逻辑已在 AccountMenu（R10）。
通知中心（M04）的「XX 已无法访问 → 查看原因」入口接到
`requestSwitch` 失权目标后的同一样式说明态即可（或直接复用 FactList 结构）。

## 4. 决策记录（无需动作）

- **对话框用 radix 原语直连**：`components/ui/dialog` 的 `DialogContent`
  硬编码 `popover-styled`（app 主题）且内部 Overlay 无法注入 hifi 类；
  本工作流用同一依赖 `@radix-ui/react-dialog` 的 Root/Overlay/Content +
  `--hifi-*` token 还原 g4 `.modal-layer`/`.switch-dialog`（overlay 用
  `bg-hifi-overlay`，g4 shadow-panel 无白名单类，用 `shadow-modal-small`）。
  未新增共享 UI 原语、未新增 token。
- **demo 归类 'Browser'**：registry 的 `categoryOrder` 不含更贴切的
  'Settings'（追加需要超出「一行 import + 一行 spread」的 index.ts 改动）。
- **stopping 态底部只保留两个真实控件**（取消切换 + 禁用 spinner）；
  原型第三个「停止全部并切换」按钮是评审壳跳转注入，非产品控件。
- i18n：`spaceSwitch.*` 47 键 × 7 locale；计数插值用 `{{total}}`/`{{stopped}}`/`{{failed}}`
  （避开 i18next 的 `count` 复数语义）；场景级按钮文案未复用 `common.retry`（按 ws-shared 决策记录）。
