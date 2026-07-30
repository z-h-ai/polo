# POO-21 Reviewer 第 5 轮修复报告

## 处理结果

### 1. 更新提交后的晚到本地写入

- 安装/更新只要替换了现有 Skill 目录，就不再自动删除承载旧 inode 的 transaction backup。
- 旧目录在 Ledger 提交后移入 `skill-backups/<slug>/<timestamp>/`，作为用户可管理的永久备份；因此编辑器通过 rename 前已打开的文件句柄写入时，内容在 `old_backed_up`、`new_installed`、`ledger_committed`、`committed` 和 cleanup 后各窗口都不会丢失。
- 回滚继续从 operation backup 或已迁移的永久 backup 恢复旧目录与旧 Ledger。
- 新增打开文件句柄的故障注入测试，覆盖上述所有 journal/cleanup 窗口。

### 2. 安全卸载后的晚到本地写入

- 非强制卸载采用保守的 detach 语义：移除 Creator Installation Ledger 记录，但把同一目录 inode 恢复为普通 workspace Skill，不自动删除可能仍被打开文件句柄修改的目录。
- 新增持久化 `detaching` journal 状态；启动恢复能区分“目录已恢复、committed 尚未落盘”的窗口，并恢复旧 Ledger 而不删除目录。
- 只有用户明确选择 `forceDeleteModified: true` 时才执行永久目录删除。
- 新增扫描后、rename 后、Ledger 提交后、committed 后和 operation cleanup 后的并发写入测试，以及 `detaching` 崩溃恢复测试。

### 3. Archived 版本的在途安装

- 提交前复查在 capability 开启时允许精确版本状态为 `active` 或 `archived` 的已签发在途安装继续提交。
- `revoked` 仍返回 `artifact_version_revoked`；功能关闭、查询失败或 capability 缺失仍中止提交。
- 未知 Safety Status 保持 fail-closed。
- 新增 active/archived 允许，以及 revoked/feature-disabled 拒绝的边界测试。

### 4. Reference 预览请求竞态

- Reference 请求加入单调 generation，并绑定 `organizationId + artifactId + version + path`。
- 响应写入状态前同时核对当前组织、选中作品、详情作品、版本和响应身份。
- 切换组织、作品或版本时立即使旧请求失效并清空旧 preview/loading；旧请求的成功、失败和 finally 均不能污染新选择。
- 新增版本 A 请求晚于版本 B 返回的逆序测试。

### 5. 校验问题与根路径国际化

- 用户界面不再渲染服务端 `SkillValidationIssue.message`。
- 所有稳定 issue code 统一映射到 `creatorSkills.validation.issue.*`，未知 code 只显示本地化通用错误。
- 根路径 fallback 从硬编码 `ZIP` 改为 `creatorSkills.validation.archiveRoot`。
- en、zh-Hans、de、es、hu、ja、pl 全部补齐翻译，并新增西班牙语渲染与 translator 单元测试，断言后端英文诊断不可见。

### 6. Pending Release Notes

- 按 `apps/electron/resources/AGENTS.md` 约定，在 `release-notes/next.md` 的 Features 下追加 POO-21 Creator Skills 功能说明。
- 发布说明引用最终实现提交 `2e0aba1`。

## 关键文件

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`
- `packages/server-core/src/handlers/rpc/skills.ts`
- `packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
- `apps/electron/src/renderer/lib/creator-skill-validation-issues.ts`
- `apps/electron/src/renderer/lib/__tests__/creator-skill-validation-issues.test.ts`
- `packages/shared/src/i18n/locales/{en,zh-Hans,de,es,hu,ja,pl}.json`
- `apps/electron/resources/release-notes/next.md`

## 自测结果

- `bun run test`
  - 通过；主测试集 `4826 pass / 19 skip / 0 fail`，随后执行的全部 `*.isolated.ts` 测试均通过。
  - Creator Skill installer 回归：`25 pass / 0 fail`。
  - Creator Artifact 交互回归：`11 pass / 0 fail`。
  - server-core workspace/commit boundary 回归：`6 pass / 0 fail`。
- `bun run typecheck:all`
  - 通过，core/shared/server-core/server/session-tools/pi-agent/electron/ui 全部无类型错误。
- `bun run lint:i18n:sorted`
  - 通过。
- `bun run lint:i18n:parity`
  - 通过，6 个非英语 locale 均与英文保持 `1760` 个 key。
- `bun run lint:i18n:coverage`
  - 通过。
- `bun run lint:electron`
  - 通过，`0 errors / 111 warnings`；warning 为仓库既有规则告警。
- `bun run electron:build`
  - 通过，main、preload、renderer、resources 和 assets 均构建成功；仅有既有 Vite outDir/chunk size warning。
- `git diff --check`
  - 通过。

## 提交

- 最终实现提交：`2e0aba1053bb952edbba085393e16dd532ca24bb` (`POO-21: 修复第五轮并发与安全问题`)
- 发布说明与本报告使用独立任务前缀提交，避免发布说明引用自身尚未生成的 commit hash。

## 遗留问题

- 无 Reviewer 第 5 轮遗留阻塞项。
- 非强制卸载现在始终保留目录并 detach Ledger；这是在无法跨平台证明不存在旧 inode 打开句柄时，保证不静默丢失晚到写入的保守策略。用户仍可通过明确的强制删除二次确认永久删除目录。
