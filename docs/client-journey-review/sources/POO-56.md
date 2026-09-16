# 实现运行中心与任务结果统一投影

Stable slice key: `poo47-runtime-center-results`  
Parent: POO-47（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

当前 ProductSpace 的运行中心和“任务与结果”显示同一份活动、后台、失败、终止、历史与已保存结果事实，并能重新打开正确的 App。

Business domain: execution history and results.

## Explicit dependencies

- 依赖 `POO-55` 完成 Acceptance、push 并集成。

## Scope

- 扩展唯一 runtime projection 的历史、终态、结果摘要与订阅 revision。
- Runtime Center popover、Tasks & Results 内置页面和 Home/TopBar 唯一入口。
- reconnect 全量刷新、scope commit 清空旧快照、迟到事件拒绝。
- reopen 和普通 owner-scoped terminate 操作。

## Non-goals

- App 内部结果页、抓取 App 页面内容、自动把任务完成当作已保存结果、最近文件和积分 UI。

## Interfaces

- Owns: `runtime-center-view.v1`, `task-results-view.v1`.
- Consumes: `runtime-projection.v1`, `app-tab-lifecycle.v1`.

## Planning bound

- Product files upper: 10.
- Core changed lines upper: 600.

## Acceptance criteria

1. 顶部运行中心和“任务与结果”对同一 execution 始终显示相同状态和固定版本。
2. personal/enterprise、workspace 和不同版本的历史/结果严格隔离。
3. reconnect、切换和迟到推送不闪现旧 ProductSpace 数据。
4. 已保存结果只来自 App 显式声明的摘要/关联文件，不保存 Prompt 或输出正文。
5. 三视口视觉、交互、targeted/full gates 通过。

## Re-pin gate

Tab 生命周期集成后确认 projection 与 shell 的唯一 owner，禁止建立第二份 renderer 状态源。


