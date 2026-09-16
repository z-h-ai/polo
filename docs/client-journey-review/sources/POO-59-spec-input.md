# 隔离助手会话消息与附件上下文

Stable slice key: `poo48-conversation-attachments`  
Parent: POO-48（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

助手 Session、消息、草稿、branch/resume、附件和索引从创建到恢复始终属于一个不可变的 account + ProductSpace + workspace owner，安全切换失败时保持原空间。

Business domain: assistant conversation storage.

## Explicit dependencies

- 依赖 POO-44 完成 Acceptance、push 并集成。

## Scope

- 版本化 owner tuple、scope token/generation 和服务端 fail-closed 访问。
- Session/message/draft/branch/resume/attachment/index 的 CRUD、watch 与恢复矩阵。
- renderer atom/query reset 与 await/event generation fence。
- ownerless legacy conversation/attachment 的 deterministic migration 或 quarantine 基础。

## Non-goals

- Skills/Sources/Automations、Browser/background execution 和公开 export/import UI。

## Interfaces

- Owns: `assistant-owner-scope.v1`, `assistant-conversation-scope.v1`.
- Consumes: POO-44 real assistant shell and committed ProductSpace context.

## Planning bound

- Product files upper: 14.
- Core changed lines upper: 700.

## Acceptance criteria

1. personal-A 与 enterprise-B 的会话、消息、草稿、branch、附件和索引不可串读/串写。
2. 旧 ID、copy/resume、迟到 promise/event 必须 exact owner match，不 fallback 到当前 workspace 或 display name。
3. 切换失败保持原 owner、原视图和可重试状态；切换成功不闪现旧数据。
4. ownerless 数据只有来源可证明才迁移，否则不可见 quarantine。
5. targeted storage/IPC/UI/E2E、三视口和完整门禁通过。

## Re-pin gate

POO-44 集成后锁定真实 assistant mount/store/session 路径并重算文件与行数上界。


