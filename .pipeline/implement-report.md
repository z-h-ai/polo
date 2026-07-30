# POO-14 实现报告

## 变更摘要

- 将 CLI 与 headless server 构建为随 Electron 发布的稳定单文件 artifact，并生成带版本、路径和 SHA-256 的 artifact manifest。
- 将 CLI/server artifact、平台内置 Bun、统一 `polo` launcher 和兼容期 `polo-ai` shim 纳入 Electron 构建及打包校验；构建会检查文件、版本、checksum、runtime 架构以及 unpacked launcher 的真实可执行性。
- 统一 macOS、Windows、Linux 的命令语义：`polo app` 启动桌面端，其他子命令进入 CLI；安装、升级和卸载只管理 Polo 自己创建的 launcher、PATH 项和 shell 配置块。
- 完成 macOS 首次启动引导和「设置 → Polo 终端功能」的安装、修复、卸载入口；支持 zsh、bash、fish，包含冲突保护、配置备份、原子替换、幂等检测和本地化结构化错误。
- Electron 启动后写入权限受控的 runtime discovery 文件；CLI 会校验 loopback URL、PID/进程归属、启动时间、RPC health 和 major version，并安全处理 stale/replaced discovery 竞态。
- `polo run` 在 App 未运行时从安装包启动临时 headless server，使用独立随机端口、token、runtime discovery 和锁；信号退出、启动失败和并发运行均执行确定性清理。
- 共享配置、凭据和 runtime 文件更新使用跨进程事务锁及原子写入，避免 Electron 与并发临时 server 丢失更新。
- 更新 README、release note、三平台安装脚本及覆盖构建、运行时发现、终端设置、并发与清理边界的测试。

## 关键文件列表

### CLI、headless server 与运行时发现

- `apps/cli/src/index.ts`
- `apps/cli/src/client.ts`
- `apps/cli/src/server-spawner.ts`
- `apps/cli/src/run.test.ts`
- `packages/server-core/src/bootstrap/headless-start.ts`
- `packages/shared/src/runtime-discovery.ts`
- `packages/shared/src/utils/files.ts`

### Electron 打包与 launcher

- `scripts/build-cli-artifacts.ts`
- `scripts/validate-cli-artifacts.ts`
- `scripts/validate-cli-runtime.ts`
- `apps/electron/electron-builder.yml`
- `apps/electron/scripts/beforePack.cjs`
- `apps/electron/scripts/afterPack.cjs`
- `apps/electron/resources/bin/polo`
- `apps/electron/resources/bin/polo.cmd`
- `apps/electron/build/installer.nsh`

### 终端功能安装与产品入口

- `apps/electron/src/main/terminal-integration.ts`
- `apps/electron/src/main/terminal-onboarding.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx`
- `apps/electron/src/renderer/lib/terminal-integration-status.ts`
- `apps/electron/src/shared/types.ts`
- `scripts/install-app.sh`
- `scripts/install-app.ps1`
- `scripts/uninstall-app.sh`

### 并发与回归覆盖

- `apps/cli/src/server-spawner.isolated.ts`
- `packages/server/src/__tests__/smoke-concurrency.isolated.ts`
- `packages/shared/src/__tests__/runtime-discovery.test.ts`
- `packages/shared/src/utils/__tests__/file-lock-races.isolated.ts`
- `apps/electron/src/main/__tests__/terminal-integration.test.ts`
- `apps/electron/src/main/__tests__/terminal-onboarding.test.ts`
- `apps/electron/src/renderer/pages/settings/__tests__/AppSettingsPage.terminal-integration.isolated.ts`

## 自测结果

1. `bun run test`
   - 最终结果：PASS。
   - 标准套件：4823 passed，19 skipped，0 failed；11474 次断言，366 个测试文件。
   - 隔离测试链同时通过，包括双 headless server 并发、跨进程文件锁竞态、终端设置页异常恢复等覆盖。
   - 第一次全量运行曾遇到未修改的 `sessions-watchers.test.ts` 文件监听时序用例单次失败；该用例随后连续独立运行 3 次全部通过，第二次完整 `bun run test` 也通过，判定为既有时序抖动而非本任务回归。

2. `bun run typecheck:all`
   - 结果：PASS，core、shared、server-core、server、session-tools-core、pi-agent-server、Electron 和 UI 全部通过。

3. `bun run electron:build`
   - 结果：PASS。
   - 成功生成 CLI 0.10.0 与 packaged server 0.10.0，完成 Electron main/preload/renderer/resources/assets 构建，并通过 packaged CLI artifact validation。

4. `bun run electron:validate:cli:runtime`
   - 结果：PASS。
   - 验证了安装后 symlink 自相对 launcher、包含空格与非 ASCII 字符的安装/工作目录、packaged server 启动，以及 CLI 自动发现并连接 packaged server。

5. `bun run lint:i18n:parity`
   - 结果：PASS，6 个非英文 locale 与英文基准均为 1633 keys。

6. `bun run lint:i18n:sorted`
   - 结果：PASS。

7. `bun run lint:i18n:coverage`
   - 结果：PASS，所有 literal translation key 均可在英文 locale 中解析。

8. `git diff --check`
   - 结果：PASS，无格式错误。

## 遗留问题

- 当前开发机为 macOS，本轮未生成并安装真实的 Windows NSIS、Linux AppImage 和签名/公证 macOS DMG；Windows/Linux 平台已覆盖静态打包契约、PowerShell/脚本测试和平台无关单元测试，但最终三平台全新用户环境验收仍需在对应发布 CI 或真机完成。
- 真实 `polo run "hello"` 需要可用的模型凭据，会产生外部模型调用；本轮以 packaged server 启动、RPC discovery、CLI 连接、并发 server 和清理测试覆盖其本地生命周期，未发起计费模型请求。
- 无已知未完成的 POO-14 代码项。
