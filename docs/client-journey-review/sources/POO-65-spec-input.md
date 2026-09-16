# 实现助手发送前积分阻断与人工恢复

Stable slice key: `poo49-pre-send-credit-recovery`  
Parent: POO-49（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

用户发送消息前被 ProductSpace 积分拒绝时不产生会话事实，草稿/附件/Skill 保持可编辑；按受信角色去充值或真实通知 Owner，并只在点击时查询一次恢复状态。

Business domain: assistant send transaction and billing recovery.

## Explicit dependencies

- 依赖 `POO-64` 完成 Acceptance、push 并集成，以保持确认的串行集成顺序。
- 消费 POO-47 credit recovery 和 POO-48 assistant owner scope 的已集成接口。

## Scope

- 平台 typed restriction reason/stage/eventId 与 provider/account/network errors 分类。
- accepted-before-clear 的发送事务或按 operationId 精确回滚。
- pre-send inline restriction、角色动作、真实 notify-owner、payment-center 与 click-only query 状态机。
- scope/session/generation/eventId 并发保护和普通聊天负向回归。

## Non-goals

- mid-stream partial output、自动发送/继续/retry、支付订单/账本、App Runtime 阻断。

## Interfaces

- Owns: `assistant-credit-restriction.v1`, `assistant-manual-credit-recovery.v1`.
- Consumes: POO-47 platform credit APIs, POO-48 owner scope, final assistant/Skill route.

## Planning bound

- Product files upper: 14.
- Core changed lines upper: 750.

## Acceptance criteria

1. pre-send insufficient 不创建 user/assistant/error turn，草稿、附件和 Skill 可编辑且发送被正确阻断。
2. provider 429/402、API key billing、账号禁用、网络错误、用户停止和正常完成不映射为 ProductSpace credit。
3. Owner 只打开受信支付中心；Manager/Member 只能调用真实幂等通知，payload 无敏感会话字段。
4. focus/reopen/time 产生零查询；每次按钮点击一个 request，恢复仅解锁输入且不自动发送。
5. 跨空间/session/event 迟到结果拒绝，E2E/parity/full gates 通过。

## Re-pin gate

POO-47 notify/payment/query 与 POO-48 scope API 必须解析为真实 existing 路径；高风险 Plan 接受后需技术会签。


