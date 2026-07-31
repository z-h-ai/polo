# POO-21 Review Round 1 修复报告

## 修复方案与行为变化

- 将强制删除确认时的 `artifactId`、`archiveChecksum`、目录 identity 和内容 fingerprint 持久化到事务 journal 的 `forceDeleteConfirmation`，并在 journal 恢复入口校验字段结构。确认 Token 本身仍不会写入 journal。
- 保留 target 首次 `rename` 到 transaction backup 后的校验，并在真正执行不可逆递归删除前再次完整扫描 transaction backup，复核目录 identity 与 `contentDigest`。
- `old_backed_up`、`ledger_committed` 或 `committed` 后出现任何晚到写入时，在线卸载返回 `creator_skill_force_delete_stale`，回滚 transaction backup 到正式目录，保留一次性凭证记录，要求用户基于最新内容重新确认。
- committed journal 启动恢复不再直接清理 operation path。恢复会先扫描 transaction backup；若 fingerprint 已变化，则恢复目录并保留凭证，避免重启清理静默丢失晚到写入；未变化时才执行永久删除。
- committed 阶段的异常处理也会复核仍存在的强删 backup，避免模拟崩溃或清理异常绕过最终内容检查。

## 关键文件

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`

## 新增或更新的回归测试

- 新增 `rejects confirmed force deletion when writes arrive at every commit checkpoint`：
  - 分别在 `old_backed_up`、`ledger_committed`、`committed` journal checkpoint 注入 `late-write.txt`。
  - 验证 journal 已持久化确认 identity/fingerprint。
  - 验证卸载返回 `creator_skill_force_delete_stale`，正式目录和晚到写入均被恢复，operation 目录被安全清理。
- 新增 `restores a force-delete backup changed after a durable committed crash`：
  - 模拟 committed journal 已写入但目录 fsync 不可确认，保留恢复材料。
  - 在重启恢复前向 transaction backup 注入晚到写入。
  - 验证启动恢复不会删除 backup，而是恢复正式目录并允许用户重新取得强删凭证。

## 实际执行的自测及结果

- `bun test packages/shared/src/creator-skills/__tests__/installer.test.ts`：45 pass、0 fail。
- `bun test packages/shared/src/creator-skills`：71 pass、0 fail。
- `bun run typecheck:all`：通过。
- `bun x eslint src/creator-skills/installer.ts src/creator-skills/__tests__/installer.test.ts`（在 `packages/shared` 下）：通过，0 error。
- `bun run test`：通过；仓库主测试及全部 `*.isolated.ts` 测试均为 0 fail。
- `git diff --check`：通过。
- `bun run lint:shared`：未通过；仍被本任务范围外既有的 5 个 `craft-shared/no-inline-source-auth-check` 错误阻断，位于 resource/source token refresh 相关文件。本轮修改文件的定向 ESLint 已通过。

## 遗留问题

- 本轮 Reviewer 阻断问题无已知功能遗留。
- 完整测试仍会输出一个既有的 `CreatorArtifactsPanel` React `act(...)` 非阻断 warning；对应测试通过，本轮未修改该组件。
