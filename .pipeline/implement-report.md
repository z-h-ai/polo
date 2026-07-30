# POO-21 实现报告

## 变更摘要

- 收紧 Creator Skill 安装事务边界：`operationId` 统一限制为 UUID；所有操作目录、目标目录、事务备份、保留备份和恢复 journal 路径均从规范化 workspace、slug、operationId 重新推导并做 `realpath` 边界检查。恶意或越界 journal 会保留现场并中止恢复，不会删除外部路径。
- 修复安装/更新持久化顺序：journal 使用临时文件、文件 `fsync`、原子 rename 和尽力而为的目录 `fsync`；只有 `committed` 状态可靠落盘后才删除旧版本事务备份。`ledger_committed` 及 `committed` 故障点均增加确定性故障注入回归测试。
- 将 Creator Skill RPC 绑定到连接当前打开的 workspace，并以实际文件系统写权限计算 `writable`；GET_TARGET、安装、更新、卸载、删除和备份管理均拒绝 workspace 越权或只读写入。
- ZIP 中央目录采用 lazy entry 流式计数，并对文件、目录和噪音条目执行不可突破的 1000 Entry 硬上限，避免大量空目录导致中央目录内存膨胀。
- “作品”面板改为聚合 Web App 与 Skill Catalog，列表展示类型徽标；新建作品先选择 Web App 或 Skill，Web App 跳转既有管理流程，Skill 保留本任务发布流程。Skill 功能关闭时仍展示 Web App。
- 撤销版本存在更低 `safeVersion` 时，Skill 详情和列表会提供明确的安全回滚版本与操作；正常 active 版本不会误提示降级。
- 新增 workspace 级安全状态调度器：按 `lastCheckedAt` 安排 24 小时周期复查，失败退避 5 分钟，去重 in-flight 请求，并在 workspace 切换/组件卸载时清理状态和定时器。
- 首版默认 changelog 改为 `creatorSkills.version.initialChangelog`，并补齐 7 个 locale；同时补齐作品类型、Web App 流程和安全回滚文案。

## 关键文件列表

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/archive.ts`
- `packages/shared/src/creator-skills/schemas.ts`
- `packages/server-core/src/handlers/rpc/skills.ts`
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/hooks/useCreatorSkillSafetyMonitor.ts`
- `apps/electron/src/renderer/lib/creator-skill-safety-scheduler.ts`
- `apps/electron/src/renderer/lib/creator-skill-version.ts`
- `apps/electron/src/renderer/pages/SkillInfoPage.tsx`
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- `apps/electron/src/renderer/components/app-shell/SkillsListPanel.tsx`
- `packages/shared/src/i18n/locales/*.json`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`
- `packages/shared/src/creator-skills/__tests__/archive.test.ts`
- `packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
- `apps/electron/src/renderer/lib/__tests__/creator-skill-safety-scheduler.test.ts`
- `apps/electron/src/renderer/lib/__tests__/creator-skill-version.test.ts`

## 自测结果

- `bun test`：4793 pass，19 skip，0 fail（4812 tests / 364 files）。
- Creator Skill 定向单测：26 pass，0 fail；覆盖 UUID/路径穿越、恶意 journal、事务故障恢复、中央目录 Entry 上限、安全回滚与 24 小时调度。
- `bun test ./packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`：2 pass，0 fail；覆盖 workspace context 绑定和只读拒绝。
- `bun test ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`：2 pass，0 fail；覆盖聚合 Catalog、类型徽标和本地化默认 changelog。
- 既有组织交互隔离测试分别执行：`OrganizationFlows.interaction.isolated.ts` 7 pass；`OrganizationAccess.interaction.isolated.ts` 6 pass。
- TypeScript：shared、server-core、electron 三个工程均通过 `tsc --noEmit`。
- i18n：locale 排序、parity（6 个翻译 locale，各 1674 keys）和 coverage 均通过。
- ESLint：本次 shared/electron 变更文件无 error；AppShell 仍仅报告仓库既有的 8 条 hook warning。
- `git diff --check`：通过。

## 遗留问题

- 本轮 8 个 Reviewer 阻塞项均已修复，无已知功能遗留。
- 仓库声明了 `typecheck:staged` 与 `lint:i18n:strings`，但对应的 `scripts/typecheck-staged.sh`、`scripts/lint-i18n-strings.sh` 在当前 worktree 不存在；本轮已用三个工程的完整 TypeScript 检查及现有 i18n sorted/parity/coverage 检查替代。
