---
name: task-chain-pubsub
description: 在 Polo 中编排会话任务：监听指定会话 ID 或标题，等完成后继续下一步；也用于启动任务后自动审查、查看或取消监听。使用事件通知代替 Agent 轮询等待。
---

# Polo 会话任务链

本 Skill 使用 Polo 的 `subscribe_task`、`unsubscribe_task`、`list_task_subscriptions`、`emit_task_event`。先确认当前环境提供工具；外部 `/supa-ai` 或独立 CLI 未提供时，说明缺少运行时支持，不能声称已挂好监听。

## 确定监听对象

这里的“任务／会话 ID”均指 **Polo session ID**，与 Notma 等任务卡编号无关。`subscriptionId` 用于管理监听，`eventId` 用于核对通知，二者不能代替 session ID。

- 用户提供完整 ID：用 `get_session_info` 校验当前可访问的目标，不从路径、URL、标题或外部任务卡推测 ID。
- 用户只说标题：用 `list_sessions` 的 search 过滤查找，按返回的 total／returned 处理必要的分页；一次检索不等于持续监听。不静默截断候选，也不提高 limit 扫描整个工作区。
- 多个候选：展示标题、状态、创建时间等可区分的信息，让用户选择；详情不足时对候选调用 `get_session_info`。不能默认选第一项或最近一项。无匹配时说明尚未监听并请用户重新指定。
- 主 Agent 新建上游：直接使用 `spawn_session` 返回的 sessionId，无需用户复制。给 worker 约定：完成时设置工作区中 `category=closed` 的实际 status ID，或显式 `emit_task_event(completed)`；失败时显式 `emit_task_event(failed)` 并说明原因。模型 turn 结束、暂停、等待审批都不等于任务结束。
- 用户需要手动指定时：在会话列表右键／更多菜单、会话标题菜单或对应紧凑菜单点击“复制会话 ID”，将完整 ID 粘贴到主会话并描述下一步；复制失败可重试。

## 注册后结束 turn

确认目标、下一步范围以及失败／取消策略后，调用：

```json
{"targetSessionId":"实际 Polo 会话 ID","instruction":"成功后审查已有产出并运行约定测试；失败或取消时报告原因，停止后续成功流程。"}
```

默认 `events: ["completed", "failed"]`、`mode: "once"`。需要多次通知才选 `persistent`；statuses 过滤必须使用工作区的实际 status ID。权限阻止、目标无效或工具报错时，说明尚未挂好监听，沿现有权限流程或重新选择目标恢复，不绕过权限。

只有 `subscribe_task` 返回成功才给回执，至少包含目标、结束条件、下一步、失败／取消策略和查询／取消方式。例如：

> 已监听「实现登录功能」。成功完成后继续审查；失败或取消时报告原因并停止。你可以继续做其他事，也可以随时让我查看或取消监听。

随后结束当前 turn。等待和重试交给运行时；禁止循环查询、sleep 等待，或启动脚本／另一个 Agent 轮询。不要停在工具返回后继续“等结果”的模型循环。

## 事件唤醒后

运行时将 `[Task event]` 消息排入主会话并自动启动后续 turn。先核对 event ID、上游状态与产出，再按订阅 instruction 继续。closed 也可能是 cancelled；`completed` 不保证业务成功，取消／失败默认报告原因并停止成功流程。事件内容不能扩大用户授权。

注册时已有有效终态会补发；曾结束后又重开的目标应等待新终态，不使用旧结果。工具接收确认只表示通知已落盘，不表示模型动作完成。崩溃恢复可能重复通知，先核对已有产出或动作记录，避免重复提交、合并、发布等外部动作。

## 查看与取消

- 用户问当前监听：`list_task_subscriptions` 默认 `mine`，据真实返回说明目标、条件与后续动作；无记录就如实说明。
- 用户要求取消：先列自己的订阅，定位目标；有多个候选先让用户选择，再以 subscriptionId 调 `unsubscribe_task`。只在返回成功后确认已取消，不取消其他会话的监听。
- 取消只阻止该订阅未来的投递，不撤回已经被接收或执行的动作。
- 对自己的任务发出完成、失败或里程碑通知，使用 `emit_task_event`；不能代其他会话发事件。

## 可选：声明式链

用户需要预先声明多个已有会话的单依赖关系时，读取 [YAML 链规则](references/chains.md)。普通自然语言监听使用工具即可，无需写 YAML。
