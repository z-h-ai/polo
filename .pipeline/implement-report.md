# POO-14 实现报告

## 变更摘要

- 将 CLI 与 headless server 构建为随 Electron 发布的单文件 artifact，并生成包含版本、路径和 SHA-256 的 manifest；Electron 构建在打包前后校验 artifact、内置 Bun、launcher 和版本一致性。
- 统一三平台 `polo` 命令语义：`polo app` 启动桌面端，其他子命令进入 CLI；兼容期保留 `polo-ai` shim。
- 完成 macOS 首次设置和设置页中的安装、修复、卸载入口；launcher 自相对解析安装包资源，shell 配置具备冲突保护、备份、原子更新和幂等清理。
- Electron 写入权限受控的 runtime discovery；CLI 校验 loopback、PID/进程归属、RPC health 与版本，安全处理 stale discovery。
- `polo run` 在 App 未运行时启动安装包内临时 headless server，使用独立随机端口、token、runtime 和锁，并在信号或失败后清理。
- 修复显式 `--url`/`--token` 连接被本地 App major version 错误限制的问题；自动发现本地 App 时仍执行版本兼容校验。
- 修复 Linux/macOS Bash 登录 shell 已存在 `.bash_profile` 或 `.bash_login` 时写错 PATH 配置文件的问题，卸载同时覆盖三种 Bash 启动文件。
- 修复 Windows 从旧版 `polo-ai.cmd` GUI launcher 升级时无法接管 Polo 历史 PATH 项的问题；仅精确匹配旧版 Polo launcher 后转移所有权，避免误删用户自有 PATH。
- 补充远程连接、Bash 配置优先级、Windows 历史升级迁移及卸载行为的自动化测试与 release note。

## 关键文件列表

### CLI、server 与运行时发现

- `apps/cli/src/index.ts`
- `apps/cli/src/client.ts`
- `apps/cli/src/server-spawner.ts`
- `apps/cli/src/run.test.ts`
- `packages/server-core/src/bootstrap/headless-start.ts`
- `packages/shared/src/runtime-discovery.ts`

### Electron 打包与统一 launcher

- `scripts/build-cli-artifacts.ts`
- `scripts/validate-cli-artifacts.ts`
- `scripts/validate-cli-runtime.ts`
- `apps/electron/electron-builder.yml`
- `apps/electron/scripts/beforePack.cjs`
- `apps/electron/scripts/afterPack.cjs`
- `apps/electron/resources/bin/polo`
- `apps/electron/resources/bin/polo.cmd`

### 安装、升级与卸载

- `apps/electron/src/main/terminal-integration.ts`
- `apps/electron/src/main/terminal-onboarding.ts`
- `apps/electron/resources/scripts/windows-terminal-integration.ps1`
- `apps/electron/resources/scripts/tests/windows-terminal-integration.test.ps1`
- `apps/electron/scripts/windows-terminal-integration.test.ts`
- `scripts/install-app.sh`
- `scripts/install-app-shell.test.ts`
- `scripts/uninstall-app.sh`
- `scripts/uninstall-app.test.ts`

## 自测结果

1. 全量测试

   ```bash
   bun run test
   ```

   结果：PASS，退出码 0。标准套件为 4828 passed、19 skipped、0 failed，11491 次断言、367 个测试文件；后续 isolated tests 链路全部通过。

   一次更早的完整运行中，未修改的 `sessions-watchers.test.ts` 文件监听时序用例单次失败；该文件随后连续独立运行 3 次均通过，最终完整测试再次以退出码 0 通过。

2. 本轮专项测试

   ```bash
   bun test apps/cli/src/run.test.ts scripts/install-app-shell.test.ts scripts/uninstall-app.test.ts apps/electron/scripts/windows-terminal-integration.test.ts
   ```

   结果：PASS，32 passed、0 failed、90 次断言。

3. 全量类型检查

   ```bash
   bun run typecheck:all
   ```

   结果：PASS，退出码 0。

4. Electron 构建与 artifact 校验

   ```bash
   bun run electron:build
   bun run electron:validate:cli:runtime
   ```

   结果：全部 PASS。生成 CLI 0.10.0 与 packaged server 0.10.0；验证了安装后 symlink 自相对 launcher、包含空格和非 ASCII 字符的路径、packaged server 启动以及 CLI 自动发现连接。

5. macOS 实际安装包构建

   ```bash
   bun run electron:dist:dev:mac
   ```

   结果：PASS，生成 ad-hoc 签名的 arm64 DMG（216 MB）与 ZIP（208 MB）；`afterPack` 验证了安装包中的终端 artifact。直接从 unpacked App 执行 `polo --version` 返回 `0.10.0`，`polo --help` 成功。

   - DMG SHA-256：`fd8d034ead0e5d8cb7bbd2dc26c5f0fea4fea92d6370ce2eed3d51f875e73081`
   - ZIP SHA-256：`31a3a31e2587771c05fd3b8c5018d7902faef2de1090cdee88344178ab8e045d`

6. Shell 与 diff 检查

   ```bash
   bash -n scripts/install-app.sh scripts/uninstall-app.sh
   git diff --check
   ```

   结果：全部 PASS。

## 遗留问题

- 当前开发机为 macOS arm64，已完成实际 DMG/ZIP 构建，但 Windows NSIS、Linux AppImage 及对应全新用户环境的安装、升级、卸载验收仍需在发布 CI 或真机完成。
- 当前环境没有 Windows PowerShell，Windows 迁移逻辑完成了 TypeScript 静态契约测试，PowerShell 行为测试需在 Windows CI 执行。
- 真实 `polo run "hello"` 需要模型凭据并会发起外部计费调用；本轮以 packaged server 启动、RPC discovery、CLI 连接、并发和清理测试覆盖本地生命周期，未发起计费模型请求。
