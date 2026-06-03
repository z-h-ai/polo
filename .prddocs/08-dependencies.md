# 08 - 依赖关系

## 运行时依赖

### AI 与 Agent SDK
| 包名 | 版本 | 用途 |
|------|------|------|
| @anthropic-ai/claude-agent-sdk | 0.2.123 | Claude Agent 后端（原生二进制） |
| @mariozechner/pi-ai | 0.73.1 | Pi AI SDK（多提供商 LLM） |
| @mariozechner/pi-coding-agent | 0.73.1 | Pi 编码 Agent 能力 |
| @mariozechner/pi-agent-core | 0.73.1 | Pi Agent 核心抽象 |
| @modelcontextprotocol/sdk | ^1.24.3 | MCP 协议客户端 |
| @github/copilot-sdk | ^0.1.23 | GitHub Copilot OAuth 集成 |

### UI 框架
| 包名 | 版本 | 用途 |
|------|------|------|
| react | ^18.3.1 | UI 渲染 |
| react-dom | ^18.3.1 | DOM 渲染 |
| @radix-ui/react-* | 各版本 | 无障碍 UI 基础组件 |
| lucide-react | ^0.561.0 | 图标库 |
| class-variance-authority | ^0.7.1 | 组件变体 |
| clsx | ^2.1.1 | 类名工具 |
| tailwind-merge | ^3.4.0 | Tailwind 类名合并 |
| motion | ^12.23.26 | 动画库 |
| cmdk | ^1.1.1 | 命令面板 |
| sonner | ^2.0.7 | Toast 通知 |
| vaul | ^1.1.2 | 抽屉组件 |
| @tanstack/react-table | ^8.21.3 | 数据表格 |

### 富文本与内容处理
| 包名 | 版本 | 用途 |
|------|------|------|
| @tiptap/react | ^3.20.0 | 富文本编辑器 |
| @tiptap/starter-kit | ^3.20.0 | 编辑器默认扩展 |
| @tiptap/markdown | ^3.20.0 | Markdown 支持 |
| @tiptap/extension-image | ^3.20.0 | 图片嵌入 |
| @tiptap/extension-mathematics | ^3.20.0 | 数学公式/KaTeX 支持 |
| shiki | ^3.19.0 | 语法高亮 |
| react-markdown | ^10.1.0 | Markdown 渲染 |
| remark-gfm | ^4.0.1 | GitHub Flavored Markdown |
| remark-math | ^6.0.0 | 数学符号 |
| rehype-katex | ^7.0.1 | KaTeX 渲染 |
| rehype-raw | ^7.0.0 | Markdown 中的原始 HTML |
| katex | ^0.16.33 | 数学排版 |
| beautiful-mermaid | ^1.1.3 | Mermaid 图表渲染 |

### 状态与数据管理
| 包名 | 版本 | 用途 |
|------|------|------|
| jotai | ^2.16.0 | 原子化状态管理 |
| zod | ^4.0.0 | Schema 验证 |
| date-fns | ^4.1.0 | 日期工具 |
| semver | ^7.7.3 | 版本比较 |
| gray-matter | ^4.0.3 | Frontmatter 解析 |

### 网络与认证
| 包名 | 版本 | 用途 |
|------|------|------|
| ws | ^8.19.0 | WebSocket 服务端/客户端 |
| jose | ^6.0.0 | JWT/JWK 处理 |
| undici | ^7.22.0 | HTTP 客户端（Electron） |
| pkce-challenge | （来自 SDK） | PKCE OAuth 流程 |

### 桌面端
| 包名 | 版本 | 用途 |
|------|------|------|
| electron | ^39.2.7 | 桌面框架 |
| electron-updater | ^6.8.0 | 自动更新 |
| electron-log | ^5.4.3 | 日志记录 |
| sharp | 0.34.5 | 图片处理 |

### 监控
| 包名 | 版本 | 用途 |
|------|------|------|
| @sentry/electron | ^7.7.0 | 错误追踪（桌面端） |
| @sentry/react | ^10.36.0 | 错误追踪（渲染进程） |

### 构建工具
| 包名 | 版本 | 用途 |
|------|------|------|
| esbuild | ^0.25.0 | 主进程打包 |
| vite | ^6.2.4 | 渲染进程打包 |
| typescript | ^5.0.0 | 类型检查 |
| tailwindcss | ^4.1.18 | CSS 框架 |

## Pi Agent Server 依赖

| 包名 | 版本 | 用途 |
|------|------|------|
| @mariozechner/pi-coding-agent | 0.73.1 | Pi 编码 Agent |
| @mariozechner/pi-agent-core | 0.73.1 | Pi Agent 核心 |
| duck-duck-scrape | ^2.2.7 | 网页搜索 |
| pdfjs-dist | ^5.4.0 | PDF 处理 |
| turndown | ^7.2.0 | HTML 转 Markdown |
| node-html-parser | ^6.1.0 | HTML 解析 |

## 外部服务依赖

### AI 提供商
| 服务 | 协议 | 用途 |
|------|------|------|
| Anthropic API | HTTPS | Claude 模型 |
| OpenAI API | HTTPS | GPT 模型 |
| Google AI Studio | HTTPS | Gemini 模型 |
| GitHub Copilot | OAuth | Copilot 模型 |
| OpenRouter | HTTPS | 多模型代理 |
| Ollama | HTTP | 本地模型 |

### OAuth 提供商
| 提供商 | 流程 | 用途 |
|--------|------|------|
| Google | OAuth 2.0 + PKCE | Gmail、日历、云端硬盘、YouTube |
| Slack | OAuth 2.0 | Slack 工作区 |
| Microsoft | OAuth 2.0 + PKCE | Outlook、OneDrive、Teams |

### 消息平台
| 服务 | 协议 | 用途 |
|------|------|------|
| WhatsApp | Baileys（WebSocket via Worker） | WhatsApp Business |
| Telegram | grammY（长轮询） | Telegram Bot/超级群组 |
| Lark/飞书 | @larksuiteoapi/node-sdk（WebSocket） | Lark/飞书集成 |

## 依赖风险评估

| 风险 | 涉及依赖 | 缓解措施 |
|------|----------|----------|
| Pi SDK 耦合 | @mariozechner/pi-* | Pi Agent 作为隔离子进程运行 |
| Electron 版本滞后 | electron ^39.2.7 | electron-updater 自动更新 |
| Sharp 原生二进制 | sharp 0.34.5 | 平台特定的可选依赖 |
| Bun 兼容性 | 运行时 | Docker 构建使用固定 Bun 版本 |
