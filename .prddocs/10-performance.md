# 10 - 性能分析

## 性能特性

### P-1：流式架构

```mermaid
graph LR
    A[用户消息] --> B[会话管理器]
    B --> C[Agent 后端]
    C -->|SSE/流式| D[逐 Token 输出]
    D --> E[事件队列]
    E --> F[WebSocket 推送]
    F --> G[渲染器更新]
```

**核心设计**：从 LLM 到 UI 的完整流式管线，层间无缓冲。

- **Claude 路径**：原生二进制流 → SDK 事件 → WebSocket 推送 → React 重渲染
- **Pi 路径**：HTTP SSE → JSONL 事件 → JSONL stdio → WebSocket 推送 → React 重渲染
- **延迟**：首 Token 通常 < 2 秒

### P-2：会话持久化
- **格式**：JSONL（JSON Lines，仅追加）
- **优势**：O(1) 追加，无需文件重写
- **存储位置**：`~/.polo-ai/workspaces/{id}/sessions/{sid}.jsonl`
- **压缩**：接近上下文限制时进行基于摘要的压缩

### P-3：大响应处理
- **阈值**：约 60KB
- **策略**：使用 Claude Haiku 自动摘要
- **意图感知**：在 MCP 工具 Schema 中注入 `_intent` 字段以聚焦摘要
- **实现位置**：`@polo-ai/shared/src/agent/` 大响应处理

### P-4：工具执行优化
- **预取**：在顺序执行前预取并行工具调用
  - 检测 assistant 消息中 2 个及以上可预取的工具调用
  - 并行向主进程发送所有请求
  - 每个工具的 `execute()` 命中缓存
- **代理模式**：Pi Agent 使用代理工具，转发到主进程执行
- **会话 MCP 检测**：会话范围的工具调用独立追踪

### P-5：自动压缩
- **触发条件**：上下文窗口接近限制时自动触发
- **序列化**：手动压缩等待进行中的自动压缩完成
- **竞态预防**：`waitForCompaction()` 设置 300 秒超时
- **实现方式**：Pi SDK 的 `_runAutoCompaction` 配合 AbortController

### P-6：构建性能

| 构建目标 | 工具 | 备注 |
|----------|------|------|
| Electron 主进程 | esbuild | 快速打包，CJS 输出 |
| Electron 预加载 | esbuild | 最小化打包 |
| Electron 渲染进程 | Vite | HMR，代码分割 |
| Pi Agent Server | Bun build | ESM，目标 Bun |
| Session MCP Server | Bun build | CJS，目标 Node |
| WhatsApp Worker | Bun build | CJS，目标 Node |
| WebUI | Vite | SPA 构建 |
| Docker 镜像 | Docker buildx | 依赖层缓存 |

### P-7：运行时性能

| 领域 | 策略 |
|------|------|
| 状态管理 | Jotai（原子化，细粒度更新） |
| 渲染 | React 18 并发特性 |
| CSS | Tailwind CSS v4（JIT 编译） |
| 代码高亮 | Shiki（按语言懒加载） |
| 图片处理 | Sharp（原生，平台特定） |
| 搜索 | @leeoniya/ufuzzy（模糊匹配） |
| 解析 | bash-parser、shell-quote（轻量级） |
| 缓存 | @isaacs/ttlcache（TTL 机制） |

### P-8：网络效率
- **WebSocket**：持久连接，无每消息 HTTP 开销
- **JSONL**：Agent 子进程的最小序列化开销
- **流式传输**：无请求/响应缓冲
- **TLS 开销**：可选，仅远程部署需要

### P-9：Docker 优化
- **基础镜像**：`oven/bun:1.3-slim`（最小化）
- **层缓存**：源码复制前先复制依赖清单
- **非 root 用户**：以 `poloai` 用户运行（安全 + Claude SDK 要求）
- **Vite 构建**：NODE_OPTIONS="--max-old-space-size=4096" 用于大型构建

## 已识别的性能瓶颈

### B-1：Vite 构建内存
- **问题**：Vite 渲染进程构建在 >5k 模块时触及 V8 默认 ~2GB 堆限制
- **缓解**：Docker 构建中使用 `--max-old-space-size=4096`
- **影响范围**：仅构建时间，非运行时

### B-2：Pi Agent 子进程通信
- **问题**：基于 stdio 的 JSONL 增加序列化开销
- **缓解**：对并行工具调用进行预取
- **影响范围**：典型使用场景下影响极小

### B-3：大型会话文件
- **问题**：JSONL 文件无压缩时无限增长
- **缓解**：通过自动压缩和基于摘要的截断处理
- **影响范围**：已被压缩机制缓解

## 待确认项

| ID | 内容 | 置信度 | 建议操作 |
|----|------|--------|----------|
| TC-012 | 实际基准测试数据 | 中 | 运行性能分析获取具体指标 |
| TC-013 | 负载下内存使用情况 | 中 | 测试 10+ 并发会话场景 |
