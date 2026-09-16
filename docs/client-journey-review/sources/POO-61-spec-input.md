# 隔离助手 Browser 与后台执行上下文

Stable slice key: `poo48-browser-executions`  
Parent: POO-48（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

Browser partition/instance、下载/截图/console/network 和助手后台执行严格属于当前 ProductSpace，切换或失败不会把旧运行绑定给新空间。

Business domain: browser and assistant execution runtime.

## Explicit dependencies

- 依赖 `POO-59` 完成 Acceptance、push 并集成。

## Scope

- Browser partition/instance list/bind/focus/destroy/session control 的 immutable owner。
- 下载、截图、console/network 与后台 execution 的路径/事件/终止隔离。
- 切换 drain、停止失败、同 ID replacement 和 generation fence。

## Non-goals

- App Runtime、全局运行中心、会话/附件存储、Skills/Sources/Automations。

## Interfaces

- Owns: `assistant-browser-scope.v1`, `assistant-execution-scope.v1`.
- Consumes: `assistant-owner-scope.v1` and POO-47 runtime termination primitives where applicable.

## Planning bound

- Product files upper: 12.
- Core changed lines upper: 650.

## Acceptance criteria

1. Cookie/partition/instance、download/screenshot/console/network 和执行事件不可跨 ProductSpace。
2. bind/focus/destroy/stop 对旧 ID、错误 owner 和 replacement fail closed。
3. 切换失败继续显示和拥有原 Browser/执行，绝不半绑定目标空间。
4. 迟到事件与回调按 generation 丢弃，不造成一帧泄漏。
5. targeted/full、E2E 和三视口门禁通过。

## Re-pin gate

确认 POO-47 和 conversation slice 的最终 owner/terminate 接口后接受 Plan。


