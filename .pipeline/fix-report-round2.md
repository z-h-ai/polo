# POO-14 第 2 轮 Reviewer 修复报告

## 变更摘要

本轮完成两处 Linux shell profile 提交竞态修复：

- uninstall 不再在最终 hash 校验后用 `mv -f` 覆盖 profile。受管 profile 现在先以原子 rename claim，再对 claim 的 filesystem identity 与完整 hash 做提交后校验，最后用 hard-link no-replace 发布清理后的 profile。
- install/upgrade 的 PATH 配置、backup 与失败回滚使用同一套 snapshot、identity、hash、claim 和 no-replace 原语。回滚只会替换本事务实际生成且身份完全匹配的 profile。
- 任一阶段发现 regular file、symlink、rename 或内容更新竞态时，用户版本保持原位；旧 profile snapshot、未恢复 candidate 和 mode `0600` journal 保存在 mode `0700` quarantine 中，并返回可操作路径。
- 外层 installer/uninstaller 会收到非零结果，恢复 App/launcher/state 中仍可安全恢复的部分，并阻止删除 App。

代码提交：

- `d1753a0 POO-14: 封闭 Linux profile 提交竞态`

## Issue 1：uninstall profile 最终提交 TOCTOU

处理结果：

1. 卸载开始时记录绑定 profile 的完整 SHA-256 与 filesystem identity，并复制一份验证后的 `profile.owned` snapshot。
2. launcher 与 state 被隔离后，helper 再次验证 profile 内容、identity、state 和 launcher snapshot。
3. profile 提交采用两阶段 CAS：
   - 原子 rename 当前 profile 到 `profile.claimed`；
   - 对 claimed inode 再校验 regular-file、非 symlink、filesystem identity 和完整 hash；
   - 从验证 snapshot 生成移除 Polo block 的新文件；
   - 使用 hard link no-replace 发布到原路径，不执行覆盖式 rename。
4. claim 或 publication 期间出现并发 regular file/symlink 时，no-replace 失败且不会覆盖用户文件。
5. claim 后发现 rename/replacement/in-place content update 时，并发版本按 no-replace 恢复到原路径；旧 profile snapshot 留在 quarantine。
6. profile 冲突时 helper 恢复仍可恢复的 `polo`、`polo-ai` 和 ownership state，写入 `ROLLBACK_REQUIRED`，返回 exit 2。真实 `uninstall-app.sh` 因此保留 App。

确定性回归覆盖：

- Reviewer 同类的最终 claim 窗口内容更新；
- regular-file replacement；
- symlink replacement；
- rename 后创建新文件；
- 同 inode 内容更新；
- 清理后 profile publication 时并发 regular file/symlink；
- 真实外层 uninstall 收到冲突后保留 AppImage、`current`、launcher 和 state。

## Issue 2：install/upgrade rollback 覆盖并发 profile

处理结果：

1. App/runtime 修改前创建 mode `0700` profile transaction directory。
2. backup 阶段记录原 profile 的 filesystem identity 与完整 hash；复制后同时验证 backup 与原路径 snapshot，关闭 backup-copy 窗口。
3. PATH 配置从 verified backup 生成候选文件：
   - 已有 profile 先原子 claim，再校验 claim identity/hash；
   - 原 profile 不存在时要求路径在提交时仍不存在；
   - 候选通过 hard-link no-replace 发布；
   - 记录本事务实际发布 profile 的 identity/hash；
   - 持久备份使用随机唯一名称和 no-replace hard link。
4. helper failure 后的 profile rollback 先原子 claim 当前 profile，再确认它与本事务发布的 identity/hash 完全一致；只有匹配时才以 no-replace 恢复旧 snapshot。
5. 即使 PATH 配置是 no-op，rollback 也会核对 profile 是否仍与 transaction snapshot 相同。Reviewer 复现中的 launcher conflict + `concurrent-profile-update` 因此被识别为并发用户更新，不再被旧备份覆盖。
6. profile 不匹配时：
   - 保留当前用户版本；
   - 恢复旧 AppImage 与 `current`；
   - 保留旧 profile snapshot 和 journal；
   - 输出 quarantine 路径并返回失败。

确定性回归覆盖：

