# 任务链式监听的发布订阅(POO-126)

适用范围：Polo 会话运行时的 session ID。原始需求中的“任务 ID／会话 ID”均指 Polo 会话；event ID 是通知标识，不是监听目标，Notma 任务 ID 与此无关。2026-10-24 用户已确认不做外部任务 ID 桥接；任务结束采用工作区 closed 状态或显式 emit，模型 turn 停止、暂停或等待审批均不等于完成。外部 `/supa-ai` 或独立 CLI 没有会话工具时，本功能不可用。

## 已确认用户入口与交付状态（r3）

用户已于 2026-10-24 确认补齐“复制 ID 入口＋自然语言查找／消歧＋监听回执和取消路径”。产品范围、PS-01—PS-09 场景和 AC-01—AC-09 验收条件的权威来源为 POO-126 任务正文“已确认交付方案（r3）”（`project/Polo-工作台/POO-126_实现任务链式监听的发布订阅模式.md`）；本文件保留运行时设计及其摘要映射。

- 主要入口：用户按会话标题描述下一步，Agent 用已有 `list_sessions` 发现真实 ID；同名先选择、无匹配先说明，不要求用户预先寻找内部 ID。
- 明确指定入口：会话列表右键／更多、会话标题菜单及对应紧凑菜单新增“复制会话 ID”，复制完整原始 ID并显示成功／失败反馈。复用现有菜单和共享动作层，不创建公开分享。
- Agent 创建上游时直接使用 `spawn_session` 返回 ID；注册成功后提供包含监听对象、结束条件、后续动作及失败／取消策略的回执。查询和取消复用已有订阅工具，取消不撤回已接收或已执行的动作。
- 当前状态：用户已授权更新文档和代码。复制 ID 已接入共享菜单动作层，编排规则已迁入按需读取的内置 Skill，移除了常驻 System Prompt 的完整 Task Pub/Sub 用法。原生组件运行、Skill 发现与运行时回归分别验证；真实双模型完整旅程仍待正式验收。不新增拖拽式画布或专用监听管理页面。

链式任务中,主 Agent 之前只能反复调 `get_session_info`/`list_sessions` 轮询下游任务是否完成——每次轮询都是一轮 LLM 推理,token 随等待时长线性增长,而等待本身不产生任何进展。本设计把「等待」从 agent loop 挪到运行时:Agent 一次性注册订阅,任务事件到达时由服务端把唤醒消息注入订阅者会话,自动开新 turn。

## 分层

| 层次 | 交付职责 |
|---|---|
| 用户入口 | 自然语言“这个会话完成后继续审查”；可从会话菜单复制完整 Polo ID |
| 按需 Skill | `task-chain-pubsub`：查找／消歧、注册回执、结束 turn、唤醒后继续、查询／取消 |
| 工具与声明 | `subscribe_task` 等工具；可选 `task-events/chains/*.yaml` 单依赖链 |
| 运行时 | `TaskSubscriptionManager` 匹配、持久化、排队、重试和恢复；等待时无需 LLM 调用 |
| 契约 | `TaskEvent` / `TaskSubscription`，位于 `packages/shared/src/task-events/types.ts` |

Skill 通过既有 BaseAgent → bundled loader → native skill discovery 路径发现：普通 turn 仅提供名称、简介和读取位置，需求匹配时才读取正文。底层工具只保留简短契约，System Prompt 不再常驻编排教程。可选 YAML 细节放在 Skill 的 `references/chains.md`，仅使用 YAML 时读取。

## 事件契约(Layer 0)

`TaskEvent`:`{ id, type, sessionId, sessionName?, workspaceId?, fromStatus?, toStatus?, detail?, emittedBy?, timestamp }`

`type` 取值:

| type | 来源 | 语义 |
|---|---|---|
| `status_changed` | `SessionManager.setSessionStatus` | 任意状态迁移,自动派生 |
| `completed` | 同上 | 新状态落在 workspace statuses 里 `category: 'closed'` 的状态(默认 done/cancelled) |
| `failed` | 仅 `emit_task_event` | 状态词汇无法表达失败,由 agent 显式发 |
| `custom` | 仅 `emit_task_event` | 里程碑/进度等非终态信号 |

`TaskSubscription`:`{ id, targetSessionId(被监听), subscriberSessionId(被唤醒), events(默认 ['completed','failed']), statuses?(收窄), instruction?(唤醒后要做的事), mode('once' 默认 | 'persistent'), expiresAt?, source?(来源) }`

持久化:`{workspace}/task-events/subscriptions.json`(原子写,重启后恢复);事件留痕 `{workspace}/task-events/events.jsonl`。

## 唤醒语义(Layer 1)

