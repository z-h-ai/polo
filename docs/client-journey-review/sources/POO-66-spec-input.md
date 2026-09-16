# 实现助手生成中积分耗尽与人工恢复

Stable slice key: `poo49-mid-stream-credit-recovery`  
Parent: POO-49（拆分后为协调父卡）  
Status: `draft / awaiting-upstream-repin`

## Outcome and domain

助手生成中积分耗尽时停止后续生成、保留已返回内容并只在该回答末尾显示一个 typed terminal marker；用户仍须显式恢复并重新发起后续动作。

Business domain: assistant streaming terminal state.

## Explicit dependencies

- 依赖 `POO-65` 完成 Acceptance、push 并集成。

## Scope

- mid-stream typed restriction event、稳定 stage/eventId 与 reducer 去重。
- 保留已提交 assistant delta、结束 processing、回答末尾单一 recovery notice。
- reconnect/snapshot/event replay 去重和 generic Retry 禁用。
- 复用前置 slice 的角色动作与 click-only query；恢复不自动 continue/send/retry。

## Non-goals

- pre-send transaction 重做、独立第二套 recovery UI、余额/模型/Token 展示或自动续写。

## Interfaces

- Owns: `assistant-credit-mid-stream-terminal.v1`.
- Consumes: `assistant-credit-restriction.v1`, `assistant-manual-credit-recovery.v1`.

## Planning bound

- Product files upper: 10.
- Core changed lines upper: 600.

## Acceptance criteria

1. 两段 delta 后发生 insufficient 时两段内容原样保留，回答末尾只有一个 terminal marker，`isProcessing=false`。
2. 重复 event、reconnect 和 snapshot replay 不重复 marker/通知/查询；generic Retry 不可用。
3. 用户 stop 只显示停止，正常 complete 后余额恰为零不回写成中断，provider 错误保持原语义。
4. restored 只解除当前 scope/session/event 阻断，不自动续写、发送、创建 run 或 retry。
5. 跨空间/session replacement、E2E/parity/full gates 通过。

## Re-pin gate

在 pre-send slice 的已集成 typed contracts 和真实 Chat reducer 上重审最终文件清单并接受 Plan。


