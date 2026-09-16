# 发布成员 Skill 启用版本化深链

Stable slice key: `poo52-skill-enablement-deeplink`  
Parent: POO-52（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

Polo 在运行中、冷启动和 single-instance 场景严格解析版本化 Skill enablement 深链，安全切换到目标 ProductSpace 并打开前置 slice 的真实入口；发布后为 POL-105 登记 schema 与最小客户端版本。

Business domain: desktop deep-link and release compatibility.

## Explicit dependencies

- 依赖 `POO-63` 完成 Acceptance、push 并集成。

## Scope

- 严格 URI：`poloai://product-spaces/v1/skill-enablement?productSpaceId={ProductSpaceId}&artifactInstanceId={ArtifactInstanceId}`。
- 只接受两个 opaque required query 与可选 `window`；拒绝未知版本/参数、重复、缺失、空白、非法编码和 owner selector。
- Main 冷启动队列、renderer ready 投递、single-instance 去重和 scope-switch generation fence。
- client release identifier、minimum version 与 polo-admin 权威文档登记/POL-105 fallback handoff。

## Non-goals

- 重做 enablement API/UI、接受 account/member/workspace selector、静默 fallback 到 personal 或在客户端仓库伪造 admin SOT。

## Interfaces

- Owns: `polo-skill-enablement-deeplink.v1`, `polo-client-deeplink-release-record.v1`.
- Consumes: `member-skill-enablement.v1`.

## Planning bound

- Product files upper: 10.
- Core changed lines upper: 500.

## Acceptance criteria

1. running/cold-start/single-instance 均只打开精确 ProductSpace/instance 的真实 enablement 入口。
2. 未知版本、缺失/重复/未知参数、空白、非法编码和 ownership selectors 全部拒绝且不落错误 workspace。
3. 深链与 ProductSpace 切换竞态只在目标 commit 且 generation 一致时投递；失败保留原空间。
4. 日志不记录完整 ID/URL；重复 OS event 不产生重复 enable action。
5. release schema、minimum version 和 POL-105 fallback 在真实 admin owner 文档登记并通过 E2E/parity/full gates。

## Re-pin gate

开始前由 release/admin 文档 owner确认登记分支、release identifier、minimum version 与 fallback；否则保持阻塞。


