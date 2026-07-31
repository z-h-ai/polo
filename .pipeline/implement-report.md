# POO-21 实现报告

## 变更摘要

- 落实 Round 3 并发目录安全裁决：事务记录正式目录 identity；更新回滚、干净卸载和启动恢复遇到第三方重建的同名目录时，不再递归删除，而是原子迁移为可管理的 `concurrent_recreation` 安全快照。空目录、非空目录和重复恢复均覆盖。
- 为已修改 Skill 的强制删除增加短期、一次性、持久化凭证。凭证绑定 workspace、slug、artifactId、archiveChecksum、目录 identity 和内容 fingerprint；目录被替换、内容变化、凭证过期或重复使用都会拒绝。无 Ledger 且无有效凭证时不会删除普通 workspace Skill。
- 收紧 RPC 错误边界：原始 Node `SystemError`、绝对路径、stage/backup/operation 路径只进入 server-core 日志；renderer 仅得到稳定错误码、安全文案和已校验的包内相对路径。成功结果也不再回传绝对备份路径。
- 强化归档校验：清理噪音后，全包按 Unicode NFC 与大小写规范化统计 `SKILL.md` basename，要求全包恰好一个且只能位于 `<slug>/SKILL.md`；拒绝 references 内副本及大小写变体。
- 恢复普通本地 Skill 的历史 slug 规则与错误语义，新增 Creator 专用严格 kebab-case 校验，避免 Creator 发布策略影响普通 Skill 创建、校验、加载和删除。
- 统一内部消费者从 `@polo-ai/shared/creator-skills` 导出入口消费共享实现；新增可导出的 POL-59 交接 fixtures，以及不依赖 tsconfig wildcard 的真实 package export smoke test。
- 补齐 `concurrent_recreation` 备份来源、强删凭证失效等用户文案及 `de/es/hu/ja/pl/zh-Hans` 翻译，并更新 locale 静态门禁。

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

- `bun run test`：通过。主测试集 4862 pass、19 skip、0 fail（4881 tests / 373 files），随后全部 `*.isolated.ts` 测试通过。
- Creator Skill shared 与 renderer 定向测试：110 pass、0 fail；覆盖并发重建快照、强删凭证、原始系统错误隔离、归档边界、slug 策略和 package exports。
- `bun test ./packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`：9 pass、0 fail。
- `bun test ./apps/electron/src/renderer/pages/__tests__/SkillInfoPage.creator-skill.interaction.isolated.ts`：3 pass、0 fail。
- `bun run typecheck:all`：通过。
- `bun run lint:electron`、`bun run lint:shared`：通过。
- `bun run lint:i18n:sorted`、`bun run lint:i18n:parity`、`bun run lint:i18n:coverage`：通过；6 个非英语 locale 各 1766 keys。
- `git diff --check`：通过。

## 遗留问题

- 本轮 Round 3 确定语义无已知功能遗留。
- 完整测试中 `CreatorArtifactsPanel` 的一个既有异步用例仍输出非阻断 React `act(...)` warning，但测试通过，本轮未修改该组件。
