# POO-14 实现报告

## 变更摘要

- 审视了当前分支相对 `dev` 合适基线的完整 POO-14 变更、既有实现报告、历轮 reviewer 结论与最新提交，没有改写或删除既有正确实现。
- 确认现有分支已经覆盖 CLI/server bundle、统一 `polo` wrapper、Electron runtime discovery、`polo run` 临时 headless server、三平台 terminal integration、最终容器验证与 release workflow。
- 修复最新 macOS terminal integration CAS 事务的异常路径：
  - profile 或 launcher 已被原子 claim 后，如果备份、临时文件写入或 publication hook 等本地步骤抛错，现在会以 no-replace 方式恢复原 leaf，不再把用户配置或受管 launcher 留在私有 `.polo-claim-*` 路径。
  - regular-file rollback 不再在目标被并发占用时删除唯一 claim candidate；并发用户 leaf 始终优先，原 candidate 保留用于恢复。
  - 卸载先完成所有 shell profile 的安全更新，再删除 launcher 与 ownership state；profile publication 失败时仍保留可重试的完整安装状态。
- 增加确定性故障注入测试，覆盖 install profile publication failure、launcher repair publication failure、uninstall profile publication failure，并验证原配置、launcher、state 与事务残留。
- 更新 pending release notes，记录 macOS 本地 publication failure 的安全恢复语义。

## 关键文件列表

- `apps/electron/src/main/terminal-integration.ts`
- `apps/electron/src/main/__tests__/terminal-integration.test.ts`
- `apps/electron/resources/release-notes/next.md`
- `.pipeline/implement-report.md`

## 自测结果

- macOS terminal integration 定向回归：
  - `bun test apps/electron/src/main/__tests__/terminal-integration.test.ts apps/electron/src/main/__tests__/terminal-onboarding.test.ts apps/electron/src/main/__tests__/terminal-integration-command.test.ts`
  - `44 pass / 0 fail / 173 expect()`。
- 全量测试：
  - `bun run test`
  - 主套件 `4928 pass / 19 skip / 0 fail / 12580 expect()`，380 files；后续 server concurrency、file-lock race、CLI server spawner、Electron/UI isolated suites 全部通过。
- 类型、lint 与文案门禁：
  - `bun run typecheck:all`：通过。
  - `bun run lint:electron`：退出 0，`0 errors / 114 warnings`；warnings 为仓库既有项。
  - `bun run lint:shared`：退出 0，`0 errors / 9 warnings`；warnings 为仓库既有项。
  - `bun run lint:i18n:parity`：通过，6 个非英文 locale 与英文各 `1644` keys。
  - `bun run lint:i18n:sorted`、`bun run lint:i18n:coverage`：通过。
  - `bun run test:doc-tools`：`23 tests` 全部通过。
- 构建与 packaged runtime：
  - `bun run electron:build`：通过；CLI/server `0.10.0`、Electron main/preload/renderer/resources 全部构建完成，packaged CLI artifact validation 通过。
  - `bun run electron:validate:cli:runtime`：通过；覆盖 packaged server discovery、自相对 launcher、空格及非 ASCII 路径。
  - `bun run scripts/generate-wrapper-messages.ts --check`：通过。
  - `bash -n scripts/install-app.sh apps/electron/resources/bin/polo apps/electron/resources/bin/polo-ai apps/electron/resources/scripts/linux-terminal-integration.sh`：通过。
- 当前代码重建 macOS arm64 最终容器：
  - `bun run electron:dist:dev:mac`：通过；构建 ad-hoc signed、未公证的 development DMG/ZIP，builder 的 afterPack/afterAllArtifactBuild 门禁通过。
  - `bun run electron:validate:artifacts:unix -- --mode smoke --release-dir apps/electron/release --arch arm64`：DMG 与 ZIP final-container CLI smoke 均通过，版本 `0.10.0`。
  - DMG：`apps/electron/release/Polo-AI-arm64.dmg`，SHA-256 `c7a389f0e9ab2ba44ee845ef17168998c283f6372f1fd348d8015baa3e31fdad`。
  - ZIP：`apps/electron/release/Polo-AI-arm64.zip`，SHA-256 `07f3042ed0765d0815e21ae119defec22822cb481cb3fe081b52a6346d3dcc79`。
- `git diff --check`：通过。

## 遗留问题

- 当前宿主为 macOS arm64，本轮无法原生执行 Linux AppImage 与 Windows NSIS 的真实安装、previous-to-current 升级、PATH、App/CLI discovery、run、sessions 和卸载全生命周期；仓库中的对应 fixture、静态契约和 full workflow 门禁已通过本地测试，但不能替代相应原生 runner 证据。
- 本轮 macOS 最终容器为 development/ad-hoc 构建，没有生产 Apple 签名身份、notarization 与 stapling；不能作为 production release acceptance。
- 没有可用的可信固定 previous release 三平台产物，因此未执行真实 previous-to-current full lifecycle，也没有把 current artifact 冒充升级证据。
- 未执行 push。
