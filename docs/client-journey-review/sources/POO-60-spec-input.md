# 隔离助手 Skills Sources 与 Automations

Stable slice key: `poo48-skills-sources-automations`  
Parent: POO-48（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

当前助手中的 Skill、Source 和 Automation 配置、授权、凭证、测试、运行、历史和 replay 只属于当前 ProductSpace owner。

Business domain: assistant tool configuration and authorization.

## Explicit dependencies

- 依赖 `POO-59` 完成 Acceptance、push 并集成。

## Scope

- Skills/Sources/Automations CRUD、permission/credential/history/run/replay 的 owner 校验。
- 共享 workspace root 下的 owner manifest、受控 scope root 和 copy-verify-switch migration。
- renderer cache/generation fence 和错误空间/不存在等价拒绝。

## Non-goals

- 新建 Skill enablement 产品入口、公开深链、Browser partition、会话存储重做。

## Interfaces

- Owns: `assistant-tools-scope.v1`.
- Consumes: `assistant-owner-scope.v1`, `assistant-conversation-scope.v1`.

## Planning bound

- Product files upper: 15.
- Core changed lines upper: 750.

## Acceptance criteria

1. personal/enterprise 间 Skill、Source、Automation 的配置、凭证、权限、历史和 replay 全部隔离。
2. renderer filter 不是安全边界；服务端每个读写、副作用和 await 后均复验 owner/generation。
3. migration 使用 copy-verify-switch；失败不把旧 scope 数据暴露给新 scope。
4. 旧 ID、旧回调和错误 owner 返回与不存在同类拒绝。
5. targeted/full、E2E 和三视口门禁通过。

## Re-pin gate

复用前置 slice 的 owner contract，禁止创建第二套 ProductSpace key 或 generation 语义。


