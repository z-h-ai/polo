# 03 - 功能需求

## FR-1：多会话管理

### FR-1.1 会话收件箱
- 会话按工作流状态组织（待办、进行中、待审查、已完成）
- 已完成会话的归档系统
- 重要会话的标记系统
- AI 生成的会话标题
- 会话持久化（完整对话历史以 JSONL 格式保存到磁盘）

### FR-1.2 会话操作
- 创建新会话（Cmd+N）
- 删除会话
- 重命名会话（手动或 AI 生成）
- 归档/取消归档会话
- 更改会话状态
- 通过链接分享会话（查看器应用）

### FR-1.3 会话状态工作流
- 可自定义的状态（默认：待办 → 进行中 → 待审查 → 已完成）
- 状态转换触发自动化事件
- 动态状态系统，支持可配置的工作流状态

## FR-2：AI 聊天界面

### FR-2.1 消息处理
- 流式 AI 响应，实时更新
- 支持文件附件的富文本输入
- 多文件差异查看器（VS Code 风格），用于查看对话轮次中的文件变更
- 图片附件支持
- PDF、Office 文档附件，自动转换为文本/Markdown
- 对话中途中断（UserStop）
- 流式消息中途引导（Pi 提供商）或排队（Claude 提供商）

### FR-2.2 权限模式
| 模式 | 显示名称 | 行为 |
|------|----------|------|
| `safe` | Explore | 只读，阻止所有写操作 |
| `ask` | Ask to Edit | 需要用户确认批准（默认） |
| `allow-all` | Auto | 自动批准所有命令 |

- SHIFT+TAB 在聊天中切换模式
- 模式变更触发自动化事件
- 每个会话独立保存模式设置

### FR-2.3 思考等级
- 多种思考等级选项（取决于模型支持）
- 每个会话可单独调整思考等级
- 每个连接可配置默认思考等级

### FR-2.4 上下文管理
- 会话压缩（手动 `/compact` 和自动）
- 可配置的自动压缩开关
- 压缩保留对话摘要同时减少 Token 数量

## FR-3：多提供商 LLM 支持

### FR-3.1 直连提供商
| 提供商 | 认证方式 |
|--------|----------|
| Anthropic | API 密钥或 Claude Max/Pro OAuth |
| Google AI Studio | API 密钥 |
| ChatGPT Plus/Pro | Codex OAuth |
| GitHub Copilot | OAuth（设备代码流程） |

### FR-3.2 第三方提供商（通过自定义端点）
- OpenRouter（访问数百个模型）
- Vercel AI Gateway
- Ollama（本地模型）
- 任何兼容 OpenAI/Anthropic 的端点

### FR-3.3 连接管理
- 添加多个 LLM 连接
- 设置每个工作区的默认连接
- 运行时模型切换（部分变更无需重启会话）
- 自定义端点模型注册

## FR-4：来源系统

### FR-4.1 来源类型
| 类型 | 示例 |
|------|------|
| MCP 服务器 | Polo AI、Linear、GitHub、Notion、自定义服务器 |
| REST API | Google（Gmail、日历、云端硬盘、YouTube、Search Console）、Slack、Microsoft |
| 本地文件 | 文件系统、Obsidian 笔记库、Git 仓库 |

### FR-4.2 来源管理
- 自然语言配置来源（"add Linear as a source"）
- 粘贴 MCP 配置 JSON 即可完成设置
- 基于 stdio 的 MCP 服务器作为本地子进程运行
- 支持 HTTP/SSE MCP 服务器
- API 来源的 OAuth 流程（Google、Slack、Microsoft）
- API 来源的 Token 刷新（OAuth 和续订端点）
- 在对话中使用 @mention 引用来源

### FR-4.3 来源安全
- 凭据加密存储（AES-256-GCM）
- 本地 MCP 服务器的环境变量清理
- 每个来源的凭据隔离

## FR-5：技能系统

### FR-5.1 技能管理
- 每个工作区独立的技能存储
- 自然语言创建技能（"create a skill that..."）
- 导入 Claude Code 技能
- 在对话中使用 @mention 引用技能
- 技能即时生效（无需重启）
- 三级加载与优先级覆盖：全局（`~/.agents/skills/`） < 工作区 < 项目（`{projectRoot}/.agents/skills/`）
- 结果按 `(workspaceRoot, projectRoot)` 对缓存 5 分钟

