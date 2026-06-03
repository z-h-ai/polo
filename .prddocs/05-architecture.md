# 05 - 系统架构

## 高层架构

```mermaid
graph TB
    subgraph Clients["客户端"]
        E["Electron 桌面应用"]
        C["CLI 客户端"]
        W["Web UI"]
        V["会话查看器"]
    end

    subgraph Server["服务器层 (@polo-ai/server)"]
        SC["服务器核心"]
        WS["WebSocket 传输层"]
        SM["会话管理器"]
        RPCHandlers["RPC 处理器"]
    end

    subgraph AgentBackends["代理后端"]
        CA["Claude 代理<br/>@anthropic-ai/claude-agent-sdk"]
        PA["Pi 代理子进程<br/>JSONL over stdio"]
    end

    subgraph MCP["MCP 层"]
        MCPServers["MCP 服务器"]
        SessionMCP["会话 MCP 服务器"]
        PiAgentSrv["Pi 代理服务器"]
    end

    subgraph Storage["存储层"]
        FS["文件系统<br/>~/.polo-ai/"]
        Cred["凭据存储<br/>AES-256-GCM"]
    end

    subgraph External["外部服务"]
        Anthropic["Anthropic API"]
        OpenAI["OpenAI / Copilot / Google"]
        OAuth["OAuth 提供商<br/>Google, Slack, Microsoft"]
        Messaging["WhatsApp, Telegram, Lark/飞书"]
    end

    E -->|WebSocket RPC| WS
    C -->|WebSocket RPC| WS
    W -->|WebSocket RPC| WS
    V -->|静态文件| SC

    WS --> RPCHandlers
    RPCHandlers --> SM
    SM --> CA
    SM --> PA

    CA -->|原生二进制| Anthropic
    PA -->|HTTP API| OpenAI
    PA -->|Pi SDK| MCPServers

    SM --> FS
    SM --> Cred
    CA --> MCPServers
    SM --> SessionMCP
    SM --> PiAgentSrv

    SM --> OAuth
    SM --> Messaging
```

## 包依赖关系图

```mermaid
graph TB
    core["@polo-ai/core<br/>(类型定义)"]
    shared["@polo-ai/shared<br/>(业务逻辑)"]
    serverCore["@polo-ai/server-core<br/>(服务器基础设施)"]
    server["@polo-ai/server<br/>(服务器入口)"]
    ui["@polo-ai/ui<br/>(共享组件)"]
    sessionToolsCore["@polo-ai/session-tools-core<br/>(工具实用程序)"]
    sessionMcp["@polo-ai/session-mcp-server<br/>(会话 MCP)"]
    piAgent["@polo-ai/pi-agent-server<br/>(Pi 代理)"]
    electron["@polo-ai/electron<br/>(桌面应用)"]
    cli["@polo-ai/cli<br/>(CLI 客户端)"]
    viewer["@polo-ai/viewer<br/>(会话查看器)"]
    webui["@polo-ai/webui<br/>(Web UI)"]
    msgGw["@polo-ai/messaging-gateway"]
    msgWa["@polo-ai/messaging-whatsapp-worker"]

    shared --> core
    sessionToolsCore --> core
    sessionMcp --> sessionToolsCore
    sessionMcp --> shared
    piAgent --> sessionToolsCore
    serverCore --> core
    serverCore --> shared
    server --> serverCore
    server --> shared
    ui --> core
    ui --> shared
    electron --> shared
    electron --> serverCore
    electron --> ui
    electron --> msgGw
    cli --> shared
    cli --> serverCore
    viewer --> core
    viewer --> ui
    webui --> shared
    webui --> ui
    msgGw --> shared
```

## 代理后端架构

### Claude 代理路径

```mermaid
sequenceDiagram
    participant User as 用户
    participant Electron as Electron
    participant ServerCore as 服务器核心
    participant ClaudeAgent as Claude 代理
    participant ClaudeBinary as Claude 二进制 (原生)
    participant MCP as MCP 服务器

    User->>Electron: 发送消息
    Electron->>ServerCore: WebSocket RPC
    ServerCore->>ClaudeAgent: sendMessage()
    ClaudeAgent->>ClaudeBinary: 启动原生进程
    ClaudeBinary->>ClaudeAgent: 流式事件
    ClaudeAgent->>MCP: 工具调用
    MCP->>ClaudeAgent: 工具结果
    ClaudeAgent->>ServerCore: 代理事件
    ServerCore->>Electron: 推送事件 (WebSocket)
    Electron->>User: 流式 UI 更新
```

