# POO-14 第 3 轮实现报告

## 变更摘要

- 将 previous artifact 的 legacy 容器识别与 current artifact 的严格 POO-14 校验彻底分离。固定旧版本可从历史 App/package metadata 只读提取版本并进入真实安装、迁移和升级流程；当前版本仍强制 sanitized CLI metadata、artifact manifest、版本及 checksum。
- clean runner 会按目标 platform/arch 下载、校验 checksum 与二进制架构、staging 并在可原生执行时运行 `uv --version`；最终 DMG/ZIP、NSIS、AppImage validator 同样要求并验证打包后的 `uv`。
- macOS full 验收通过生产 `polo app` → `open <App bundle>` 路径执行 cold launch，再次调用并核对 discovery PID 不变与进程存活，以验证聚焦/单实例；已移除 CLI 中的 direct-app 测试绕过。
- mock provider 对最终输出组件执行 `lstat`，拒绝 symlink，并使用 `O_NOFOLLOW`、常规文件复核和受限权限写入。
- runtime discovery 改为 stable error code + params，CLI/UI 边界负责翻译；terminal bootstrap 也使用 locale mapping。英文及 6 个非英文 locale 已补齐并通过 parity/sorted/coverage。
- 修复 session watcher、process-tree cleanup 和 headless timeout 测试的真实竞态：使用唯一 client ID、事件驱动触发与清理、轮询实际进程退出，以及在确认子进程安装信号处理器后才启动短超时；没有用扩大等待时间掩盖问题。
- 本轮代码提交：`4ca546d`（`POO-14: 修复旧版升级与运行时验收`）。

## 逐 issue 处理结果

### 1. 全量测试偶发失败

- 两个 watcher 测试使用跨并发唯一的 client ID，并在 `afterEach` 保证释放 watcher；触发流程改为等待订阅就绪后事件驱动重试。
- local app manager 的 process-tree 测试等待真实 PID 退出，不再把发出终止信号当作清理完成。
- headless server timeout fixture 先从 stderr 收到“SIGTERM handler ready”信号，再启动故意保持很短的 timeout，消除了 handler 注册竞态。
- watcher 相关测试并发循环 30 次通过，headless timeout 回归循环 10 次通过。最终代码上连续两次完整 `bun run test` 均为 0 failed，且每轮后均完成进程、监听端口和临时目录检查。

### 2. 真实 pre-POO-14 previous artifact

- 新增 `scripts/validate-legacy-electron-layout.ts`，只验证可信旧容器的历史 App/package metadata 并提取版本，不要求 CLI/server/manifest 新布局。
- Unix validator 为 current 与 previous 使用不同校验器；full 模式要求固定 previous artifact 和对应 tag 的历史 `install-app.sh`，以原脚本安装旧版并验证 legacy `polo-ai`，之后再验证冲突保护、PATH/profile 迁移、升级和卸载。
- Windows validator 在任何写操作前分别提取旧/新版本；旧 NSIS 使用 legacy layout 校验并真实安装，current NSIS 继续执行严格验证。
- legacy fixture/container contract 覆盖 darwin、linux、win32，且证明相同 fixture 会被 current strict validator 拒绝。

### 3. `uv` platform runtime

- `scripts/build/common.ts` 新增 Mach-O、ELF、PE 的平台/架构检查。
- `scripts/prepare-platform-runtime.ts` 将 `uv(.exe)` staging 到与 runtime resolver 一致的 `resources/bin/<platform-arch>/`，校验下载 checksum、目标架构，并在宿主可执行时以 timeout/输出上限运行版本检查。
- clean runtime fixture 覆盖 darwin/linux/win32 的 x64/arm64 六种 target，并覆盖错误架构拒绝。
- electron-builder 和三平台最终容器 validator 均要求目标 `uv` 存在且可执行；本机实际 darwin-arm64 preparation 下载并校验 `uv 0.10.6`，最终 DMG/ZIP 内的 `uv --version` smoke 通过。

### 4. macOS `polo app` 生产启动/聚焦

- 删除 `POLO_AI_E2E_DIRECT_APP` 生产分支。
- macOS full validator 通过真实安装后的 wrapper 执行普通 `polo app`，即生产 `open` 路径；等待 discovery 后再次调用，验证 PID 未变化、进程仍存活并运行 `polo sessions`。
- 本机完成 current DMG/ZIP 容器 smoke；固定 previous 的真实安装/升级 full 依赖受控旧产物，当前凭据无法下载，故生产 `open` cold launch/focus lifecycle 由正式 macOS full workflow 执行，本机未虚报为已跑。

### 5. fixture final-component symlink escape

- 输出文件写入前使用 `lstat` 拒绝最终组件 symlink，打开时增加 `O_NOFOLLOW`，打开后以 `fstat` 复核常规文件。
- adversarial regression 创建指向 fixture root 外文件的最终 symlink，确认请求被拒绝且 root 外目标内容保持不变。

### 6. discovery/bootstrap i18n

- shared runtime discovery 不再生成用户可见英文 reason，改为稳定的 `errorCode` / `errorParams`。
- CLI 根据 locale 环境初始化 i18n，在 CLI/UI 边界翻译 discovery 与 bootstrap 错误。
- 7 个 locale（英文 + 6 个非英文）均为 1642 keys，parity、排序与覆盖检查通过。

## 关键文件