- backup copy 临界区内容更新；
- configure claim 阶段 regular/symlink/rename/content update；
- configure publication 阶段 regular file/symlink；
- helper launcher failure 同时写 profile；
- rollback claim 阶段 regular/symlink/rename/content update；
- 正常首次安装、repair、upgrade、rollback 与卸载。

## 关键文件

- `apps/electron/resources/scripts/linux-terminal-integration.sh`
- `scripts/install-app.sh`
- `scripts/linux-terminal-integration.test.ts`
- `scripts/install-app-shell.test.ts`
- `apps/electron/resources/release-notes/next.md`

## 自测命令与真实结果

### 针对性回归

```bash
bash -n apps/electron/resources/scripts/linux-terminal-integration.sh \
  scripts/install-app.sh scripts/uninstall-app.sh

bun test scripts/linux-terminal-integration.test.ts \
  scripts/install-app-shell.test.ts \
  scripts/uninstall-app.test.ts
```

结果：

- shell syntax：通过。
- Linux terminal ownership、installer、uninstaller：`27 pass / 0 fail / 330 expect()`。

### 全量门禁

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

真实结果：

- `bun run test`：退出码 0。
  - 主套件：`4912 pass / 19 skip / 0 fail / 12258 expect()`，380 files。
  - server concurrency、file-lock races、CLI server spawner、Electron/UI isolated suites 全部通过。
- `bun run typecheck:all`：通过。
- `bun run lint:shared`：退出码 0，`0 errors / 9 warnings`；均为既有 unused eslint-disable warning。
- `bun run lint:electron`：退出码 0，`0 errors / 114 warnings`；均为既有 warning。
- i18n parity：通过，6 locales、每个 1642 keys；sorted 与 coverage 均通过。
- doc-tools：23 tests passed。
- Electron build：通过；CLI/server/main/preload/renderer/resources 均构建成功，sanitized CLI artifact 版本 `0.10.0`。
- packaged runtime validation：通过；packaged server discovery、自相对 symlink launcher、空格及非 ASCII 路径均通过。
- `git diff --check`：通过。

## 竞态、回滚与残留检查

- uninstall 对抗测试确认每类 profile 竞态都返回冲突，用户 regular file/symlink/rename/content update 保留，launcher/state 恢复，quarantine 与 journal 可定位。
- profile publication 的 regular file/symlink 占用测试确认 hard-link no-replace 不覆盖目标，旧 claimed profile 留在 quarantine。
- installer backup、configure、helper failure 和 rollback 四类临界区均有确定性注入测试。
- Reviewer 的完整 installer 复现路径已覆盖：upgrade 在第一个 launcher 提交点写入 `concurrent-profile-update` 并制造 launcher 冲突；结果为用户 profile 保留、旧 App/current/state 恢复、launcher/profile 两个 quarantine 均存在并带 journal。
- 正常首次安装、repair/upgrade、legacy ownership migration 和正常卸载继续通过。
- 测试与构建结束后：
  - 未发现本 worktree 相关 Electron、Polo server、mock provider 或 CLI 子进程；
  - 未发现 Polo/Bun/Electron 相关监听端口；
  - 未发现 `.terminal-install.*`、`.terminal-uninstall.*`、`.profile-transaction.*` 或相关 E2E 临时目录；
  - 未发现 `~/.polo-ai/runtime/electron.json`。

## 外部 release evidence 缺口

- 本轮在 macOS arm64 宿主完成源码全量测试、Electron build 和 packaged runtime validation；未声称执行 Linux 原生 AppImage/Xvfb full，也未声称执行 Windows NSIS/PowerShell native full。
- 本轮是 Linux shell profile transaction 修复，没有重建 macOS DMG/ZIP；既有 development artifact 早于本轮提交，不能作为本轮代码或 production acceptance 证据。
- production release 仍需正式三平台 runner、可信且版本不同的 previous release assets、Apple/Windows 生产签名与公证 secrets，产出可审计 verified contract、artifact hashes 和 install/upgrade/discovery/run/sessions/uninstall full logs。
- 仓库现有 release/full fail-fast、签名身份和 previous-release provenance 契约未被放宽；本报告不虚报外部 runner 或生产签名结果。
