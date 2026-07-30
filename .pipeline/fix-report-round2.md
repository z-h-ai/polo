# POO-14 Review 第 2 轮修复报告

## 处理结果

### 1. clean runner 缺少平台 runtime 与 helper server

已修复。

- 新增 `scripts/prepare-platform-runtime.ts`，统一准备并校验当前目标平台的：
  - checksum-verified Bun runtime；
  - Claude Agent SDK core 和目标平台 native binary alias；
  - ripgrep；
  - network interceptor 源文件；
  - session MCP server、Pi agent server 及目标平台 koffi native binary。
- `electron:dist:dev:mac|win|linux` 在 Electron build 前准备平台 runtime，在 build 后构建并 staging helper server，再执行显式架构的 electron-builder。
- 修复 `buildMcpServers` 使用 shell 拼接路径的问题，改用参数数组执行 Bun；含空格和非 ASCII 的 clean fixture root 可真实构建 helper server。
- full workflow 会先删除 Electron 下所有 ignored/generated runtime staging，再执行 clean runtime contract 测试；随后正式 build 必须从空 staging 重新生成全部依赖。

### 2. Linux full 使用错误的 AppImage 名称

已修复。

- Unix validator 先解析实际存在的当前 AppImage：
  - x64 builder hook 阶段支持 `Polo-AI-x86_64.AppImage`；
  - arm64 支持 `Polo-AI-aarch64.AppImage`；
  - 已规范化名称也支持 `Polo-AI-${ARCH}.AppImage`。
- smoke 解析出的真实路径直接写入 `CURRENT_ARTIFACT`，full install/upgrade 不再重新硬编码查找 `Polo-AI-x64.AppImage`。
- hook 验证成功后，workflow 才把 x86_64 产物规范化为上传契约中的 x64 名称。

### 3. Linux fresh shell 丢失动态 Xvfb 环境

已修复。

- fresh login shell 显式保留 `DISPLAY`、`XAUTHORITY`、Wayland/XDG runtime 和 DBus 地址。
- Linux full workflow 使用 `xvfb-run -a` 分配动态 display，设置 `POLO_AI_E2E_EXPECTED_DISPLAY`。
- validator 会在安装或启动 App 前验证 fresh shell 接收到同一个动态 display；随后通过真实 AppImage 执行 `polo app`、等待 discovery、运行 `polo sessions` 并终止已发现的 App 进程。
- fresh shell 先切换到隔离 HOME，避免 worktree 的 `bunfig.toml` preload 污染最终产物验收。

### 4. Windows PATH 验收绕过 NSIS

已修复。

- 不再手工把 `$binDir` 拼入测试 PATH。
- 安装后先读取真实 User PATH，要求受管 binDir 恰好出现一次。
- fresh `cmd.exe` 只使用刷新后的 Machine PATH + User PATH，执行 `where polo`，并要求第一条结果严格等于受管 `polo.cmd`。
- `--version`、`--help`、`app`、`run`、`sessions` 全部通过该 fresh 环境执行。
- 卸载后要求 User PATH 精确恢复到测试前的原值，并从同样的 fresh 环境验证 `where polo` 已失败。
- 用户同名命令冲突测试同时断言 launcher 内容、受管文件和 User PATH 均未被安装器修改。

### 5. previous/current 版本比较发生在写操作之后

已修复。

- Unix full 首先只挂载/解包当前和 previous container，校验 sanitized CLI metadata、manifest path/checksum，并读取版本。
- full preflight 阶段不执行 wrapper；缺失、不可解析或同版本时在 installer、launcher、profile、PATH 和 Polo 用户状态写入前退出。
- 版本不同后才运行当前最终容器 `--version`/`--help` smoke，并进入安装/升级生命周期。
- Windows 在设置测试 `LOCALAPPDATA` 和运行 NSIS 之前，通过 7-Zip 只读展开 previous/current NSIS，校验 metadata、manifest/checksum 和版本；安装后再做二次版本核对。
- 本机用当前 ZIP 冒充 previous 执行 fail-fast 回归：按预期返回 `Previous artifact version must differ...`，隔离 HOME 中没有生成 `.local`、profile 或 `.polo-ai`。

