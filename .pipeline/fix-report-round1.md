# POO-14 第 1 轮修复报告

## Blocking issue 1：full 模式没有真实跨版本生命周期

处理结果：

- full validator 新增明确的 previous artifact 输入契约：
  - 环境变量 `POLO_AI_PREVIOUS_ARTIFACT`。
  - shell 参数 `--previous-artifact`。
  - PowerShell 参数 `-PreviousArtifact`。
  - full 模式缺失文件时在安装前 fail fast；上一版本和当前版本相同也会失败，禁止用当前产物冒充升级。
- `scripts/install-app.sh` 新增显式本地 artifact 输入，CI/offline 模式仍走正式安装逻辑，不依赖线上 latest manifest。
- macOS full：
  - 使用真实 `install-app.sh` 安装上一版本 ZIP 和当前 ZIP。
  - 通过安装后的 App 可执行文件调用 `--polo-terminal-integration install|repair|uninstall`，复用 App 设置页相同的实现。
  - fresh login shell 验证 PATH、`polo --version`、`--help`、`run`、`app`、`sessions`。
  - `polo run` probe 会真实启动 packaged temporary server 并完成 RPC handshake，但不要求 CI 提供真实 LLM 凭据。
  - 验证 App discovery、用户同名命令保护、升级后的 symlink 目标和卸载残留。
- Linux full：
  - 使用真实 `install-app.sh` / `uninstall-app.sh` 安装上一版本和当前 AppImage。
  - 通过真实 AppImage launcher 执行 fresh shell 命令、temporary server probe、App discovery、sessions、冲突和残留验证。
- Windows full：
  - 真实静默安装上一版本 NSIS，再升级到当前 NSIS。
  - 验证 fresh `cmd.exe` PATH、全部要求命令、runtime discovery、版本变化、modified launcher 拒绝覆盖、用户同名命令保护、PATH 与文件卸载残留。
- 实跑 macOS 生命周期时额外发现 App 自己加入 PATH 的包内 wrapper 被误判为用户命令冲突；已修复并补回归测试。

关键文件：

- `apps/electron/scripts/validate-final-artifacts.sh`
- `apps/electron/scripts/validate-final-artifacts.ps1`
- `apps/electron/scripts/afterAllArtifactBuild.cjs`
- `scripts/install-app.sh`
- `apps/electron/src/main/terminal-integration-command.ts`
- `apps/electron/src/main/index.ts`
- `apps/cli/src/index.ts`
- `apps/electron/src/main/terminal-integration.ts`

本机实跑：

- macOS 当前版本真实安装、App 终端设置、fresh shell、`polo run` temporary server、`polo app`、discovery、`polo sessions`、App 终端卸载及残留检查：通过。
- full 模式缺少 previous artifact 的 fail-fast：通过。
- 固定旧版本到当前版本的 macOS full 未在本机执行。组织策略拒绝当前 GitHub token，无法下载 release artifact；没有使用当前 artifact 伪造旧版本。

## Blocking issue 2：没有正式 release/nightly 三平台 workflow

处理结果：

- 新增 `.github/workflows/electron-artifact-full.yml`。
- workflow 在 `release.created`、定时 nightly 和手动触发时运行 macOS、Windows、Linux blocking matrix。
- 手动触发必须提供 `previous_release_tag`；release/nightly 使用仓库变量 `POLO_AI_FULL_E2E_PREVIOUS_RELEASE_TAG`。每个 job 从对应固定 tag 下载平台原生产物，并传入 full validator。
- 三个平台分别构建 DMG+ZIP、NSIS、AppImage；构建过程设置 `POLO_AI_ARTIFACT_VALIDATION_MODE=full`。
- Windows runner 在打包前执行原生 PowerShell launcher ownership/卸载测试。
- Linux runner 显式准备 Xvfb 与 AppImage 依赖，full validator 实际启动 GUI 并等待 discovery。
- 构建产物和包含 commit、旧版本 tag、SHA-256 的验证结果文件通过 `actions/upload-artifact` 上传；任一构建或 validator 失败都会阻断 matrix job。
- 普通 `.github/workflows/validate.yml` 未加入昂贵 full E2E，继续保持分层。
- `scripts/__tests__/electron-artifact-pipeline.test.ts` 增加 workflow、previous artifact、真实入口和命令覆盖契约测试。

本机实跑：

- workflow YAML 解析：通过。
- workflow/validator 静态契约测试：通过。
- Windows PowerShell、NSIS 和 Linux AppImage 原生流程只能由对应平台 runner 执行；本机未声称已运行。

## Minor issue 3：implement report hash 与 locale 数量

处理结果：

- 在本轮最终代码及 release note 状态重新构建 macOS 产物：
  - DMG：`9af85aea855ba3488808e2359cb228df44eb5375d935e8ecc9911c3ec19fe061`，`2026-07-30T08:52:11-0700`。
  - ZIP：`00abbe4ea76724e80ebbb7071746d41f02e80c434824c0b62e53712cfa291564`，`2026-07-30T08:52:38-0700`。
- 最终 DMG/ZIP 挂载/解包 smoke 均通过，版本 `0.10.0`。
- implement report 已改为准确的 7 个 locale：英文及 6 个非英文 locale。

## 综合自测

- `bun run test`：通过，主测试与全部 isolated suites 均无失败。
- `bun run typecheck:all`：通过。
- `bun run electron:validate:cli:runtime`：通过。
- `bun run lint:electron`：通过，0 errors；114 条仓库既有 warnings。
- targeted reviewer regression：59 passed、0 failed；终端冲突补充测试：23 passed、0 failed。
- `bun run electron:dist:dev:mac`：通过，DMG/ZIP 最终容器 smoke 均通过。
- shell 语法、workflow YAML、`git diff --check`：通过。

## 提交

- `233ada3 POO-14: 接入跨版本三平台产物验收`
- `b4c14f9 POO-14: 修复应用内终端命令冲突误判`
