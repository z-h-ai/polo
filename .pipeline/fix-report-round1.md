# POO-16 Reviewer Round 1 修复报告

## 处理结果

独立审查提出的唯一 finding 已修复：随包发布的 `artifact-manifest.json` 不再写入 wall-clock `generatedAt`。manifest 现在只由版本、固定 runtime 标识、artifact 相对路径及 payload SHA-256 构成；相同输入的连续构建生成完全相同的 manifest bytes。

为了让回归测试执行真实 artifact build 且不污染 worktree，`scripts/build-cli-artifacts.ts` 支持通过 `POLO_AI_CLI_ARTIFACT_OUTPUT_DIR` 将生成目录定向到系统临时目录。正式 Electron build 未设置该变量时仍写入原有 `apps/electron/dist`，既有 manifest 校验、payload hash、launcher、CLI isolation 和 safe child-environment 链路均未改变。

## 关键文件

- `scripts/build-cli-artifacts.ts`
  - 移除不稳定的当前时间字段。
  - 支持显式 artifact 输出目录，默认构建路径保持不变。
- `scripts/build-cli-artifacts.test.ts`
  - 在 TMPDIR 下连续执行两次真实 CLI/server artifact build。
  - 比较两次 `artifact-manifest.json` 原始 bytes，并断言不含 `generatedAt`。
  - 临时生成物位于 repo 外且在测试结束后清理，不会被全量 `*.isolated.ts` discover glob 扫描。

## 实际验证

- `TMPDIR=/Volumes/POO16FixTmp/tmp NO_COLOR=1 bun test scripts/build-cli-artifacts.test.ts apps/electron/scripts/packaged-cli-layout.test.ts`
  - 10 pass，0 fail。
  - 覆盖连续构建 manifest bytes 相同，以及既有三平台 assembled layout、双 launcher、payload 缺失失败和 manifest hash 校验。
- 连续两次 `bun run electron:build:cli` 后执行 `cmp`
  - 通过；两份 manifest SHA-256 均为 `c8db22c053331062731ede0a725eeb4f604c14819723086dcc445db4cad7938d`。
- `TMPDIR=/Volumes/POO16FixTmp/tmp NO_COLOR=1 bun run electron:build`
  - 通过；CLI/server、Electron main/preload/renderer/resources 均成功构建，最终 `Packaged CLI artifacts validated (0.10.0)`。
- `TMPDIR=/Volumes/POO16FixTmp/tmp NO_COLOR=1 bun run typecheck:all`
  - 通过；全部类型检查退出码为 0。
- `TMPDIR=/Volumes/POO16FixTmp/tmp NO_COLOR=1 bun run test`
  - 通过；普通测试 4876 pass、19 skip、0 fail，后续全部 `*.isolated.ts` 测试均通过。
- `git diff --check`
  - 通过。

## 临时目录与未验证项

- 默认 Data volume 验证前仅约 962 MiB 可用，因此创建并使用挂载于 `/Volumes/POO16FixTmp` 的 12 GiB APFS sparse image 作为 TMPDIR；没有把测试生成物写入 repo discover 范围。验证后已卸载该卷，并将 sparse image 移入废纸篓（可恢复）。
- 本轮仅修复 manifest 可复现性，没有修改或验证 POO-14 UI、terminal/PATH、升级功能，也没有重新声称 DMG、NSIS 或 AppImage 安装测试。
- 未触碰用户已有 `.task/session-analysis/`，也未恢复或提交既有被删除的 `.pipeline/fix-report-round2.md`。
