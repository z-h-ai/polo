# 实现 ProductSpace App Tab 生命周期

Stable slice key: `poo47-tab-lifecycle`  
Parent: POO-47（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

用户可以打开、切换、后台继续、重新打开、终止和关闭 App Tab；失败或竞态不会切错 ProductSpace、关闭错误实例或丢失可恢复状态。

Business domain: App Tab lifecycle.

## Explicit dependencies

- 依赖 `POO-54` 完成 Acceptance、push 并集成。

## Scope

- Tab 保存非秘密固定 runtime identity，不持久化 capability/credential。
- launch handoff consumer、打开/聚焦、后台继续、运行中心重新打开所需的 Tab API。
- 关闭三选项和统一的异步 close/terminate state machine。
- Cmd/Ctrl+W、Tab 关闭按钮和其他终止入口使用同一 owner-scoped primitive。
- 背景 App 内容/进程保持、终止失败和同 ID replacement 的 generation fence。

## Non-goals

- runtime gateway/注册表基础、运行中心/结果页面、文件页面和积分阻断 UI。

## Interfaces

- Owns: `app-tab-lifecycle.v1`, `app-tab-close-state.v1`.
- Consumes: `product-space-app-runtime-identity.v1`, `runtime-projection.v1`.

## Planning bound

- Product files upper: 12.
- Core changed lines upper: 600.
- Candidate areas: TabShell context/atoms/types, TabShell/TabBar/TabContent/WebAppView, launch handoff consumer and interaction tests.

## Acceptance criteria

1. 无活动执行直接关闭；有活动执行提供取消、后台继续、终止并关闭。
2. 只有 owner-scoped execution 确认 stopped 才关闭；超时、失败、scope drift 或 replacement 保持原 Tab 可恢复。
3. 后台继续后可从共享 API 重新聚焦正确版本 App，且 App 内导航仍留在同一 Tab。
4. 所有关闭入口行为一致，跨空间或迟到结果不会作用于当前 Tab。
5. POO-41/POL-94 三视口 parity 与完整门禁通过。

## Re-pin gate

从 runtime-foundation 的已集成提交解析真实 Tab/runtime API 后重写最终文件清单并接受 Plan。


