# 11 - 技术债与重构建议

## 已识别的技术债

### TD-1：网络拦截器 Claude SDK 缺口
**严重程度**：中
**位置**：`packages/shared/src/unified-network-interceptor.ts`

**问题**：网络拦截器仅限 Pi 端（通过 Bun `--preload` 预加载）。自 Claude SDK 0.2.113 起，Claude 以原生 `claude` 二进制运行，`--preload` 不可用。依赖拦截器的 Claude 端功能（丰富工具意图、快速模式覆盖、MalformedBodyError 验证等）在 Claude 路径中不可用。

**建议**：作为 Phase-2 工作跟踪。将拦截器功能迁移到 SDK 钩子或本地代理。详见 `plans/sdk-uplift-plan.md`。

### TD-2：双 Agent 后端复杂度
**严重程度**：中
**位置**：`packages/shared/src/agent/claude-agent.ts`、`pi-agent.ts`

**问题**：两个完全不同的 Agent 后端（Claude 和 Pi），使用不同的通信协议、不同的工具系统和不同的事件模型，导致维护工作量翻倍。

**建议**：考虑统一的 Agent 抽象层。当前的 `BaseAgent` 提供了一定抽象，但实现差异显著。

### TD-3：流中行为碎片化
**严重程度**：低
**位置**：`packages/shared/src/agent/`（midStreamBehavior）

**问题**：流中用户发送在不同提供商上行为不同：Claude 使用 'queue'（让当前轮次完成），Pi 使用 'steer'（引导进行中的轮次）。决策逻辑必须通过 `resolveMidStreamBehavior()` 而非直接分支 providerType。

**建议**：当前 resolver 模式管理良好。建议清晰记录行为差异。

### TD-4：向后兼容别名
**严重程度**：低
**位置**：`packages/shared/src/agent/`

**问题**：存在向后兼容的别名导出（`PoloAi`），用于兼容旧的类名。

**建议**：在下个大版本中安排移除。

### TD-5：OpenAI 历史记录清理
**严重程度**：低
**位置**：`packages/shared/src/unified-network-interceptor.ts`

**问题**：`sanitizeOpenAiHistoryInPlace` 用于修复由修复前版本持久化的会话，该版本将工具调用事件拆分为 init + args-only deltas。某些 SDK 将 args-only deltas 视为新的 tool_calls。

**建议**：保留清理器用于向后兼容，过渡期后移除。

### TD-6：Pi 压缩竞态面
**严重程度**：中
**位置**：`packages/pi-agent-server/src/`

**问题**：Pi SDK 的 `_runAutoCompaction` 使用共享的 AbortController，并发压缩调用竞态时可能崩溃。修复方案通过 `waitForCompaction()` 序列化压缩，但底层 SDK 问题仍然存在。

**建议**：向 Pi SDK 上游修复。当前的变通方案有效但增加了延迟。

### TD-7：自定义端点模型注册
**严重程度**：低
**位置**：`packages/pi-agent-server/src/`

**问题**：自定义端点模型在运行时动态注册。`registerProvider` 替换现有注册，因此必须跟踪所有 ID 并作为集合重新注册。

**建议**：考虑支持增量注册而非替换的模型注册表。

### TD-8：IPC 完整请求往返 ⚠️ [待确认]
**严重程度**：低
**位置**：`packages/shared/src/agent/`

**问题**：主进程与子进程后端之间的 IPC 信封必须携带完整的请求结构。创建更窄信封的后端必然随时间漂移（参见 #596）。由 `pi-query-llm.test.ts` 守护。

**建议**：当前守护机制良好。可添加 TypeScript 可辨识联合强制。

### TD-9：Web 构建堆压力
**严重程度**：低
**位置**：`Dockerfile.server`

**问题**：Vite 构建 WebUI 时因 >5k 模块需要 `--max-old-space-size=4096`。仅影响构建时。

**建议**：考虑对不常用模块进行代码分割或懒加载。

### TD-10：跨包类型漂移 ⚠️ [待确认]
**严重程度**：低
**位置**：`packages/core/`、`packages/shared/`

**问题**：`@polo-ai/core` 中定义的类型必须与 `@polo-ai/shared` 中的实现保持同步。缺乏自动化的类型-实现一致性检查。

**建议**：在 CI 中添加类型兼容性测试。当前的 `typecheck:all` 可捕获大部分漂移。

## 重构优先级

| 优先级 | 项目 | 工作量 | 影响力 |
|--------|------|--------|--------|
| P1 | SDK 提升计划（TD-1） | 高 | 高 |
| P2 | 统一 Agent 抽象（TD-2） | 高 | 高 |
| P3 | Pi 压缩竞态修复（TD-6） | 中 | 中 |
| P4 | 移除向后兼容别名（TD-4） | 低 | 低 |
| P5 | Web 构建优化（TD-9） | 低 | 低 |

## 架构改进机会

### A-1：事件系统统一
考虑在两个 Agent 后端之间使用统一的事件总线。目前 Claude 和 Pi 发出不同的事件结构，各自独立归一化。

### A-2：配置 Schema 验证
为所有配置文件（config.json、automations.json 等）添加 Zod Schema，在加载时捕获无效配置。

### A-3：遥测与可观测性
在 Sentry 崩溃报告之外添加结构化日志。考虑使用 OpenTelemetry 进行 Agent 子进程的分布式追踪。

## 待确认项

| ID | 内容 | 置信度 | 建议操作 |
|----|------|--------|----------|
| TC-014 | IPC 类型漂移严重程度 | 中 | 审计实际类型不匹配情况 |
| TC-015 | 跨包类型漂移范围 | 中 | 运行类型覆盖率分析 |
| TC-016 | 事件系统统一可行性 | 低 | 需要架构讨论 |
