# WS-ASSISTANT-SKILLS（ws-assistant-skills）跨工作流诉求台单

分支：`ws-assistant-skills` · 基础：集成分支 154ded3b（已含 ws-shared）

## 1. → ws-circles-account：个人空间「从圈子获取」数据源

已交付 `apps/electron/src/renderer/components/app-shell/skills/DiscoverSkillsList.tsx`：
`channel` 由 SkillsManagerPanel 按 `spaceKind` 决定（个人=圈子库、企业=企业共享库），
组件纯 props 驱动（`items: DiscoverableSkill[]`），企业方向已在 SkillsManagerPanel 内接
`window.electronAPI.creatorArtifactList({ type: 'skill' })` 拉取真实共享库。

请求：个人空间的圈子 Skill 目录目前**没有任何 renderer 可用数据通道**。若圈子侧交付
`circleSkillCatalog`（或等价 electronAPI/preload 表面），请在集成分支接线：
- 数据形状对齐 `DiscoverableSkill`（slug/name/description/provider/version/installed?）
- provider 建议拼「工作室 · 圈子名」格式（多圈同作品只出现一次，D-PC-09）
- 接线点：`SkillsManagerPanel` 的 `discoverItems` prop（个人空间分支），或提供
  `onLoadCircles` 回调后由本组件内部拉取

在此之前，个人空间获取页展示空态卡 + 「查看我的圈子」（`onViewCircles` 已留 prop）。

## 2. → 集成（主 agent）备注，无需跨分支动作

- **旧表面替换**：`components/app-shell/SkillsListPanel.tsx` 已删除，
  `AppShell.tsx` 的 skills 导航改渲染 `components/app-shell/skills/SkillsManagerPanel`
  （props 兼容：skills/workspaceId/availableCreatorSkillVersions/onSkillClick/
  onDeleteSkill/selectedSkillSlug；`workspaceRootPath` 不再需要）。
  `SkillMenu.tsx` 保留：仅 SkillInfoPage 标题菜单在用（信息页工具菜单，非列表表面）。
- **替换表面功能损失清单**（review 整改补披露，主 agent 集成时决定回补方式）：
  1. 空态「添加 Skill」EditPopover 入口：旧面板空态有
     `EditPopover + getEditConfig('add-skill', workspaceRootPath)` 快捷新建本地
     Skill；新面板空态只有「获取 Skill」CTA（跳获取 tab）。回补需要
     `workspaceRootPath` 重新流入 SkillsManagerPanel（AppShell 持有该值）。
  2. 行级 SkillMenu 三操作：旧面板每行菜单有「新窗口打开」
     （`poloai://skills/skill/{slug}?window=focused` deep link）、「在 Finder 中显示」
     （`showInFolder(skill.path)`）、「发送到其他工作区」
     （`SendResourceToWorkspaceDialog`）。新面板行内只有 启用/停用 + 管理 按钮，
     这三操作仅保留在 SkillInfoPage 标题菜单（多一跳）。列表直达入口若需保留，
     建议 SkillDetailSheet 加 `onOpenInNewWindow/onShowInFinder/onSendToWorkspace`
     回调由 AppShell 接线。
  3. 已在本次修复对齐的部分：project 来源「由项目管理」区分（sourceLine 新键
     `skillsManager.source.project`）；不可卸载来源（builtin/project/无 backing 行）
     卸载按钮禁用 + tooltip，不再假成功。
- **测试迁移**：`components/ui/__tests__/creator-skill-safety-surfaces.interaction.isolated.ts`
  的渲染对象从 SkillsListPanel 迁到 SkillsManagerPanel（断言不变）。
- **启停持久化缺口**：R6「启用偏好沿用既有账号＋空间＋Skill 同步规则」需要后端存储
  通道（当前 LoadedSkill 无 enablement 字段）。SkillsManagerPanel 现为面板本地态
  （useState）+ toast 反馈；主进程/contexts 若提供持久化表面，接线点在
  `SkillsManagerPanel.handleToggleEnabled`。
- **安装动作**：企业共享安装已接真实通道（`creatorSkillGetDownloadGrant` +
  `creatorSkillInstall`，含冲突确认与错误 toast，对齐 SkillInfoPage 参考实现）；
  无接线语境（demo 数据 / 圈子目录未交付）走面板内自洽流程（本机新增停用行 +
  获取行变「管理」），无定时器。
- playground registry：`index.ts` 仅追加 2 行 import + 2 行 spread
  （skills-manager / assistant-session，均为本 WS 文件）。
