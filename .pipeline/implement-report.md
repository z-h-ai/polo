# POO-21 实现报告

## 变更摘要

- 落实 Round 6 安全快照语义：每次更新都把旧正式目录通过同文件系统 `rename` 保存为永久、用户管理的安全快照；已修改更新、干净更新和干净卸载分别记录为 `modified_update`、`update_safety_snapshot`、`clean_uninstall_snapshot`，并保存原版本、创建时间和大小。
- 普通卸载先按安装记录扫描目录。扫描时已经修改的 Skill 仅移除 Ledger、保留为普通 workspace Skill；干净 Skill 则从正式加载路径移入卸载安全快照。扫描后的晚到写入跟随旧 inode 进入快照，不会被静默删除。明确强制删除仍可永久移除已修改目录。
- 扩展事务 journal 和启动恢复：安全快照元数据可由已提交 journal 补写；提交前失败会恢复旧目录与旧 Ledger；备份列表、逐个删除和全部删除均继续执行路径、符号链接和边界校验。
- INSTALL RPC 改为只接受 `sessionId`，不再接受 renderer 提交的 `workingDirectory`。server-core 从绑定 workspace 的 SessionManager 会话派生项目目录，并拒绝错误 workspace、workspace 外的已存在/不存在路径以及非目录路径，错误响应不泄露绝对路径。
- Creator Skill 校验状态轮询改为响应完成后再调度下一次的单飞 `setTimeout`；切换组织、作品或卸载组件会使旧请求失效并清理定时器。返回仍有旧请求在途的作品时会创建新的有效请求。
- 撤销版本可对低于当前版本的 `safeVersion` 执行明确安全回滚；安装和回滚均携带当前 session，renderer 不再发送裸项目路径。
- 备份管理页展示快照真实来源、原版本、创建时间和大小。补齐 `de/es/hu/ja/pl` 全部新增 `creatorSkills.*` 与 `skillInfo.*` 文案的实际翻译，并增加非英语占位静态门禁。

## 关键文件列表

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/types.ts`
- `packages/shared/src/creator-skills/schemas.ts`
- `packages/server-core/src/handlers/rpc/skills.ts`
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/pages/SkillInfoPage.tsx`
- `apps/electron/src/renderer/pages/settings/WorkspaceSettingsPage.tsx`
- `apps/electron/src/renderer/context/AppShellContext.tsx`
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- `apps/electron/src/renderer/components/app-shell/MainContentPanel.tsx`
- `apps/electron/src/renderer/App.tsx`
- `packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,zh-Hans}.json`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`
- `packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
- `apps/electron/src/renderer/pages/__tests__/SkillInfoPage.creator-skill.interaction.isolated.ts`
- `packages/shared/src/i18n/__tests__/locale-parity.test.ts`

## 自测结果

- `bun run typecheck:all`：通过；core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部完成 TypeScript 检查。
- Creator Skill shared 定向测试：78 pass，0 fail；覆盖连续干净升级快照、干净卸载、扫描后晚到写入、已修改卸载、事务故障恢复、归档安全和 RPC schema。
- `bun test ./packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`：8 pass，0 fail；覆盖 session 派生目录、renderer 路径拒绝、workspace 外已存在/不存在路径、只读和 workspace 绑定。
- `bun test ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`：13 pass，0 fail；覆盖延迟响应下单飞轮询、组织/作品切换清理和返回作品时的陈旧请求替换。
- `bun test ./apps/electron/src/renderer/pages/__tests__/SkillInfoPage.creator-skill.interaction.isolated.ts`：3 pass，0 fail；覆盖撤销版本向较低安全版本回滚和 session-bound INSTALL。
- Creator Skill 安全状态/版本定向测试：8 pass，0 fail；覆盖 24 小时复查、in-flight 去重、timer 清理和低版本安全回滚。
- i18n parity/sorted/coverage：全部通过；6 个非英语 locale 各 1763 keys，并通过代表性非英语占位门禁。
- Electron ESLint：0 error（111 条仓库既有 warning）；本次 shared 变更文件定向 ESLint：0 error。
- `git diff --check`：通过。
- 仓库完整 `bun test` 首轮结果为 4828 pass、19 skip、1 fail；唯一失败是无关的 `session-watcher.test.ts` 时序用例，单文件立即复跑为 3 pass、0 fail。

## 遗留问题

- 本轮 Round 6 确定语义无已知功能遗留。
- 仓库级 `lint:shared` 仍被本次范围外 5 个既有 `craft-shared/no-inline-source-auth-check` 错误阻塞，位置在 resource/source token refresh 相关文件；本次修改的 shared 文件定向检查全部通过。
