# POO-16 Reviewer Round 2 修复报告

## 处理结果

Round 2 的唯一 major finding 已修复。`POLO_AI_CLI_ARTIFACT_OUTPUT_DIR` 现在是严格的 direct-test artifact builder seam：只有直接执行 `scripts/build-cli-artifacts.ts --allow-test-output-override` 时才允许重定向。任何继承该变量的 production `electron:build` 或 `electron:dist` 都会在 artifact writer 执行前 fail closed，不会继续验证或打包 `apps/electron/dist` 中的 stale payload。

Round 1 的 manifest determinism 保持不变：manifest 仍不包含 wall-clock 字段，连续相同输入构建的 bytes 完全一致。launcher、payload hash validation、CLI isolation、bundled runtime 和 safe child-environment 实现均未修改。

## 关键文件

- `scripts/build-cli-artifacts.ts`
  - 检测 `POLO_AI_CLI_ARTIFACT_OUTPUT_DIR`。
  - 未同时提供 direct-builder 专用 `--allow-test-output-override` 时抛出明确错误，并在清理或写入任一 artifact 前退出。
  - 默认 production 输出仍固定为 `apps/electron/dist`。
- `scripts/build-cli-artifacts.test.ts`
  - reproducibility build 显式使用 test-only flag，并继续比较两次 manifest 原始 bytes。
  - 分别真实执行 contaminated `bun run electron:build` 与 `bun run electron:dist`，断言二者非零退出、redirected output 未生成、已有 default manifest bytes 未改变。

## 实际验证

- `TMPDIR=/Volumes/POO16Round2Fix/tmp NO_COLOR=1 bun test scripts/build-cli-artifacts.test.ts apps/cli/src/server-spawner.packaged.test.ts apps/electron/scripts/packaged-cli-layout.test.ts apps/electron/src/main/local-app-runtime/__tests__/runtime-paths.test.ts packages/session-tools-core/src/runtime/resolve-script-runtime.test.ts`
  - 24 pass，0 fail。
  - 覆盖 production build/dist override fail-closed、连续构建 determinism、三平台 layout、双 launcher、payload 缺失失败、packaged Bun/server resolution。
- `TMPDIR=/Volumes/POO16Round2Fix/tmp NO_COLOR=1 bun run electron:build`
  - 通过；默认路径生成 fresh CLI/server payload，Electron main/preload/renderer/resources 构建完成，最终输出 `Packaged CLI artifacts validated (0.10.0)`。
- `TMPDIR=/Volumes/POO16Round2Fix/tmp NO_COLOR=1 bun run typecheck:all`
  - 通过；全部类型检查退出码为 0。
- `TMPDIR=/Volumes/POO16Round2Fix/tmp NO_COLOR=1 bun run server:build:subprocess`
  - 通过；Session MCP 构建 390 modules / 4.58 MB，Pi Agent 构建 3999 modules / 20.41 MB。
- `TMPDIR=/Volumes/POO16Round2Fix/tmp NO_COLOR=1 bun run test`
  - 最终重跑通过；普通测试 4877 pass、19 skip、0 fail，后续全部 `*.isolated.ts` 测试均通过。
- `git diff --check`
  - 通过。

## 临时目录与未验证项

- 默认 Data volume 仅余约 717 MiB，因此本轮创建并使用挂载于 `/Volumes/POO16Round2Fix` 的 12 GiB APFS sparse image 作为 TMPDIR；测试 artifact 位于 repo 外，不会扩张 full-test discover glob。验证结束后已卸载该卷并将 sparse image 移入废纸篓（可恢复）。
- 本轮未修改 POO-14 UI、terminal/PATH、install/uninstall 或 upgrade 功能，也未重新执行或声称 DMG、NSIS、AppImage 安装验证。
- 未触碰或提交用户已有 `.task/session-analysis/`，也未恢复其他既有 deleted pipeline reports。