- 匹配:`targetSessionId` + `events` + `statuses`(status 派生事件按 toStatus 大小写不敏感匹配;custom 事件忽略 statuses)。
- 合并:同一事件命中同一订阅者的多条订阅 → **只注入一条消息**(instruction 拼接),一个事件不会让同一会话开两个 turn。
- 投递:经注入的 `deliver` 回调 → `SessionManager.sendMessage`，强制排队而不 steer 当前 turn；消息落盘的 onAck 才算接收成功。排队消息的 isQueued 标记支持冷恢复，接收成功不代表模型执行成功。
- 已接收的订阅者保留恢复标记；重启后运行时在当前可信范围可用时主动恢复其排队事件，不依赖用户打开该会话。普通会话仍按原策略懒加载。
- `once` 订阅**接收成功后**才移除；投递失败保留原事件和接收者，运行时每秒重试，不需要上游再发事件或 Agent 推理。匹配的全部接收者在首次发送前原子落盘；重启恢复待投递记录。崩溃若发生在接收与订阅确认之间可能重复投递，下游有外部副作用的动作应幂等。
- 同一运行时串行接收事件，避免 status_changed 与 completed 并发消费同一 once 订阅；persistent 订阅记录上一次成功的 event ID，避免紧邻的同 ID 重放。
- 工具与 YAML 共用终态补发：注册后在事件队列中核对当前状态，仅向新订阅者补发匹配的已完成／失败结果，重开后的旧终态不会补发。
- 防自环:订阅创建时拒绝 `target === subscriber`(与 send_agent_message 防自发送同理);`emit_task_event` 只能针对自己会话,不能伪造他人事件。
- 自愈:`pruneExpired`(过期)与 `pruneForRemovedSessions`(会话删除)。
- 隔离：列表和每次延迟投递都重新检查完整 account/ProductSpace/workspace；YAML 任一边跨范围则整链不应用。未知／损坏的持久化订阅不进入投递表，无法落盘的注册不能返回 armed。

## Agent 工具(基础设施)

| 工具 | safe mode | 行为 |
|---|---|---|
| `subscribe_task` | block(确认后放行) | 注册订阅,返回 armed 说明;提示 agent「立即结束 turn,禁止轮询」 |
| `unsubscribe_task` | block | 只能移除自己会话的订阅 |
| `list_task_subscriptions` | allow + readOnly | `mine`(默认)/`all`(当前可信账号／空间／工作区范围，含链文件生成的) |
| `emit_task_event` | block | 对**自己**会话发事件,返回唤醒的订阅者数 |

装配链(与现有自管理工具同一条缝,无后端特判,Claude/Pi 两后端同时生效):
`SESSION_TOOL_DEFS` → `SessionToolContext` 新回调 → `SessionScopedToolCallbacks`(subscribeTaskFn 等,guard-wrapped)→ `SessionManager.buildManagedSessionToolCallbacks` → `attachSessionSelfManagementBindings`。

内置 `apps/electron/resources/builtin-skills/task-chain-pubsub/SKILL.md` 指导两条入口：查找已有会话／直接使用 ID，或 spawn 新会话 → subscribe（带 instruction）→ 回执并结束 turn → 事件唤醒后核对结果再继续。Skill 通过现有 bundled loader 原位读取，不复制到用户目录；企业空间禁用本地 Skill 时仍可使用内置版本。事件交付不扩大权限，也不承诺模型后续动作成功。

## 声明式链(Layer 3)

`{workspace}/task-events/chains/*.yaml`(或 `.json`),workspace watcher 初始化时加载并翻译为订阅;解析失败的文件跳过并记日志,坏文件不阻塞好文件;链内任一 step 的 session 解析不到则整条不应用(不半应用)。

```yaml
chain: review-after-implement
steps:
  - id: implement
    session: implement-feature-x   # 起点,不产生订阅
  - id: review
    after: implement               # implement 完成 → 唤醒 review 会话
    session: review-session
    prompt: |
      审查 implement 会话的产出,先跑测试再给结论。
```

每个依赖边 = 一条 `once` 订阅（`source: chain:<file>#<stepId>`）；重复加载去重，并保存成功投递的边及其定义，重启不会重复执行同一条已消费边。新一轮链使用新文件名或 step ID，并准备没有旧终态的 pending 下游会话；运行时拒绝复用仍为 closed 或带当前状态终态记录的下游步骤，避免 A(done)→B(done)→C 同时补发、越过新一轮 B。启动先恢复会话再解析链，协调有效文件的完整定义：改 prompt 会替换未消费监听，删除或写坏文件会解除对应监听。重复 step ID、自依赖（含会话别名）和环在整链落入订阅表前拒绝。MVP 限制：`after` 只接受单个 step id（join 需要跨事件状态，后续按需加）。

## Token 收益的量级

估算示例：每 30 秒查询一次、等待 10 分钟，大约需要 20 次工具查询及相应模型推理。订阅式只需注册与事件唤醒，等待和重试由运行时代码处理；信封 token 数随 detail／instruction 长度而变化。此处没有真实模型成本基准测试。

## 边界(未做/后续)

- chains 目录暂无热加载：workspace 初始化时加载一次；改链文件后需重启服务。
- `failed` 无状态词汇来源:依赖 agent 显式 `emit_task_event({ type: 'failed' })`。
- 带多依赖 join(AND)的 DAG:单依赖 MVP,join 需要跨事件状态,刻意推迟。
- 真实双会话 LLM 端到端（两个 Agent 会话实际跑通）未自动验收；回归覆盖 schema、持久化重启、排队恢复、状态事件和权限隔离，不能替代真实模型验收。
- 不把每次模型 turn 结束自动转为 completed／failed；worker 正常完成、暂停和等待裁决需显式区分。Notma task ID 与监听目标无关，不建立桥接。
- Pi 后端新工具下一轮 turn 才可见(Claude 在 query() 冻结 mcpServers)——现有机制,非本设计引入。
