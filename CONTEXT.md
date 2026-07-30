# Polo CLI Execution

This context defines the language used for non-interactive Polo commands that execute alongside the desktop application without becoming part of its session experience.

## Language

**CLI 执行运行时**:
由一次 `polo run` 或 `polo exec` 调用独占、并且独立于 Electron 运行的执行上下文；其生命周期不超过该次命令所需的执行周期。
_Avoid_: One-shot Runtime、Electron RPC 会话

**配置工作区**:
一次 CLI 执行读取 Polo 能力配置的 workspace；它决定可用的 sources、skills、权限和模型配置，但不决定 agent 操作文件的位置。
_Avoid_: 当前目录、代码仓库

**执行目录**:
Agent 在一次 CLI 执行中操作文件和运行命令的目录；它不因被使用而成为配置工作区。
_Avoid_: 自动注册的 workspace、配置目录

**执行覆盖**:
只在当前 CLI 执行期间生效的 provider、model、endpoint 或凭据选择；它不会改变配置工作区或 Electron 后续使用的共享设置。
_Avoid_: 保存连接、修改默认模型

**CLI 会话**:
由 `polo run` 或 `polo exec` 创建、只属于 CLI 体验的会话记录；它只能由 CLI 发现或恢复，永远不是 Electron 会话。
_Avoid_: 隐藏的 Electron 会话、桌面会话

**CLI 执行所有者**:
发起一次 CLI 执行并负责接收其结果的命令进程；所有为该次执行创建的运行活动都受其生命周期约束。
_Avoid_: 后台 server、Electron

**CLI Thread**:
一次 CLI 调用创建的主会话及其所有派生会话构成的、可由全局唯一 `thread_id` 定位的整体；保留、恢复和清理策略作用于整个 Thread。
_Avoid_: CLI 执行组、单个主 session、内部 session slug

**CLI Thread 状态**:
Thread 最近一次执行的终态，取值为 `completed`、`failed` 或 `interrupted`；终态不决定持久化 Thread 是否可以恢复。
_Avoid_: 进程存活状态、删除状态

**Exec JSONL 协议**:
`polo exec --json` 面向自动化消费者提供的稳定事件协议；它兼容 Codex 的核心事件形态，但不是 Polo 内部事件或全部 Codex 事件的镜像。
_Avoid_: RPC 事件透传、完整 Codex JSONL 等价

**恢复 CLI 会话**:
继续使用既有 CLI Thread 中的原会话和历史，而不是复制或分叉出新的持久化记录。
_Avoid_: 复制会话、隐式 fork

**临时恢复**:
基于既有 CLI 会话历史进行一次不留存结果的执行；原会话及其使用时间保持不变。
_Avoid_: 删除原会话、原位追加

**最终回答**:
一次成功 CLI 执行产生的完整 assistant message；普通输出模式只把该结果交付到 stdout。
_Avoid_: 流式片段、进度文本、失败前的部分回答

**Polo 会话产物**:
由 Polo 创建并负责生命周期的会话记录及其附件、计划、数据和恢复元数据；provider 自主管理的缓存不属于该概念。
_Avoid_: provider 缓存、Electron workspace 文件

**执行配置快照**:
一次 CLI 调用开始时解析出的配置工作区能力与执行覆盖集合；该调用期间 Electron 的后续配置变化不会改变它。
_Avoid_: 实时配置、共享 watcher 状态
