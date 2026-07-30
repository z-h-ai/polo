# POO-21 Reviewer Round 1 修复报告

## 逐项处理结果

### 1. stage 已提升但 `new_installed` 尚未落盘的恢复失败

已修复。

- `rollbackJournal()` 不再只根据 `new_installed` / `ledger_committed` 判断是否移除正式目录。
- 只要存在可恢复的 transaction/preserve backup，回滚会先安全移除当前 target，再恢复旧目录；`old_backed_up` 及更后状态即使没有旧 backup，也会移除可能已经提升完成的新 target。
- `prepared` 状态仍保留“无 backup 时不删除原 target”的保护；补充了“旧目录已 rename 到 backup、但 `old_backed_up` 尚未落盘”的恢复测试。
- 新增 stage→target rename 已完成、journal 仍为 `old_backed_up` 的崩溃快照测试，验证旧 Skill、旧 Ledger 和 operation journal 均恢复一致。

关键文件：

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`

### 2. workspace 名称/ID 碰撞导致错误根目录绑定

已修复。

- Creator Skill 授权边界先要求 requested workspace ID 与 RPC context 当前 workspace ID 完全相等。
- 随后只在 SessionManager workspace 列表中按不透明 ID 做大小写敏感的精确匹配，不再通过支持名称别名的 `getWorkspaceByNameOrId()` 解析授权目标。
- 重复 ID 会失败关闭；workspace 名称不参与授权判断。
- 新增名称等于另一 workspace ID、名称大小写碰撞、请求 ID 大小写变化及三种 workspace 数组顺序的回归测试。

关键文件：

- `packages/server-core/src/handlers/rpc/skills.ts`
- `packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`

### 3. workspace RPC 英文错误绕过 i18n

已修复。

- `workspaceMutationError()` 仅返回稳定 `errorCode`、stage、retryable 和安全 JSON diagnostic，不再返回英文 message。
- Creator Artifact 安装错误和 Skill 详情更新/删除错误统一按 `creatorSkills.errors.<errorCode>` 在 renderer 翻译；仅对没有已知翻译的旧错误保留兼容 fallback。
- `CreatorSkillOperationResult.message` 调整为可选，以准确表达无服务端用户文案的 RPC 契约。
- 新增 `workspace_context_mismatch`、`workspace_read_only` 的 7 个 locale 文案，并增加无服务端 message 时的 renderer 交互测试。

关键文件：

- `packages/server-core/src/handlers/rpc/skills.ts`
- `packages/shared/src/creator-skills/types.ts`
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/pages/SkillInfoPage.tsx`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
- `packages/shared/src/i18n/locales/*.json`

## 自测命令与结果

- `bun test packages/shared/src/creator-skills/__tests__/installer.test.ts`
  - 10 pass，0 fail；包含两个新增崩溃窗口恢复测试。
- `bun test ./packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`
  - 3 pass，0 fail；覆盖 context 绑定、名称/ID/大小写/顺序碰撞和只读拒绝。
- `bun test ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
  - 3 pass，0 fail；覆盖无服务端 message 时的本地化错误展示。
- `bun run test`
  - exit 0；标准 suite 4795 pass、19 skip、0 fail，随后仓库全部 `*.isolated.ts` 逐个执行通过。
- `bun run typecheck:all`
  - exit 0；core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过。
- `bun run electron:build`
  - exit 0；main、preload、renderer、resources、assets 构建与校验通过；仅有既有 Vite outDir/chunk-size warning。
- `bun run lint:i18n:sorted`
  - 通过。
- `bun run lint:i18n:parity`
  - 通过；6 个翻译 locale 各 1676 keys。
- `bun run lint:i18n:coverage`
  - 通过。
- 本次 Electron 与 shared 变更文件 ESLint
  - 0 error。
- `git diff --check`
  - 通过。

## 遗留问题

- Reviewer Round 1 列出的 3 个问题均已修复，无已知功能遗留。
- Electron production build 仍有仓库既有的 outDir 和大 chunk warning，本次变更未新增构建 warning。
