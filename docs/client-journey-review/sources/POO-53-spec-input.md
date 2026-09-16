# 背景

POO-50 已确认的产品能力是 Polo 原生、跨现有执行后端的 `request_user_input`：Claude backend 与 Pi backend 共用同一协议、durable 状态和 Renderer UI。POO-50 文档中的“Pi/Codex”是指 Pi backend 可承载 ChatGPT Plus / Codex OAuth 与 OpenAI Codex 模型，并不代表 Polo 存在第三个独立 external Codex 执行引擎。

POO-53 前序实现把这一简称误扩成了独立 `external Codex` 会话、Codex CLI turn、专用 RPC/深链和 driver-owned sidecar，形成了不属于既定产品范围的第三条执行链，也导致多轮 Review 围绕伪生产接线持续返工。本任务现在按已确认产品架构纠偏：删除该范围漂移，同时保留 POO-50 已确认的交互能力、持久化协议和并发安全属性。

# 产品与架构边界

- Polo 当前正式 Agent backend 只有 Claude 与 Pi。
- ChatGPT Plus / Codex OAuth、OpenAI Codex 模型仍由 Pi backend 承载；不得为它新增独立 Codex CLI session、外部引擎选择面或第二套会话生命周期。
- `request_user_input` 必须由 Claude 与 Pi 的真实生产 turn 入口和实际模型工具集合消费，并汇合到同一个 durable handler。
- 删除 POO-53 为独立 external Codex 新增的生产入口与状态，不得误删已有产品能力；对既有 session MCP 相关模块，仅保留被仓库其他正式入口真实消费的共享能力，任何保留项必须有生产调用方和回归证据。

# 目标

在不改变 POO-50 已确认产品决策与协议的前提下，先证明 Claude 与 Pi 的真实 outside-in 工具调用链，再删除独立 external Codex 范围漂移并安全收敛实现复杂度。完成后必须保持回答、暂不回答、重启恢复、幂等、草稿恢复和 UI 单消息续答行为。

# 必做顺序

1. **先锁定真实 outside-in Acceptance**：Claude 必须从 ClaudeAgent 的生产 turn 与真实工具集合调用统一 `request_user_input`；Pi 必须从 PiAgent 的生产 `handlePrompt`/工具装配链调用同一工具。Pi 使用 ChatGPT Plus / Codex OAuth 或 Codex 模型时仍走 Pi backend，不启动独立 Codex CLI。每个 backend 只有一个 owner/channel，不得形成 callback 环或双投递。
2. **删除范围漂移**：移除 POO-53 新增且仅服务独立 external Codex 的 `externalEngine` session 状态、专用创建 RPC、renderer 深链、model adapter、driver、bootstrap、Codex harness 及对应测试结构。删除前逐项确认没有其他正式产品入口依赖；如存在共享模块，收敛为 Claude/Pi 或其他既有调用方实际需要的最小能力。
3. **保留并复核 round15 并发修复**：首回合在工具装配完成后才能 chat；候选 host/client 启动失败不得覆盖仍健康实例；删除与慢速 Agent 创建竞态必须在 chat 前确定性收敛为无 ghost turn、无 Agent 泄漏、无预期取消异常。
4. **在 outside-in 证据成立后继续瘦身**：保留 spawn builder 叶子模块、统一 durable handler、`questionStateLock`、identity/generation/turn reservation 等生产不变量；删除重复状态机、测试后门、review-round 叙事注释，以及可证明不可达的防御分支。
5. **保持 renderer 简化**：实时事件优先、快照只填洞并受 requestId terminal guard 保护；不得恢复 epoch/captureAll/full-partial scope 状态机。Edit Popover restore 保持有界重试，不恢复无限退避或 `restoreNote` 状态。

# 验收

- Claude 与 Pi 各完成一次真实生产 turn `request_user_input` → `pendingQuestion` 持久化 → Renderer 问题态 → answer/cancel → 单条可读消息 → 原会话继续/不继续的 outside-in 场景。
- 至少覆盖一次 Pi backend 使用 Codex OAuth/模型配置的工具装配与调用路径；该场景不得创建独立 Codex CLI session。
- 任一工具调用只产生一个 `requestId` 和一条 `question_request`；embedded Claude/Pi 均直达统一 durable handler，不绕行独立 external-engine callback 链。
- 生产代码中不再存在可创建独立 external Codex 会话的入口、renderer 深链或双重生命周期；所有幸存的 session MCP 相关代码必须列出真实生产调用方并由回归覆盖。
- restart、cancel、already_answered、stale、session_missing、transient_failure、删除/停止/归档竞态和草稿恢复均有回归。
- 不允许通过删除能力、放宽断言、把真实 Agent turn 改成私有方法直调，或使用只服务故障注入的生产结构来取得绿色测试。
- `typecheck:all`、相关定向测试、全量 `bun test`、i18n parity、Electron build 与独立 E2E Acceptance 全部通过。
- E2E Acceptance 必须使用任务锁定的 desktop 1440×900 与 mobile 390×844 smoke 视口，验证主对话和 Edit Popover 的问题态、回答/取消、草稿恢复与单消息续答；若某视口/入口不适用，必须给出可核对的产品理由，不能静默跳过。

# 交付边界

只要求 `branch-ready`。Implement、Review、Acceptance、commit、push/remote、integration 与 Notma 状态必须分别报告；不得把测试绿色或 Coding Pass 视为已完成，不得把 branch-ready 视为已集成或 Done。

