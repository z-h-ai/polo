# 实现成员 ProductSpace Skill 启用入口

Stable slice key: `poo52-member-skill-enablement`  
Parent: POO-52（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

企业成员可在 Polo 客户端查看当前 ProductSpace 已分发但本人未启用的 Skill 实例，并启用精确 artifact instance；不可见、未分发、已撤销或错误空间请求拒绝。

Business domain: member Skill enablement authorization.

## Explicit dependencies

- 依赖 `POO-62` 完成 Acceptance、push 并集成。

## Scope

- bearer-only eligible-instance list 与 enable command；服务端从 trusted context 解析 owner/member。
- idempotent enablement、scope/generation revalidation 和错误空间/不存在等价拒绝。
- 真实助手 Skill 入口中的 eligible/enabled/processing/success/failure 状态。
- 不携带 account/member/workspace selector 的 renderer/preload/RPC 契约。

## Non-goals

- 公开 deep-link 解析/冷启动、release 登记、管理员分发/撤销、企业 Web 启用或 Skill 执行隔离重做。

## Interfaces

- Owns: `member-skill-enablement.v1`.
- Consumes: POO-48 `assistant-tools-scope.v1` and committed ProductSpace generation.

## Planning bound

- Product files upper: 12.
- Core changed lines upper: 650.

## Acceptance criteria

1. eligible list 只返回当前成员/空间已分发、可见且未启用实例。
2. enable 请求只提交 artifact instance，account/member/ProductSpace 均由 trusted context 取得并在 await 后复验。
3. 重复点击/重试幂等；撤销、错误空间、不可见实例和迟到结果 fail closed。
4. 成功仅更新精确实例状态，不污染同名或其他空间 Skill。
5. targeted/full、隔离 E2E 和三视口 parity 通过。

## Re-pin gate

必须在 POO-48 最终 Skill scope/generation API 上实施，并裁剪旧 POO-52 WIP；不得把旧失败分支作为基线。


