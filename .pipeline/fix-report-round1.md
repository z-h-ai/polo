# POO-14 第 1 轮 Blocking Review 修复报告

## Issue 1：macOS profile 更新可覆盖 symlink 或并发编辑

处理完成：

- 新增 profile leaf snapshot（类型、inode、内容、mode）并拒绝 symlink、目录和其他非普通文件；状态检查会以 `profile_conflict` 返回，不会改写该路径。
- profile 更新改为 claim → revalidate → backup → no-replace publish：先将已验证的原 profile 移至私有 claim path，重新比对 inode 和内容；新内容通过同目录临时文件 + `link(2)` 发布，目标出现 regular file 或 symlink 时只失败，不会覆盖或跟随。
- claim 后到发布前若用户创建新文件，保留用户文件；已经验证的旧 profile 保存为 `.polo-backup-*`。claim 前发生 rename/content/symlink 变化时，安全恢复竞争者的叶节点，不覆盖后续写入。
- uninstall 的 profile block 删除也复用同一事务路径，避免在卸载期间覆盖并发用户编辑。

## Issue 2：macOS launcher 检查后仍可被 rename 覆盖

处理完成：

- launcher ownership 判断现在绑定单次 leaf snapshot 和 ownership state；已验证 launcher 会先 claim 并重新核验，非 Polo regular file、symlink 或状态不匹配的 launcher 不会进入替换流程。
- 新 launcher 使用 `symlink(2)` 的 no-replace 创建。检查后出现的 regular file 或 symlink 使安装停在 `launcher_conflict`，用户命令保持不变。
- 更新既有 Polo launcher 发生竞争时，只会尝试无覆盖恢复旧候选；如果目标已由用户占用，则保留用户命令与可恢复候选，不执行覆盖。
- uninstall 同样先 claim 并复核已拥有 launcher，再删除私有 candidate；用户在检查后替换的命令不会被删除。

## 关键文件

- `apps/electron/src/main/terminal-integration.ts`
- `apps/electron/src/main/__tests__/terminal-integration.test.ts`
- `apps/electron/resources/release-notes/next.md`

## 自测命令与结果

- `bun test apps/electron/src/main/__tests__/terminal-integration.test.ts apps/electron/src/main/__tests__/terminal-onboarding.test.ts apps/electron/src/main/__tests__/terminal-integration-command.test.ts`
  - `41 pass, 0 fail, 161 expect()`。
- 新增确定性竞态覆盖：
  - user-owned shell profile symlink；
  - profile regular-file、symlink、rename、content races；
  - launcher 初次发布和既有 launcher 更新期间出现的 regular file/symlink；
  - uninstall 期间 launcher 被替换为用户 regular file/symlink。
- `bun run test`
  - 退出码 `0`；主测试集与 isolated suites 全部通过。
- `bun run typecheck:all`
  - 通过。
- `bun run lint:electron`
  - 通过，`0 errors`、114 条既有 warnings。
- `bun run electron:build`
  - 通过；CLI/server、main、preload、renderer、resources 和 artifact validation 完成。
- `bun run electron:build:main`
  - 在最终修改后通过。
- `git diff --check`
  - 通过。

## 遗留问题

- 本轮修复的是 macOS main-process terminal integration 的文件系统竞态；未在本机执行 Windows NSIS 或 Linux AppImage 的原生发布安装生命周期。
- 三平台最终安装包、签名/公证和跨版本升级仍须由正式 release runner 使用可信 previous artifact 作为 blocking gate 完成；本报告不将源码测试或本机 build 伪装为该外部证据。
