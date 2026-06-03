# 01 - 项目概览

## 产品名称

**Polo AI**（原 Craft Agent）

## 版本

0.10.0（Apache 2.0 许可证）

## 产品愿景

Polo AI 是一款**原生代理桌面应用**，旨在帮助用户高效地与 AI 代理协作。它支持直观的多任务处理、无缝连接任意 API 或服务、会话共享，以及以文档为中心的工作流，所有这些都在流畅的用户界面中实现。

本产品同时使用 **Claude Agent SDK** 和 **Pi SDK**，在发挥两者优势的基础上，在用户体验、多会话管理和可扩展性等方面进行了增强。

## 问题陈述

现有的 AI 编程工具（Claude Code CLI、Cursor 等）存在以下不足：
- 仅支持 CLI，缺少丰富的图形界面
- 嵌入编辑器中，将使用范围局限于代码编辑
- 单会话模式，无法进行多任务并行工作流
- 难以自定义和扩展

Polo AI 通过提供丰富的桌面体验来解决这些问题，具备多会话管理、可扩展的来源/技能系统以及原生代理设计原则。

## 产品定位

| 维度 | 说明 |
|------|------|
| **目标用户** | 每日使用 AI 代理的开发者、高级用户和团队 |
| **核心差异化** | 原生代理桌面应用，具备多会话收件箱、可扩展的来源/技能系统和双代理后端 |
| **平台** | 桌面端（macOS、Windows、Linux）+ 无头服务器 + Web UI + CLI |
| **部署方式** | 自托管（本地或远程服务器）、Docker 或云部署 |

## 核心价值主张

1. **多会话收件箱** - 通过状态工作流管理多个并发的 AI 对话
2. **通用连接** - 通过自然语言连接到 MCP 服务器、REST API（Google、Slack、Microsoft）和本地文件系统
3. **双代理后端** - 同时使用 Claude 和 Pi 驱动的模型（OpenAI、Google、GitHub Copilot）
4. **原生代理设计** - 一切都可通过与代理对话来自定义
5. **可扩展技能系统** - 每个工作区可配置专属的代理指令
6. **事件驱动自动化** - 基于标签变更、定时任务、工具事件自动执行工作流

## 单仓结构

```
polo-ai/
├── apps/
│   ├── electron/          # 桌面 GUI（主要客户端）
│   ├── cli/               # 终端客户端
│   ├── viewer/            # Web 会话查看器
│   └── webui/             # 基于 Web 的轻量客户端
└── packages/
    ├── core/              # 共享类型
    ├── shared/            # 业务逻辑（agent、auth、config、credentials、sessions、sources）
    ├── server-core/       # 无头服务器基础设施
    ├── server/            # 服务器入口
    ├── ui/                # 共享 React UI 组件
    ├── session-tools-core/# 会话级工具实用程序
    ├── session-mcp-server/# 会话工具的 MCP 服务器
    ├── pi-agent-server/   # 独立进程的 Pi 代理服务器
    ├── messaging-gateway/ # 外部消息集成
    └── messaging-whatsapp-worker/ # WhatsApp 集成工作进程
```

## 技术栈概览

| 层级 | 技术 |
|------|------|
| 运行时 | Bun |
| 编程语言 | TypeScript |
| AI 后端（Claude） | @anthropic-ai/claude-agent-sdk |
| AI 后端（Pi） | @mariozechner/pi-ai, @mariozechner/pi-coding-agent |
| 桌面端 | Electron + React 18 |
| UI 框架 | shadcn/ui + Tailwind CSS v4 + Radix UI |
| 构建（主进程） | esbuild |
| 构建（渲染进程） | Vite |
| 状态管理 | Jotai |
| 富文本 | TipTap |
| 代码高亮 | Shiki |
| 包管理器 | Bun（workspaces） |
| 加密 | AES-256-GCM（凭据存储） |
| 通信协议 | WebSocket（RPC）、JSONL（代理子进程） |

## 无待确认事项