### 6. `polo run` probe 没有执行真实生命周期

已修复。

- 删除 CLI 中的 `POLO_AI_E2E_RUN_PROBE` handshake-only 分支。
- 新增只允许在显式 artifact fixture gate 下启动、只绑定 `127.0.0.1`、路径限制在 fixture root 内且要求长 token 的确定性 OpenAI-compatible mock provider。
- 三平台 full validator 使用普通生产 CLI 参数连接该 loopback provider，真实完成：
  - workspace 注册；
  - provider/model/credential 配置；
  - temporary packaged server 启动；
  - session 创建与消息任务；
  - session 删除；
  - server/runtime/端口清理。
- validator 断言 mock 收到 `hello`、CLI 输出确定性回复、workspace 已持久化、session 目录不存在、`polo-run-server-*` 不残留且临时端口已关闭。
- 实跑发现 headless turn 完成时 visual teardown 因无 desktop browser host 抛错，导致 session completion 被阻断；已将该 teardown 限定为无 host 时的安全 no-op，实际 browser tool 调用仍保持原有错误语义，并补单元测试。

### 7. 缺少直接 wrapper binary smoke

已修复。

- 新增 POSIX `test_polo_wrapper_smoke.py`，直接执行 checked-in `polo` 和兼容 `polo-ai`。
- 新增 Windows `windows-wrapper-smoke.test.ps1`，在 Windows runner 编译最小 fake `bun.exe` 后直接执行 `polo.cmd` 和 `polo-ai.cmd`。
- 两套测试都使用含空格和非 ASCII 的 fixture root，校验参数、Bun/CLI/server/resources env、packaged 标志、compat warning 和退出码透传。
- Windows 原生 wrapper smoke 已接入 full workflow；POSIX smoke 已接入 `test:doc-tools`。

### 8. `TerminalIntegrationStatus` 重复定义

已修复。

- `apps/electron/src/main/terminal-integration.ts` 直接导入并 re-export `apps/electron/src/shared/types.ts` 的共享类型，移除重复 interface。
- 全量 typecheck 通过。

## 正式 workflow 与关键文件

- `.github/workflows/electron-artifact-full.yml`
- `scripts/prepare-platform-runtime.ts`
- `scripts/build/common.ts`
- `scripts/__tests__/prepare-platform-runtime.test.ts`
- `scripts/__tests__/electron-artifact-pipeline.test.ts`
- `apps/electron/scripts/validate-final-artifacts.sh`
- `apps/electron/scripts/validate-final-artifacts.ps1`
- `apps/electron/scripts/fixtures/mock-openai-provider.ts`
- `scripts/__tests__/mock-openai-provider.test.ts`
- `apps/electron/resources/scripts/tests/test_polo_wrapper_smoke.py`
- `apps/electron/resources/scripts/tests/windows-wrapper-smoke.test.ps1`
- `apps/cli/src/index.ts`
- `packages/server-core/src/sessions/RemoteBrowserPaneManager.ts`
- `apps/electron/src/main/terminal-integration.ts`
- `apps/electron/resources/release-notes/next.md`

正式 release/nightly workflow 的输入契约保持为：

- 手动触发：必填 `previous_release_tag`。
- release/nightly：仓库变量 `POLO_AI_FULL_E2E_PREVIOUS_RELEASE_TAG`。
- 每个平台从该固定 tag 下载对应 previous ZIP/NSIS/AppImage。
- 三个平台均显式设置 `POLO_AI_ARTIFACT_VALIDATION_MODE=full` 和 `POLO_AI_PREVIOUS_ARTIFACT`。
- 任一平台 build、原生测试、full validator 或 artifact upload 失败都会阻断 job。

## 本机实际自测

1. 全量测试

   ```bash
   bun run test
   ```

   结果：PASS，退出码 0；包含标准和 isolated suites。

2. reviewer 专项测试

   ```bash
   bun test \
     scripts/__tests__/electron-artifact-pipeline.test.ts \
     scripts/__tests__/prepare-platform-runtime.test.ts \
     scripts/__tests__/mock-openai-provider.test.ts \
     packages/server-core/src/sessions/__tests__/RemoteBrowserPaneManager.test.ts
   ```

   结果：PASS，19 tests passed，0 failed，137 expect calls。clean runtime fixture 的路径包含空格和中文，并真实调用 Bun build 生成两个 helper server。

