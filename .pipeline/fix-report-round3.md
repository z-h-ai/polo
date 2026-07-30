# POO-21 Reviewer Round 3 修复报告

## 逐项处理结果

### 1. Creator Skill 备份路径可经符号链接越界

已修复。

- Renderer 与 RPC 不再传递或接受绝对备份路径；单项删除仅提交经过严格 schema 校验的 `slug + backupId`，目标路径由拥有 workspace 文件系统的 server-core 重新推导。
- 安装器统一通过安全路径解析函数处理保留备份、备份列表、单项删除和全部删除：先规范化 workspace，再逐级 `lstat` / `realpath` 校验 `skill-backups` 根、slug 目录和具体备份目标，拒绝符号链接、非目录节点及任何越界结果。
- journal 恢复不信任持久化的备份绝对路径，仍从已校验的 workspace、slug 和 operation 数据重推目标。
- 新增回归测试，分别构造 backup root、slug 目录和备份目标为指向 workspace 外部的符号链接，验证保留备份和删除操作均被拒绝，外部 sentinel 始终保留。

关键文件：

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/schemas.ts`
- `packages/shared/src/creator-skills/types.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`
- `packages/shared/src/creator-skills/__tests__/schemas.test.ts`
- `packages/server-core/src/handlers/rpc/skills.ts`
- `packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage.tsx`

### 2. 同名覆盖确认缺少新旧来源与版本

已修复。

- 安装冲突结果新增结构化 `existing` / `incoming` identity，包含本地层级或 Creator 来源、organization/artifact、slug 和 version；不再依赖 renderer 从枚举猜测来源。
- 统一确认文案明确展示“当前来源/版本 → 将安装来源/版本”。
- 当现有安装与待安装内容属于不同 `artifactId` 时，使用单独的“来源替换”警告文案。
- 新增 installer identity 断言和 renderer 交互测试，验证确认框同时展示旧 artifact/version 与新 artifact/version。

关键文件：

- `packages/shared/src/creator-skills/types.ts`
- `packages/shared/src/creator-skills/installer.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/renderer/lib/creator-skill-conflicts.ts`
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/pages/SkillInfoPage.tsx`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`

### 3. 修改过的 Creator Skill 缺少明确强制删除入口

已修复。

- 默认卸载语义保持不变：检测到本地修改时只 detach Installation Ledger，目录作为普通 workspace Skill 保留。
- 列表和详情页共用二次确认流程；detach 后明确告知本地修改将被永久删除，用户再次确认才调用 `creatorSkillUninstall(... forceDeleteModified: true)`。
- 安装器允许对已经 detach、但目录仍存在的 Creator Skill 完成显式强制删除，不重新认领 Ledger。
- 新增单元与交互测试，覆盖默认保留目录以及二次确认后删除目录的完整流程。

关键文件：

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`
- `apps/electron/src/renderer/lib/creator-skill-delete.ts`
- `apps/electron/src/renderer/lib/__tests__/creator-skill-delete.test.ts`
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- `apps/electron/src/renderer/pages/SkillInfoPage.tsx`
- `apps/electron/src/renderer/pages/__tests__/SkillInfoPage.creator-skill.interaction.isolated.ts`

### 4. 当前 Safety Status 请求失败未立即传播

已修复。

- 安全检查状态改为按 `workspaceId + artifactId + version + archiveChecksum` 精确索引的 `checking / ok / failed` live state。
- 当前请求失败会立即标记 `failed`，不再受 Ledger 中较新的 `lastCheckedAt` 抑制；同时保留 `lastKnownStatus`，不会把未知状态误显示为安全。
- AppShell 将 live state 合并到当前完整 Skill 列表，因此失败警告同步出现在 Skill 列表、详情页和两个 `@` 候选入口。
- 新增回归测试，覆盖 `lastCheckedAt` 很新但当前请求失败，以及列表和 `@` 候选均显示安全状态更新失败。

关键文件：

