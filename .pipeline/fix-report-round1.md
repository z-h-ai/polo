# POO-14 第 1 轮 Reviewer 修复报告

## 变更摘要

本轮针对 Reviewer 的两项 Linux blocking issue 完成了所有权状态绑定与安装/卸载事务加固：

- Linux schema 4 state 现在通过 `state_identity` 绑定 owner、schema、format、版本、`path_entry_owned`、profile path、profile block hash，以及 `polo`/`polo-ai` 的路径、目标、内容 hash 和 link identity。
- direct install 在进入 launcher/state 提交前以及事务临界区内都会验证受管 profile：必须是支持路径下的非 symlink 普通文件，并且只包含一个完整、精确的 Polo PATH block。
- 卸载由 Linux helper 在同一事务内完成 launcher、state 和受管 profile 的再次校验及删除；state/profile/launcher 任一身份变化都会保留 terminal integration 和 App。
- 安装 rollback 不再忽略恢复失败。并发用户文件占用 canonical path 时，旧候选和 `ROLLBACK_REQUIRED` journal 会保存在权限受控的 `.terminal-install.*` quarantine 中，并将恢复路径写入错误输出。
- schema 3 和旧的 14 行 schema 4 state 只允许经 repair/upgrade 精确迁移；在迁移成带完整 identity 的 schema 4 前不能授权卸载 profile。

代码提交：

- `40f4c7b POO-14: 绑定 Linux 终端事务所有权`

## Issue 1：schema 4 未完整绑定 profile ownership

处理结果：

1. 新 state 增加 `profile_block_sha256` 与 `state_identity`。
2. `state_identity` 覆盖完整 ownership tuple，不再允许只替换 `profile_path_b64` 或切换 `path_entry_owned` 后继续通过 `profile-path`/uninstall。
3. `path_entry_owned=true` 时，install 必须同时满足：
   - profile path 是 `.profile`、`.bash_profile`、`.bash_login`、`.zprofile` 或 fish conf 的受支持路径；
   - profile 是非 symlink 普通文件；
   - 起止 marker 各且仅有一个；
   - block 中恰好只有对应 shell 的一行精确 PATH 配置。
4. direct install 的 profile 缺失、malformed、重复 block 或 symlink 均在创建 launcher/state 前失败。
5. uninstall 在移动任何受管项前读取并绑定完整 state/profile 快照；移动 launcher/state 后再次验证 profile 完整内容，再原子替换 profile。冲突时恢复所有可恢复候选，不删除 App。
6. 非 state 绑定的其他 supported profile 即使包含格式正确的 Polo block，也不会被读取或删除。
7. 旧 schema state 可用于严格 ownership repair，但不能直接授权 profile 清理；repair 成功后写入新的完整 schema 4 identity。

对应回归覆盖：

- direct install + missing profile；
- malformed profile；
- 篡改 `profile_path_b64`；
- 篡改 `path_entry_owned`；
- 未绑定的 `.bash_profile`；
- 旧 schema 4 repair/migration；
- 真实 `uninstall-app.sh` 面对被篡改 state 时保留 profile、launcher、state 和 App。

## Issue 2：并发占用导致旧 managed launcher 丢失

处理结果：

1. 每个新 symlink 提交后记录 filesystem identity，rollback 只删除本事务创建且 identity/target 均匹配的 symlink，不会删除并发用户文件。
2. polo、compat、state 三个提交点均通过同一 rollback 路径恢复。
3. rollback 会逐个尝试恢复 state、compat、polo；恢复失败不再被当作可删除事务目录的成功。
4. 只有旧候选全部恢复，或新事务全部提交并通过最终验证，才删除 `.terminal-install.*`。
5. canonical path 被并发文件占用时：
   - 保留并发文件；
   - 恢复其他仍可恢复的 launcher/state；
   - 在 quarantine 中保留无法恢复的旧候选；
   - 写入 mode `0600` 的 `ROLLBACK_REQUIRED`；
   - stderr 返回明确 quarantine 路径，供修复操作使用。
6. installer 的真实升级回归确认 helper 失败时旧 AppImage、`current`、profile 和 state 均回滚；旧 launcher candidate 不会被删除。

