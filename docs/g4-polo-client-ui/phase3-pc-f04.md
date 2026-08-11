# Phase 3 流程附件：PC-F04 启用 Skill 并使用 Polo 助手（黄金流程）

> 与 `.pipeline/phase3-golden-common.md` 共同构成完整合同。公共合同的必读上下文、输出结构、自检与禁止项全部生效。

## 流程语义（来自场景矩阵，scene ID 逐字一致）

场景集：`skills-list` / `skill-enable-confirm` / `skill-enabled` / `assistant-home` / `chat-normal` / `skill-source-picker` / `skill-permission-confirm` / `skill-running` / `skill-result` / `chat-failed` / `skill-expired` / `skill-blocked` / `skills-empty` / `history-loading`。

交互轨迹（after.html 必须真实走通）：Skills 区启用「纪要整理」→ 打开 Polo 助手 → 发任务 → 对话内确认权限 → 看到 Skill 调用过程与结果 → 费用归我的空间。

黄金重点（主计划 §7）：**旧助手保留**（尽量保留真实源码的会话列表、消息布局、输入框、附件、代码块、工具调用、执行进度、结果和错误反馈）、新工作台外壳、Skill 新定位（不能独立打开、不生成 Tab、启用/调用/确认都在助手对话中）、权限确认。

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

1. `skills-list` 中每个 Skill 显示名称/创作者/来源圈子/状态（CONTEXT.md 作品身份规则：同名能力必须显示来源）。
2. `skill-source-picker` 呈现两个圈子同名 Skill 的来源选择（不静默调用）。
3. `skill-permission-confirm` 与 `skill-running`/`skill-result` 全部在助手对话流内呈现，不生成新 Tab、无独立 Skill 窗口。
4. `skill-blocked` 显示安全原因 + 历史结果保留但标记来源版本已阻断。
5. After 的对话区结构必须能从 ChatPage.tsx 逐项追溯（manifest regions 记录对应关系）。