3. 全量类型检查

   ```bash
   bun run typecheck:all
   ```

   结果：PASS，退出码 0。

4. checked-in POSIX wrapper 与文档工具

   ```bash
   bun run test:doc-tools
   ```

   结果：PASS，20 tests passed，0 failed。

5. packaged CLI runtime

   ```bash
   bun run electron:validate:cli:runtime
   ```

   结果：PASS；packaged CLI/server discovery、受管 symlink 自相对解析、含空格和非 ASCII 路径均通过。

6. 平台 runtime 真实准备

   ```bash
   bun run electron:prepare:runtime --platform=darwin --arch=x64
   bun run electron:prepare:runtime --platform=darwin --arch=arm64
   ```

   结果：PASS；两种架构均下载并校验 Bun checksum，x64 缺失的 SDK optional package 通过 fallback 准备成功，SDK native binary alias、ripgrep 和 interceptor 校验通过。

7. macOS 最终 DMG/ZIP build 与 container smoke

   在提交 `7a7dd79` 状态重新执行 arm64 Electron build 和 electron-builder。结果：PASS，afterPack 校验、DMG 挂载 smoke、ZIP 解包 smoke 全部通过，CLI/App 版本为 `0.10.0`。

   构建完成时间：`2026-07-30T16:42:31Z`。

   - DMG：`93621f0db6627065f4e4e4df443392eb8463be24a5760e00a1122a833da85770`
   - ZIP：`da307cc4ddafc4a05b971fd3bdaa6bbda5c02320b21d16847cedc5191ff77df8`

8. full 同版本只读 fail-fast

   使用上述最终 ZIP 同时作为 current 和 previous 运行 full validator。结果：按预期失败，错误为 previous/current 同版本；隔离 HOME 没有 installer、launcher、profile、PATH 或 `.polo-ai` 写入。

9. Electron lint 与格式检查

   ```bash
   bun run lint:electron
   git diff --check
   bash -n apps/electron/scripts/validate-final-artifacts.sh
   ```

   结果：PASS。Electron lint 为 0 errors，保留 114 条仓库既有 warnings；diff 与 shell 语法检查通过。

10. 真实 headless run 生命周期

    本机以构建后的 CLI/packaged server 和受限 loopback fixture 执行 `polo run "hello"`。结果：确定性回复成功；workspace/provider/session 均实际创建，temporary server、session、runtime 和端口全部清理。该实跑同时发现并验证了 headless visual teardown 修复。

## 对应平台 CI 执行、未在本机冒充的部分

- Windows 原生 PowerShell ownership/wrapper 测试、NSIS previous→current 安装升级、真实 User PATH、discovery 和卸载：只能由 `windows-latest` full job 执行，本机未运行。
- Linux AppImage previous→current 安装升级、动态 Xvfb、App discovery、sessions 和卸载：只能由 Ubuntu full job 执行，本机未运行。
- macOS 固定 previous release→当前版本的完整跨版本升级：本机没有可用的不同版本 POO-14 previous ZIP，因此没有用当前产物冒充升级；由 macOS full job 下载固定 tag 产物执行。
- 上述平台流程不是空开关：workflow 已显式下载 previous artifact、准备 GUI runner 环境、运行原生测试与 full validator，并把成功结果作为 artifact upload 前的 blocking gate。

## 已知遗留

- 本轮 8 个 reviewer issue 均已处理，无已知未完成代码项。
- `bun run lint` 的聚合入口仍因仓库缺少既有的 `scripts/check-raw-sends.sh` 在第一步退出；本轮实际运行并通过与改动相关的 `lint:electron`、typecheck、全量测试和专项测试，未扩大范围补造该缺失脚本。
- 最终 Windows/Linux/full cross-version 结果必须以对应 GitHub Actions runner 的实际运行记录为准；本报告没有把静态契约测试写成原生 E2E 已通过。

## 提交

- `cb18105 POO-14: 修复三平台完整产物验收`
- `7a7dd79 POO-14: 更新第2轮修复发布说明`