### FR-5.2 技能结构
- 技能以目录形式存储，包含 `SKILL.md` 文件
- YAML frontmatter 元数据：`name`、`description`、`globs`（自动触发）、`alwaysAllow`、`icon`、`requiredSources`
- Markdown 正文包含代理指令
- 图标支持：emoji（直接使用）、URL（自动下载）或本地文件自动发现
- 使用 `gray-matter` 解析（YAML frontmatter + Markdown 正文）

## FR-6：自动化

### FR-6.1 事件类型
- `LabelAdd` / `LabelRemove` - 标签变更
- `PermissionModeChange` - 权限模式切换
- `FlagChange` - 会话标记变更
- `SessionStatusChange` - 状态转换
- `SchedulerTick` - 基于 Cron 的定时调度
- `PreToolUse` / `PostToolUse` - 工具执行事件
- `SessionStart` / `SessionEnd` - 会话生命周期事件

### FR-6.2 自动化动作
- **PromptAction**：使用模板提示创建新的代理会话
- **WebhookAction**：发送 HTTP 请求，支持重试、每端点速率限制（30次/分钟）、可选响应捕获（截断至 4KB）
- 在提示中支持来源和技能的 `@mentions`
- 环境变量展开（`$POLO_AI_LABEL`、`$POLO_AI_SESSION_ID`）
- Telegram/Lark 话题路由，用于消息集成

### FR-6.3 自动化配置
- 自然语言设置（"set up a daily standup at 9am"）
- 在 `automations.json` 中手动 JSON 配置
- 每个工作区的自动化作用域
- 支持带时区的 Cron 表达式
- **条件系统**：时间段（after/before）、星期几、状态检查（value/from-to/contains/not）、逻辑组合（and/or/not）
- **事件总线**：速率限制（10 事件/分钟，SchedulerTick 为 60/分钟），并行处理程序执行
- **事件日志**：`automations-history.jsonl`，支持轮转（每个匹配器 20 条记录，全局上限 1000 条）
- **重试队列**：`automations-retry-queue.jsonl`，用于失败的自动化执行

## FR-7：桌面应用

### FR-7.1 窗口管理
- 三栏布局（侧边栏、会话列表、聊天区）
- Cmd+1/2/3 切换面板焦点
- 可拖拽调整大小的面板
- 深色/浅色主题支持
- 平台特定的窗口样式：macOS（隐藏内嵌标题栏 + 毛玻璃效果）、Windows（Mica/Acrylic）、Linux（原生框架）
- 专注模式（900x700）对比默认模式（1400x900）
- 多窗口支持，每个窗口可绑定不同工作区
- 分层关闭：模态框 → 面板 → 窗口（3秒 IPC 回退）
- 窗口状态持久化（位置、专注模式、URL）
- macOS 全屏覆盖层的红绿灯按钮管理

### FR-7.2 菜单系统
- 带有键盘快捷键的应用菜单
- 后台运行的托盘图标
- 深度链接支持（`poloai://` URL）

### FR-7.3 三种运行模式
| 模式 | 条件 | 行为 |
|------|------|------|
| 普通模式 | 默认 | 完整服务器 + GUI，SessionManager 本地运行 |
| 纯客户端模式 | 设置了 `POLO_AI_SERVER_URL` | 瘦客户端，连接远程服务器 |
| 无头模式 | 设置了 `POLO_AI_HEADLESS` | 服务器无 GUI 窗口 |

### FR-7.4 自动更新
- 使用 electron-updater 自动更新
- DMG/PKG/AppImage/MSI 分发
- 调试模式，含详细日志

## FR-8：无头服务器

### FR-8.1 服务器操作
- 基于 WebSocket 的 RPC 服务器（端口 9100）
- Bearer Token 认证
- TLS 支持（wss://）
- Docker 部署
- 多平台支持（Linux x64/arm64、macOS x64/arm64）

### FR-8.2 瘦客户端模式
- 桌面应用连接远程服务器
- UI 本地渲染，所有逻辑在服务器上运行
- 服务器端会话持久化

## FR-9：CLI 客户端

### FR-9.1 CLI 命令
- `ping`、`health`、`versions` - 服务器信息
- `workspaces`、`sessions`、`connections`、`sources` - 列表查询
- `session create`、`session messages`、`session delete` - 会话操作
- `send` - 发送消息并流式接收响应
- `cancel` - 取消正在进行的处理
- `run` - 独立的提示执行
- `invoke`、`listen` - 原始 RPC 操作
- `--validate-server` - 21 步集成测试

### FR-9.2 Run 命令功能
- 独立运行：启动服务器、执行提示、流式响应、退出
- 通过标志支持多提供商
- 工作区和来源注册
- 管道输入支持
- JSON 输出，用于脚本化处理