- `.github/workflows/electron-artifact-full.yml`
- `apps/electron/scripts/validate-final-artifacts.sh`
- `apps/electron/scripts/validate-final-artifacts.ps1`
- `scripts/validate-legacy-electron-layout.ts`
- `scripts/__tests__/legacy-electron-layout.test.ts`
- `scripts/prepare-platform-runtime.ts`
- `scripts/build/common.ts`
- `scripts/__tests__/prepare-platform-runtime.test.ts`
- `apps/cli/src/index.ts`
- `packages/shared/src/runtime-discovery.ts`
- `packages/shared/src/i18n/locales/*.json`
- `apps/electron/scripts/fixtures/mock-openai-provider.ts`
- `scripts/__tests__/mock-openai-provider.test.ts`
- `apps/electron/src/main/handlers/__tests__/session-watcher.test.ts`
- `apps/electron/src/main/handlers/__tests__/sessions-watchers.test.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts`
- `packages/server/src/__tests__/smoke.test.ts`
- `scripts/__tests__/electron-artifact-pipeline.test.ts`
- `apps/electron/resources/release-notes/next.md`

## 自测命令与真实结果

- `bun run test`，连续第 1 次：通过，主测试集及所有 isolated suites 均为 0 failed。
- `bun run test`，连续第 2 次：通过；主测试集 `4856 pass, 19 skip, 0 fail, 11687 expect()`，所有 isolated suites 通过。
- watcher 并发回归循环 30 次：全部通过。
- headless timeout 回归循环 10 次：全部通过。
- round-3 targeted regression（legacy、uv、symlink、discovery、watcher、manager、server smoke 等 9 个文件）：`65 pass, 0 fail, 392 expect()`。
- `bun run typecheck:all`：通过。
- i18n parity/sorted/coverage：通过；英文及 6 个非英文 locale 各 1642 keys。
- `bun run electron:validate:cli:runtime`：通过；覆盖 packaged discovery/server、自相对 symlink launcher、空格及非 ASCII 路径。
- `bun run test:doc-tools`：`20 pass, 0 fail`。
- `bun run lint:electron`：通过，0 errors；114 条仓库既有 warnings。
- `bun run lint:shared`：未通过，5 errors、9 warnings；错误均位于本轮未修改的 `packages/shared/src/resources/__tests__/resource-bundle.test.ts`、`packages/shared/src/sources/__tests__/token-refresh-manager.test.ts`、`packages/shared/src/sources/token-refresh-manager.ts`。本报告不将该命令记为通过。
- `git diff --check`、`git diff --cached --check`、`bash -n apps/electron/scripts/validate-final-artifacts.sh`：通过。
- `bun run electron:build`：通过。
- `bun run electron:prepare:runtime --platform=darwin --arch=arm64 --helpers-only`：通过。
- `electron-builder --mac --arm64`：通过；`afterPack`、DMG/ZIP 构建和 `afterAllArtifactBuild` 最终容器门禁均完成。
- `bun run electron:validate:artifacts:unix -- --mode smoke --release-dir apps/electron/release --arch arm64`：通过，DMG 与 ZIP 均输出 `final-container CLI smoke passed (0.10.0)`。

每轮并发/全量测试后的残留检查结果：

- 无 mock provider、temporary server、Polo App 或相关 Bun 遗留进程。
- 无 Polo/Bun 相关 TCP listener。
- 无 `polo-server-smoke-*`、`polo-run-server-*`、`polo-final-artifact.*`、`polo-artifact-e2e-*` 临时目录/文件。

## 最终产物证据

- 构建目标：macOS arm64，版本 `0.10.0`。
- DMG：`apps/electron/release/Polo-AI-arm64.dmg`
  - 完成时间：`2026-07-30T21:45:03Z`
  - 大小：`278464586` bytes
  - SHA-256：`028fac3dbb97a9f01cd48b52ee2423510991fb05c5a7c958f8145128918d3efd`
- ZIP：`apps/electron/release/Polo-AI-arm64.zip`
  - 完成时间：`2026-07-30T21:45:31Z`
  - 大小：`268796966` bytes
  - SHA-256：`42b071e4bd94abf1889fc52e530faa3b3cb325a5188834598bf142388729b368`
- builder hook 与随后手动 validator 均实际挂载 DMG、解压 ZIP，校验 CLI metadata/manifest/checksum、Bun/server/`uv`，并执行 `polo --version`、`polo --help` 与 `uv --version`。

## 遗留问题

- 本机为 macOS，无法原生执行 Windows NSIS 与 Linux AppImage 的安装、PATH、discovery、升级和卸载 full lifecycle；对应原生 validator 及 clean-runtime contract 已接入正式三平台 full workflow，必须由相应 runner 作为 blocking gate 执行。
- GitHub 组织策略拒绝当前 token 读取固定 previous release，本机无法下载可信旧 artifact，因而没有用当前 artifact 冒充跨版本升级。full 模式在缺失 previous artifact/历史 installer 或版本相同时会 fail fast。
- macOS 固定 previous → current 的真实安装、生产 `polo app` cold launch/focus、discovery、升级与卸载仍需由具有受控旧产物输入的 macOS full runner 执行；本机完成的是当前最终 DMG/ZIP 的容器级 smoke。
- `bun run lint:shared` 的既有 5 个错误不属于本轮修改范围，未在本轮扩大修复。
