# 实现 App 平台积分阻断与人工恢复

Stable slice key: `poo47-app-credit-recovery`  
Parent: POO-47（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

App 因 ProductSpace 积分不足停止时保持打开和可理解状态；Owner 可去充值，Manager/Member 可真实通知 Owner，充值后只由用户点击查询一次且不自动重试任务。

Business domain: billing restriction and recovery.

## Explicit dependencies

- 依赖 `POO-54` 完成 Acceptance、push 并集成。
- 消费已完成的 POL-102/POL-103 按量计费和恢复查询事实。

## Scope

- 只接受平台 typed `insufficient_credit`，不从 402/429/文案/余额推断。
- 当前 App Tab 非模态平台提示和角色动作。
- 服务端受信 payment-center URL、幂等 notify-owner command、click-only recovery query。
- `restrictionEventId`、scope generation 和迟到结果防护；敏感字段最小化。

## Non-goals

- 固定报价、余额/Token/模型展示、订单创建、轮询、自动 App Run 重试或 App 内部 UI。

## Interfaces

- Owns: `platform-credit-restriction.v1`, `notify-owner.v1`, `manual-credit-query.v1`.
- Consumes: `runtime-projection.v1`, POL-102/POL-103 billing facts.

## Planning bound

- Product files upper: 10.
- Core changed lines upper: 600.

## Acceptance criteria

1. typed insufficient fact 保持 App/WebView 挂载；普通 provider 429/402、网络或账号错误不显示 ProductSpace 积分提示。
2. Owner 只打开当前 ProductSpace 支付中心；Manager/Member 无充值写入口，只能调用真实幂等通知。
3. notify payload 不含 Prompt、输入、输出、文件、余额、payer 或价格，跨空间/迟到请求拒绝。
4. focus、恢复、时间推进产生零查询；每次按钮点击恰好一次，恢复只解除提示。
5. 不自动重放 App Run；三视口 parity 和完整门禁通过。

## Re-pin gate

必须先确定 notify-owner 的 API owner、端点、幂等键和送达证明；否则保持阻塞，不得用本地 toast 冒充成功。