## FR-10：浏览器面板

### FR-10.1 内嵌浏览器
- 使用 WebContentsView 实例实现内嵌网页浏览
- Chrome DevTools Protocol 集成
- 带导航功能的浏览器工具栏（后退、前进、刷新、停止）
- 浏览器工具栏窗口使用独立的 preload 脚本
- 外部链接的 URL 安全分类

## FR-11：桌面通知

### FR-11.1 通知系统
- 原生操作系统通知，支持会话路由
- Dock 角标显示未读消息数量
- 点击通知导航到对应的会话
- 自动更新状态通知

## FR-12：国际化

### FR-10.1 i18n 支持
- 区域设置注册表，单一数据源（`registry.ts`）
- 翻译文件位于 `src/i18n/locales/{lang}.json`
- 平坦的点分隔键名约定
- 支持 i18next 复数形式
- 运行时语言切换
- 验证：排序键、跨语言对等性、覆盖率检查

### FR-10.2 当前语言
- 英语（en）
- 西班牙语（es）
- 简体中文（zh-Hans）

## FR-11：Web UI

### FR-11.1 WebUI 客户端
- 基于浏览器的瘦客户端
- 通过 WebSocket 连接服务器
- 来源 OAuth 回调处理
- 会话管理

### FR-11.2 会话查看器
- 独立的 Web 应用，用于查看分享的会话
- 上传和分享会话记录
- Markdown 渲染、代码高亮

## FR-12：消息集成

### FR-12.1 消息网关架构
消息网关采用适配器模式，每个工作区有一个中央 `MessagingGateway` 编排器。它支持三个平台适配器：

### FR-12.2 WhatsApp
- 通过 Baileys（`@whiskeysockets/baileys`）集成 WhatsApp Business
- 工作子进程（基于 Node.js）用于崩溃隔离
- 通过 stdin/stdout 使用 NDJSON 进行工作进程通信
- 二维码和手机号码配对模式
- 自聊模式（从同一账号的其他设备发送消息）
- 文件发送（照片、文档、语音、视频、音频）
- 指数退避重连（最多 10 次）
- 不支持内联按钮或消息编辑（WhatsApp 限制）

### FR-12.3 Telegram
- 通过 `grammY` 库集成 Telegram 机器人/超级群组
- 长轮询，带指数退避重连
- 私信、超级群组论坛话题、内联按钮、消息编辑
- 文件附件（照片、文档、语音、视频、音频）
- 用于交互式操作的回调查询
- 论坛话题支持在一个超级群组中管理多个会话
- 通过 Bot API 编程创建论坛话题

### FR-12.4 Lark/飞书
- 使用 `@larksuiteoapi/node-sdk`，通过 WebSocket 长轮询
- 两种域名选项：`lark`（国际版）和 `feishu`（国内版）
- 支持文本、图片和文件消息
- 交互式卡片替代 Telegram 风格的内联按钮
- 通过 `card.action.trigger` 事件处理卡片操作

### FR-12.5 消息网关核心
- `MessagingGatewayRegistry` 管理每个工作区的实例
- `Router` 路由入站消息：已绑定频道 → 会话，未绑定 → Commands
- `Renderer` 将会话事件转换为聊天消息（3 种模式：streaming、progress、final_only）
- `BindingStore` 将 `(platform, channelId, threadId)` 映射到会话
- 访问控制：双层模型（工作区：open/owner-only；每绑定：inherit/allow-list/open）
- `PendingSendersStore` 跟踪被拒绝的发送者，支持在设置 UI 中一键提升权限
- 命令：`/new`、`/bind`、`/pair`、`/plan` 等
- 引导：可组合的工厂，由 Electron 和独立 Bun 主机共享

## FR-13：标签与视图系统

### FR-13.1 标签
- 每个会话的标签（标记）
- 标签的增删改查操作
- 标签触发的自动化
- 自动标签支持

### FR-13.2 视图
- 可自定义的会话视图
- 视图存储和管理
- 按状态、标签、标记进行筛选

## 待确认事项

| 编号 | 内容 | 置信度 | 建议 |
|------|------|--------|------|
| TC-002 | Lark/飞书功能完整性 | 中等 | 确认完整的 Lark/飞书卡片交互支持 |
| TC-003 | WebUI 与 Electron 应用的功能对等性 | 中等 | 确认哪些功能为 Web 专属 |
| TC-004 | 标签自动标记规则引擎 | 中等 | 确认是基于规则还是 AI 驱动 |
