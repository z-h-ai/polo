# POO-14 实现报告

## 变更摘要

- macOS 终端功能改为受管 symlink：`~/.local/bin/polo` 指向当前 App 包内的 `resources/bin/polo`，包内 wrapper 继续以自身真实位置解析 Bun、CLI 与 server。安装、修复、App 移动/升级、冲突检测及卸载均按受管目标和状态处理，不再生成固化资源绝对路径的 launcher 脚本。
- macOS shell 配置状态升级为 schema 2，记录安装 profile；修复和卸载会安全检查 zsh、bash、fish 的所有受支持 profile，只删除完整且唯一的 Polo 托管块。文件修改继续采用备份和原子替换，并兼容旧状态迁移。
- login shell 可用性探测增加默认 7 秒 timeout、16 KiB 输出上限及 `ok` / `timeout` / `failed` 结构化状态；子进程超时会被终止，不会无限阻塞 Electron 主进程。
- Windows launcher 所有权改为 state 路径 + SHA-256 校验；state 缺失时只接受完整内容匹配的严格历史 allowlist。用户自有或被修改的 launcher 会停止升级并提示，卸载不会删除该文件或对应 PATH/state。
- CLI 构建生成 sanitized `dist/cli/package.json`，只包含稳定的 `name`、`version`、`type`、`main`、`bin`、`license` 字段；artifact manifest 记录其 SHA-256，构建校验与 `afterPack` 均验证字段、版本和 checksum。
- 新增平台原生最终 artifact validator，并通过 electron-builder `afterAllArtifactBuild` 接入构建门禁：macOS 挂载 DMG、解压 ZIP，Linux 解包 AppImage，Windows 静默安装 NSIS 后，对最终容器中的 launcher、Bun、CLI/server、manifest/checksum、`polo --version` 与 `polo --help` 做 smoke。`POLO_AI_ARTIFACT_VALIDATION_MODE=full` 要求固定上一版本产物，使用真实安装入口验证 fresh shell、App discovery、跨版本升级、所有权冲突和卸载。
- 新增正式三平台 release/nightly workflow，并引用本轮实现提交 `233ada3`、`b4c14f9`。

## 关键文件列表

- `apps/electron/src/main/terminal-integration.ts`
- `apps/electron/src/main/__tests__/terminal-integration.test.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/resources/scripts/windows-terminal-integration.ps1`
- `apps/electron/resources/scripts/tests/windows-terminal-integration.test.ps1`
- `apps/electron/scripts/windows-terminal-integration.test.ts`
- `scripts/build-cli-artifacts.ts`
- `scripts/validate-cli-artifacts.ts`
- `apps/electron/scripts/afterPack.cjs`
- `apps/electron/scripts/afterAllArtifactBuild.cjs`
- `apps/electron/scripts/validate-final-artifacts.sh`
- `apps/electron/scripts/validate-final-artifacts.ps1`
- `scripts/__tests__/electron-artifact-pipeline.test.ts`
- `apps/electron/electron-builder.yml`
- `apps/electron/resources/release-notes/next.md`

## 自测结果

- `bun run test`：通过。主测试集 4836 passed、19 skipped、0 failed；其余隔离测试集全部通过。
- `bun run typecheck:all`：通过。
- `bun run lint:electron`：通过，0 errors；保留 114 条仓库既有 warnings。
- `bun run electron:build:cli`：通过，生成 CLI、server、sanitized package metadata 和 artifact manifest。
- `bun run electron:validate:cli`：通过，metadata 字段/版本/checksum 与所有 runtime artifact 校验成功。
- `bun run electron:validate:cli:runtime`：通过，覆盖 packaged discovery/server、自相对 symlink launcher、含空格和非 ASCII 路径。
- macOS terminal integration 单测：16 passed，覆盖 symlink 幂等、App 移动后旧目标消失、默认 shell 切换的遗留 profile 清理、结构化 timeout，以及真实超时子进程终止。
- Windows ownership 与 artifact pipeline 的 Bun 静态/契约测试：通过；PowerShell 测试补充了 hash state、被修改 launcher 的升级拒绝和卸载保留、历史 allowlist 迁移。
- `bun run electron:dist:dev:mac`：在本轮最终代码和 release note 状态重建通过；electron-builder 的最终容器门禁实际挂载/解包并验证：
  - `apps/electron/release/Polo-AI-arm64.dmg`，构建时间 `2026-07-30T08:52:11-0700`，SHA-256 `9af85aea855ba3488808e2359cb228df44eb5375d935e8ecc9911c3ec19fe061`
  - `apps/electron/release/Polo-AI-arm64.zip`，构建时间 `2026-07-30T08:52:38-0700`，SHA-256 `00abbe4ea76724e80ebbb7071746d41f02e80c434824c0b62e53712cfa291564`
  - DMG 与 ZIP 的 `polo --version` / `polo --help` smoke 均通过，版本为 `0.10.0`。
- 使用本轮 ZIP 在含空格、非 ASCII 的隔离目录完成 macOS 真实当前版本生命周期：真实 `install-app.sh` 安装、App 内终端设置入口安装、fresh zsh 的 `polo --version` / `--help` / `run`、`polo app` 启动、runtime discovery、`polo sessions`、App 内卸载入口及残留检查均通过。
- full 模式无上一版本 artifact 时的 fail-fast 测试：通过。
- i18n parity、sorted、coverage：通过，共 7 个 locale（英文及 6 个非英文 locale），各 1633 keys。
- `git diff --check`：通过。

## 遗留问题

- 当前 coder 环境为 macOS，且 GitHub 凭据受组织 token 生命周期策略拒绝，无法下载固定上一版本 artifact，因此本机未把当前产物冒充旧版本执行 cross-version full；该路径会在正式 workflow 中缺少固定旧产物时 fail fast。
- 本机未生成 Windows NSIS 和 Linux AppImage，因此未执行这两个平台的真实最终容器 full lifecycle；对应原生 validator 已接入 release/nightly 三平台 blocking matrix。
- 当前环境未安装 `pwsh`，PowerShell 原生测试未在本机运行；Windows 逻辑已由 Bun 契约测试覆盖，原生 PowerShell 测试需由 Windows CI 执行。
- full 模式涉及真实安装、App discovery、升级与卸载，按裁决保留为 release/nightly 或手动触发，不作为普通 PR 的昂贵默认流程。
