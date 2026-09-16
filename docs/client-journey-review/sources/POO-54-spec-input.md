# 建立受信 ProductSpace App Runtime 基础

Stable slice key: `poo47-runtime-foundation`  
Parent: POO-47（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

用户从已安装 App 入口启动时，Polo 使用不可变的 account + ProductSpace + artifact instance + version 身份启动正确进程，并只通过受信 loopback capability 建立 App Run、AI 调用、结果和文件上报边界。

Business domain: App runtime trust boundary.

## Explicit dependencies

- 依赖 POO-43 完成 Acceptance、push 并集成到 `integration/pol68-g5-client`。

## Scope

- 版本化碰撞安全 runtime identity；workspaceId 保持独立字段。
- 消费 POO-43 一次性 launch handoff 和固定版本 identity。
- Main/server-core 活动执行注册表和 ProductSpace-scoped projection 基础。
- 127.0.0.1 版本化 App API、per-launch capability、进程生命周期撤销和稳定平台错误码。
- App 启动、退出、崩溃、版本替换和 scope generation 变化的 fail-closed 行为。

## Non-goals

- App Tab 关闭/后台交互、运行中心页面、最近文件页面和积分提示 UI。
- Catalog、安装授权、支付订单、App 内部任务 UI。

## Interfaces

- Owns: `product-space-app-runtime-identity.v1`, `local-app-api.v1`, `runtime-projection.v1`.
- Consumes: POO-43 launch handoff and installed-artifact resolution.

## Planning bound

- Product files upper: 18.
- Core changed lines upper: 700.
- Candidate areas: shared ProductSpace/runtime DTOs, server-core runtime registry, Electron local-app manager/gateway/handlers and isolated tests.

## Acceptance criteria

1. personal-A 与 enterprise-B 的同名 App、同 artifact 不同版本不会共享进程、capability、Run、日志或 projection。
2. App 不能自报 account、ProductSpace、version、workspace、payer 或价格；伪造、重放、过期 capability 全部拒绝。
3. Catalog 更新不改写已启动进程的固定版本，新启动才解析新版本。
4. gateway 监听失败、handoff 重复消费、scope generation 变化或进程退出均 fail closed 并撤销 capability。
5. targeted tests、typecheck、lint、完整测试和 Electron build 通过。

## Re-pin gate

POO-43 集成后重新确认真实文件、接口、测试命令、文件/行数上界；接受 Plan 后才可编码。高风险设计需绑定 Plan hash 的技术会签。

## 2026-09-09 Plan 技术签核 R1 恢复契约

- R1 verdict: `escalate`；Plan SHA-256 `dae3e280636ef9fba09e8a7e767706246638e1ef3658e241795a5d5cfc0369fe` 未获批准，不得启动 Coder。
- 新增显式前置依赖 POO-67：无会话无工具 Host LLM Executor。POO-67 必须先完成 Plan/技术会签、Review、Acceptance、push 和 Client integration；POO-54 随后从包含 POO-67 的最新 integration 重新 re-pin。
- POO-55 已明确拥有 launch handoff consumer；POO-54 只冻结并实现完整 ProductSpace START/Main runtime 合同，不提前实现 Tab/UI consumer。
- POO-56 拥有 result sink 与结果投影，POO-57 拥有 file sink 与受信文件投影；POO-54 只提供鉴权/schema/明确 unavailable 行为，不能在下游 sink 缺失时 ACK 成功。
- POO-54 保持 `todo`。跨 Workspace runtime 行为和 Static App capability 传递仍需产品/安全裁决；修订后的最终 Plan 必须重新计算路径/行数预算并绑定新的技术签核。