- `apps/electron/src/renderer/atoms/creator-skill-safety.ts`
- `apps/electron/src/renderer/hooks/useCreatorSkillSafetyMonitor.ts`
- `apps/electron/src/renderer/lib/creator-skill-safety-display.ts`
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- `apps/electron/src/renderer/components/app-shell/SkillsListPanel.tsx`
- `apps/electron/src/renderer/components/ui/mention-menu.tsx`
- `apps/electron/src/renderer/components/ui/skill-mention-menu.tsx`
- `apps/electron/src/renderer/pages/SkillInfoPage.tsx`
- `apps/electron/src/renderer/components/ui/__tests__/creator-skill-safety-surfaces.interaction.isolated.ts`
- `apps/electron/src/renderer/pages/__tests__/SkillInfoPage.creator-skill.interaction.isolated.ts`

### 5. 历史版本切换仍展示最新版内容

已修复。

- Artifact detail API 支持按 `artifactId + version` 获取不可变版本详情，renderer 以该完整身份缓存，不复用最新版正文。
- 历史版本选择会同步切换版本元数据、`SKILL.md`、manifest/file tree、文件数、总大小、checksum 和 content digest；精确版本详情加载完成前禁用安装，避免元数据与内容错配。
- `references/` 不会自动打开或渲染。用户必须显式选择 Preview，服务端才按已选版本与规范化相对路径返回纯文本；下载也是独立显式动作。
- reference RPC schema 要求同时提供 version，并拒绝绝对路径、路径穿越、反斜杠、重复分隔符等非法路径。
- 新增两个正文和文件树不同的版本切换测试，并验证 reference 内容在点击前不可见、点击后请求携带所选历史版本。

关键文件：

- `packages/shared/src/admin/client.ts`
- `packages/shared/src/creator-skills/schemas.ts`
- `packages/shared/src/creator-skills/types.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
- `packages/shared/src/creator-skills/__tests__/schemas.test.ts`

### 6. 动态错误码缺翻译时泄露 backend 英文

已修复。

- 新增统一 renderer 错误翻译器。已知稳定错误码只解析 `creatorSkills.errors.*`；未知错误统一展示本地化 `creatorSkills.errors.unknown`，backend `message` 不再作为 `defaultValue` 或用户可见文案。
- backend message 仅保留在可复制诊断数据中。
- 补齐 Creator Skill 稳定错误码及本轮新增交互文案在 `en/de/es/hu/ja/pl/zh-Hans` 的翻译，并增加 locale key parity 与非英语翻译断言。
- 西班牙语错误翻译测试在完成后恢复全局语言，避免污染同一测试进程中的后续用例。

关键文件：

- `apps/electron/src/renderer/lib/creator-skill-errors.ts`
- `apps/electron/src/renderer/lib/__tests__/creator-skill-errors.test.ts`
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- `apps/electron/src/renderer/pages/SkillInfoPage.tsx`
- `apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage.tsx`
- `packages/shared/src/i18n/__tests__/locale-parity.test.ts`
- `packages/shared/src/i18n/locales/en.json`
- `packages/shared/src/i18n/locales/de.json`
- `packages/shared/src/i18n/locales/es.json`
- `packages/shared/src/i18n/locales/hu.json`
- `packages/shared/src/i18n/locales/ja.json`
- `packages/shared/src/i18n/locales/pl.json`
- `packages/shared/src/i18n/locales/zh-Hans.json`

## 自测命令与结果

- 仓库全量测试：
  - `bun run test`
  - 主测试套件 4815 pass、19 skip、0 fail（4834 tests / 368 files）；随后仓库全部 `*.isolated.ts` 逐文件执行通过。
- 共享包类型检查：
  - `bun run typecheck:shared`
  - 通过。
- server-core 类型检查：
  - `cd packages/server-core && bun run typecheck`
  - 通过。
- Electron 类型检查：
  - `bun run typecheck:electron`
  - 通过。
- Electron ESLint：
  - `cd apps/electron && bun run lint`
  - 0 error；111 个仓库既有 warning。
- i18n 排序与完整性：
  - `bun run lint:i18n:sorted`
  - `bun scripts/check-i18n-parity.ts`
  - 均通过；6 个非英语 locale 各 1724 keys。
- 补充静态检查：
  - `git diff --check`
  - 通过。

## 遗留问题

- Reviewer Round 3 列出的 6 个问题均已修复，无已知任务范围内遗留。
- Electron ESLint 仍报告 111 个仓库既有 warning，本轮没有新增 lint error。
