# POO-21 实现报告

## 变更摘要

- 完成 Creator Skill Round 3 数据安全与包边界裁决：更新回滚、干净卸载及启动恢复遇到并发重建的同名目录时，不再递归删除第三方目录，而是原子迁移为可管理的 `concurrent_recreation` 安全快照；空目录、非空目录和幂等恢复均有覆盖。
- 已修改 Skill 的强制删除采用短期、一次性、持久化凭证，绑定 workspace、slug、artifactId、archiveChecksum、目录 identity 与内容 fingerprint。目录替换、内容变化、凭证过期、重复使用或缺少受管安装来源时均拒绝删除普通 Skill。
- 强制删除事务把确认 identity/fingerprint 持久化到 journal，并在各提交 checkpoint、不可逆删除前及 committed 启动恢复时重新扫描；检测到晚到写入会恢复目录与 Ledger，返回 `creator_skill_force_delete_stale`，要求重新确认。
- 收紧 RPC 信息边界：Node `SystemError` 原始 message/path/dest、workspace 和事务绝对路径仅进入 server-core 日志；renderer 只收到稳定错误码、安全文案和通过归档校验的包内相对路径。
- 清理打包噪音后，全归档按 Unicode NFC 与大小写规范化统计 `SKILL.md` basename，要求恰好一个且只能位于 `<slug>/SKILL.md`；拒绝 `references/SKILL.md`、大小写变体及其他等价重复项。
- 普通本地 Skill 保留历史 slug 基线 `/^[a-z0-9-]+$/` 和既有错误语义；Creator Artifact、归档与安装层独立叠加严格 kebab-case。
- 共享 DTO、schema、校验实现和 POL-59 fixtures 已通过 `@polo-ai/shared/creator-skills` 声明导出；真实 package-export smoke test 不依赖 tsconfig wildcard。

## 关键文件列表

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/archive.ts`
- `packages/shared/src/creator-skills/skill-content.ts`
- `packages/shared/src/creator-skills/schemas.ts`
- `packages/shared/src/creator-skills/types.ts`
- `packages/shared/src/creator-skills/fixtures.ts`
- `packages/shared/src/creator-skills/index.ts`
- `packages/shared/package.json`
- `packages/server-core/src/handlers/rpc/skills.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `apps/electron/src/renderer/lib/creator-skill-delete.ts`
- `apps/electron/src/renderer/lib/creator-skill-errors.ts`
- `apps/electron/src/shared/types.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`
- `packages/shared/src/creator-skills/__tests__/archive.test.ts`
- `packages/shared/src/creator-skills/__tests__/skill-content.test.ts`
- `packages/shared/src/creator-skills/__tests__/package-exports.test.ts`
- `packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,zh-Hans}.json`

## 自测结果

- `bun run test`：通过。主测试集 4864 pass、19 skip、0 fail（4883 tests / 373 files），随后全部 `*.isolated.ts` 测试通过。
- Creator Skill、RPC 边界和 renderer 定向测试：76 pass、0 fail；另随全量测试通过 server-core workspace/session 边界 9 项、详情页交互 3 项。
- `bun run typecheck:all`：通过，core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部无类型错误。
- `cd packages/shared && bun x eslint src/creator-skills`：通过。
- `bun run lint:electron`：通过，0 error；111 个仓库既有 warning。
- `bun run lint:i18n:sorted`、`bun run lint:i18n:parity`、`bun run lint:i18n:coverage`：通过；6 个非英语 locale 各 1766 keys。
- `git diff --check`：通过。
- `bun run lint:shared`：未通过；仍被本任务范围外既有的 5 个 `craft-shared/no-inline-source-auth-check` 错误阻断，位于 resource/source token refresh 文件。本任务 Creator Skill 目录的定向 ESLint 已通过。

## 遗留问题

- Round 3 确定语义及强删晚到写入补强无已知功能遗留。
- 仓库级 `lint:shared` 的 5 个既有错误不属于 POO-21；完整测试中 `CreatorArtifactsPanel` 仍输出一个既有、非阻断的 React `act(...)` warning。