### Pi 代理路径

```mermaid
sequenceDiagram
    participant User as 用户
    participant Electron as Electron
    participant ServerCore as 服务器核心
    participant PiAgent as Pi 代理 (进程内)
    participant PiSub as Pi 代理服务器 (子进程)
    participant LLM as LLM 提供商 (OpenAI, Google 等)
    participant MCP as MCP 服务器

    User->>Electron: 发送消息
    Electron->>ServerCore: WebSocket RPC
    ServerCore->>PiAgent: sendMessage()
    PiAgent->>PiSub: JSONL 消息 (stdin)
    PiSub->>LLM: HTTP API 调用
    LLM->>PiSub: 流式响应
    PiSub->>PiAgent: JSONL 事件 (stdout)
    PiAgent->>MCP: 代理工具执行
    MCP->>PiAgent: 工具结果
    PiAgent->>PiSub: 工具结果 (stdin)
    PiAgent->>ServerCore: 代理事件
    ServerCore->>Electron: 推送事件 (WebSocket)
    Electron->>User: 流式 UI 更新
```

## 数据流架构

### 会话持久化流程

```mermaid
graph LR
    A["用户消息"] --> B["会话管理器"]
    B --> C["代理后端"]
    C --> D["代理事件"]
    D --> E["事件处理器"]
    E --> F["JSONL 追加写入"]
    F --> G["~/.polo-ai/workspaces/{id}/sessions/{sid}.jsonl"]
    E --> H["WebSocket 推送"]
    H --> I["客户端 UI 更新"]
```

### 来源配置流程

```mermaid
graph LR
    A["用户: \"add Linear as a source\""] --> B["代理解读请求"]
    B --> C["来源配置"]
    C --> D{"来源类型?"}
    D -->|MCP| E["配置 MCP 服务器<br/>stdio 或 HTTP"]
    D -->|API| F["配置 OAuth 流程<br/>或 API 密钥"]
    D -->|本地| G["配置文件系统路径"]
    E --> H["存储到工作区配置"]
    F --> H
    G --> H
    H --> I["通过 @mention 可用"]
```

## 进程架构

### Electron 桌面应用

```
┌─────────────────────────────────────────────────┐
│ Electron 主进程                                  │
│ ├── 窗口管理                                     │
│ ├── IPC 桥接 (preload)                           │
│ ├── 服务器核心（嵌入式）                          │
│ ├── 会话管理器                                   │
│ ├── Claude 代理（启动原生二进制）                 │
│ ├── Pi 代理（通过 JSONL 启动子进程）             │
│ ├── 凭据存储                                     │
│ ├── 配置监听器                                   │
│ └── 托盘 / 菜单 / 自动更新                       │
├─────────────────────────────────────────────────┤
│ 渲染进程 (React)                                 │
│ ├── Vite HMR                                     │
│ ├── Jotai 状态管理                               │
│ ├── 聊天组件                                     │
│ ├── 会话列表                                     │
│ ├── 设置 UI                                      │
│ └── 主题系统                                     │
└─────────────────────────────────────────────────┘
```

### 无头服务器

```
┌─────────────────────────────────────────────────┐
│ Bun 进程                                         │
│ ├── WebSocket 服务器 (端口 9100)                  │
│ ├── RPC 处理器                                   │
│ ├── 会话管理器                                   │
│ ├── Claude 代理后端                              │
│ ├── Pi 代理后端                                  │
│ ├── WebUI 静态文件服务器                         │
│ ├── 消息网关                                     │
│ └── WhatsApp 工作进程 (Node.js 子进程)           │
└─────────────────────────────────────────────────┘
```

## 待确认事项

| 编号 | 内容 | 置信度 | 建议 |
|------|------|--------|------|
| TC-007 | 消息网关内部架构 | 中等 | 确认确切的消息路由拓扑 |
