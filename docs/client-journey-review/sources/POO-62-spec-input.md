# 实现助手跨空间显式导出导入与旧数据隔离

Stable slice key: `poo48-export-import-quarantine`  
Parent: POO-48（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

用户只有通过显式、可见且 allowlisted 的导出/导入才能跨 ProductSpace 搬运允许的数据；不可证明 owner 的旧记录保持 quarantine，不被静默归到当前空间。

Business domain: cross-scope data transfer and migration closure.

## Explicit dependencies

- 依赖 `POO-60` 和 `POO-61` 均完成 Acceptance、push 并集成。

## Scope

- 对会话、附件、工具配置和可转移文件定义显式 export allowlist。
- 剥离隐藏 Prompt/message/tool state/credential/permission/绝对 owner path/runtime key。
- 导入在目标 scope 创建新对象，不保留源 scope 可调用引用。
- 汇总 legacy migration/quarantine 结果和跨资源 E2E。

## Non-goals

- 自动同步、隐式搬运、跨空间共享 credential、恢复源对象引用或改变前置 slices 的 owner 模型。

## Interfaces

- Owns: `assistant-scope-export.v1`, `assistant-scope-import.v1`, `legacy-owner-quarantine.v1`.
- Consumes: all POO-48 resource scope interfaces.

## Planning bound

- Product files upper: 10.
- Core changed lines upper: 500.

## Acceptance criteria

1. canary payload 证明 Prompt、隐藏消息、tool state、permission、credential、owner path/key 全部被剥离。
2. 导入对象只属于目标 trusted owner，源 ID/路径不能继续调用。
3. ownerless 旧数据仅在 provenance 可机器证明时迁移，否则 quarantine 且跨 scope 不可见。
4. 中断/失败不会产生一半迁移或把旧读路径暴露给其他空间。
5. 全资源跨空间 E2E、回滚、三视口和完整门禁通过。

## Re-pin gate

两个资源 slice 集成后根据真实 schema 编写最终 allowlist/migration Plan；高风险设计需技术会签。