对应确定性回归覆盖：

- `polo` symlink 创建点发生并发占用；
- `polo-ai` symlink 创建点发生并发占用；
- state hard-link/no-clobber 提交点发生并发占用；
- helper failure 但无并发占用时完整自动恢复且不遗留 quarantine；
- 真实 installer upgrade 中的 launcher race 与 App/profile rollback。

## 关键文件

- `apps/electron/resources/scripts/linux-terminal-integration.sh`
- `scripts/uninstall-app.sh`
- `scripts/linux-terminal-integration.test.ts`
- `scripts/install-app-shell.test.ts`
- `apps/electron/resources/release-notes/next.md`

## 自测命令与真实结果

针对性回归：

```bash
bash -n apps/electron/resources/scripts/linux-terminal-integration.sh \
  scripts/install-app.sh scripts/uninstall-app.sh
bun test scripts/linux-terminal-integration.test.ts \
  scripts/install-app-shell.test.ts scripts/uninstall-app.test.ts
```

结果：

- shell syntax：通过。
- Linux ownership/installer/uninstaller：`21 pass / 0 fail / 191 expect`。

全量门禁：

```bash
bun run test
bun run typecheck:all
bun run lint:shared
bun run lint:electron
bun run lint:i18n:parity
bun run lint:i18n:sorted
bun run lint:i18n:coverage
bun run test:doc-tools
bun run electron:build
bun run electron:validate:cli:runtime
git diff --check
```

结果：

- `bun run test`：退出码 0；主套件 `4906 pass / 19 skip / 0 fail / 12119 expect`，其后的 server、CLI、UI、Electron isolated suites 全部通过。
- `bun run typecheck:all`：通过。
- `bun run lint:shared`：退出码 0，`0 errors / 9 warnings`。
- `bun run lint:electron`：退出码 0，`0 errors / 114 warnings`。
- i18n parity：通过，6 locales、每个 1642 keys；sorted 与 coverage 均通过。
- doc-tools：23 tests passed。
- Electron build：通过；main/preload/renderer 与 CLI/server artifact 均成功生成，artifact 版本 `0.10.0`。
- packaged runtime validation：通过；覆盖 packaged server discovery、自相对 symlink launcher、包含空格和非 ASCII 字符的路径。
- `git diff --check`：通过。

## 回滚、竞态与残留检查

- 确定性 fake `ln` 在 polo、compat、state 三个提交点注入并发文件时，测试均确认旧 candidate 保留在 quarantine，journal 存在且 stderr 包含可操作路径。
- helper failure 且 canonical path 未被并发占用时，测试确认 polo、compat、state 全部恢复，quarantine 自动删除。
- 真实 installer race 回归确认旧 AppImage、`current` package、profile、ownership state 均恢复；测试随后显式按 journal 恢复旧 launcher 并完成正常卸载。
- 正常首次安装、repair/upgrade、legacy migration 与卸载回归均通过。
- 测试结束后：
  - 未发现本 worktree 相关 Electron、Polo server、mock provider 或 CLI 子进程；
  - 未发现 Polo/Bun/Electron 相关监听端口；
  - 未发现 `.terminal-install.*`、`polo-artifact-e2e-*`、`polo-terminal-*` 临时目录；
  - 未发现 `~/.polo-ai/runtime/electron.json`。

## 仍需外部 release evidence

- 本轮在 macOS arm64 宿主完成源码全量测试、Electron build 与 packaged runtime validation；未声称执行 Linux 真实桌面发行环境的 AppImage/full lifecycle，也未声称执行 Windows NSIS/PowerShell native full。
- 本轮修改限定于 Linux terminal ownership transaction，没有重新生成 DMG/ZIP；既有 development artifact 不作为 production evidence。
- production release 仍需正式三平台 runner、可信且版本不同的 previous release assets，以及生产签名/公证 secrets，产出 release/full 的 verified contract、artifact hashes、安装/升级/discovery/run/sessions/uninstall 日志。仓库现有 fail-fast contract 保持不变；本报告不伪造这些外部证据。
