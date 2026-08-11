# Phase 3 流程附件：PC-F04 启用 Skill 并使用 Polo 助手（黄金流程）

> 与 `.pipeline/phase3-golden-common.md` 共同构成完整合同。公共合同的必读上下文、输出结构、自检与禁止项全部生效。

## 流程语义（来自场景矩阵，scene ID 逐字一致）

场景集：`skills-list` / `skill-enable-confirm` / `skill-enabled` / `assistant-home` / `chat-normal` / `skill-source-picker` / `skill-permission-confirm` / `skill-running` / `skill-result` / `chat-failed` / `skill-expired` / `skill-blocked` / `skills-empty` / `history-loading`。

POO-41 交互轨迹：从首页或全部 Apps 打开 Polo 助手 → 助手作为客户端 Tab 出现 → 当前 ProductSpace 正确交接 → 助手内部没有第二套全局空间、账号、目录、文件或 Browser Tab 外壳。内部计量归属遵守当前空间契约，但常规助手界面不持续展示算力承担说明。

黄金重点（主计划 §7）：**POO-41 冻结复用边界，不在静态原型重做助手内部状态机**。正式 POO-44 选择性复用真实源码的会话列表、消息布局、输入框、附件、代码块、工具调用、执行进度、结果和错误反馈；ProductSpace、账号、目录、运行和全局文件由新工作台外壳承载。Skill 不能独立打开或生成 Tab，启用、调用和权限确认由真实助手组件完成。

## Phase 3-A 前置任务：Polo 助手内嵌化与去壳层重构

PC-F04 的 After 必须建立在 Phase 2 工作台壳层已经确认的基础上。先完成以下模块归属迁移，再实现 Skill 黄金流程：

| 旧助手模块或能力 | 处理方式 |
| --- | --- |
| `OrganizationSwitcher` | 从助手移除；使用客户端顶部唯一的 ProductSpace 切换器 |
| 账号、退出、全局设置和企业/创作者管理入口 | 移到客户端账号菜单 |
| App 目录、下载和全局运行状态 | 移到首页、顶部运行中心和“任务与结果” |
| 全局文件入口 | 移到“文件”内置 App；助手只保留当前对话附件与结果文件 |
| 会话列表、消息区、输入框、附件、代码块、工具调用、进度和结果 | 保留并复用真实助手组件 |
| Skill 启用、选择、权限确认与调用 | 保留在助手内，按当前 ProductSpace 隔离 |
| `WorkspaceSwitcher` | 不映射为 ProductSpace；确需工作目录时改为本次对话上下文或高级设置 |

v1 已确认：`Sources`、`Automations` 和 Browser 只属于 Polo 助手内部能力，不进入客户端顶层导航、首页、系统工具或独立 App Tab。Browser 从助手会话触发并在输入/工具区域显示状态，不迁移旧 `BrowserTabStrip`。移除旧控件必须解除其导航和状态所有权，不能只用 CSS 隐藏。

## 输出位置

`/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/design-demos/polo-client-g4-ui/flows/pc-f04/`

## Before 提取目标（polo-dir/dev @ `01f4447cf77612ca2c62d9c7155601a51bdb7b5b`，静态提取）

| 证据 | 路径 | 用途 |
| --- | --- | --- |
| 会话组合入口 | `apps/electron/src/renderer/pages/ChatPage.tsx` | 会话列表/消息区/输入框真实结构 |
| 对话辅助组件 | `apps/electron/src/renderer/components/chat/` | 消息、代码块、工具调用等 |
| Skill 状态 | `apps/electron/src/renderer/atoms/skills.ts` | 现有 Skill 加载模型（无显式启用——After 的新增点） |
| Skill 失效/归档 UI | `apps/electron/src/renderer/pages/SkillInfoPage.tsx`（约 397 行附近 revoked/archived/stale） | `skill-expired`/`skill-blocked` Before 依据 |
| 中英文案 | `packages/shared/src/i18n/locales/zh-Hans.json`、`en.json` | before/after 真实文案 |
| 设计 token | `docs/DESIGN.md` | oklch 双色派生、组件参数 |

证据分级：`partial_surface`（真实对话 UI 可静态忠实还原；显式启用 UI 当前不存在，Before 对应 scene 呈现真实现状：助手可用但 Skill 仅"已加载"语义）。

## 协议与视口

- `themes: ["light","dark"]`；`langs: ["zh-Hans","en","de","es","hu","ja","pl"]`（zh-Hans/en 全量翻译，其余 5 语言至少翻译导航、分区标题、按钮并在 manifest 声明覆盖范围）。
- 视口：desktop 1440×900、small-window 1024×768、narrow-probe 390×844（390 呈现壳层同款"窗口过窄"保护态，所有 scene 在 390 下均为该保护态）。
- fixture 沿用壳层：账号「林然」、我的空间、企业「北辰智能科技」、圈子「桥见圈子」；Skill 示例「纪要整理」「品牌洞察」（与壳层首页 Skills 区一致）。

## 本流程特有验收项

1. POO-41 After 只呈现助手入口、客户端 Tab 容器、当前空间标识和源码复用边界；内部状态 scene 可以落到同一真实助手容器并标注预期状态，不要求静态原型复制实现。
2. Skills、Sources、Automations 和 Browser 都只有助手内部入口；Skill 不生成新 Tab或独立窗口。
3. POO-44 E2E 必须覆盖同名 Skill 来源选择、权限确认、运行、结果、失败、失效、阻断和历史加载，并可追溯到真实 `ChatPage`、输入区和工具调用组件。
4. `skill-blocked` 的正式实现保留历史结果并标记来源版本已阻断。
5. 真实助手组件映射和被移除的旧外壳区域必须记录在 POO-44 验收证据中。
6. 助手内部不出现 `OrganizationSwitcher`、账号菜单、App 目录、下载中心、全局文件、通用偏好或管理端入口。
7. 客户端只有一个 ProductSpace 切换入口；切换后助手的会话、附件、Skills 和运行上下文整体切换，不自动打开目标空间的旧对话。
8. 本地 Workspace 不伪装成 ProductSpace；需要工作目录时只显示为当前对话上下文或高级设置。
