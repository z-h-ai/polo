# POO-14 第 2 轮修复报告

## 结果摘要

本轮已完成 reviewer 指出的三项代码修复，并创建代码提交：

- `80d3f3ff66edf4ebdd2fd30a69c4381dc27c352e` — `POO-14: 收紧发布签名与终端所有权`

macOS arm64 development DMG/ZIP 已从该代码提交重建，最终容器 smoke 通过。该产物明确为 ad-hoc、无 Team ID 的开发产物，只属于 development smoke，不计作 release/full acceptance。

生产签名 secrets、可信且版本不同的 previous release 三平台产物以及 Windows/Linux 原生 runner 不在本机环境中，因此本报告不声称已完成 Windows/Linux 原生 full，也不声称已有真实 previous→current 三平台成功证据。正式 workflow 已把这些输入设为 fail-fast 的发布契约，仍需外部 release/nightly runner 产出可审计 full logs。

## 逐 issue 处理结果

### 1. release/full 签名身份验收

已修复。

- 新增共享的 `scripts/release-signing-contract.ts`，把 release/full 身份检查与 development smoke 分离。
- macOS full 必须由 CI 明确提供且不得为空：
  - `POLO_AI_RELEASE_MACOS_TEAM_ID`
  - `POLO_AI_RELEASE_MACOS_APP_REQUIREMENT`
  - `POLO_AI_RELEASE_MACOS_UV_REQUIREMENT`
- macOS full 对最终 DMG/ZIP 内的 App 与嵌套 `uv` 校验：
  - `codesign --verify --strict`；
  - App 与 `uv` 的 Team ID 均与契约完全一致；
  - App 与 `uv` 的 designated requirement 均与契约完全一致；
  - `spctl` 返回 `Notarized Developer ID`；
  - `xcrun stapler validate` 通过。
- Windows full 必须由 CI 明确提供且不得为空：
  - `POLO_AI_RELEASE_WINDOWS_PUBLISHER`
  - `POLO_AI_RELEASE_WINDOWS_THUMBPRINT`
- Windows full 对当前 NSIS installer、解包 App、解包 `uv`、安装后 App 和安装后 `uv` 校验 Authenticode `Valid`、Publisher 完全匹配及 SHA-1 thumbprint 完全匹配。
- macOS/Windows full 的预期身份、观察身份、签名/公证/stapling 状态与时间写入 JSONL audit；workflow 把 audit、commit SHA、artifact hash 与 full log 作为 blocking artifact 上传。
- `.github/workflows/electron-artifact-full.yml` 已改用正式 `electron:dist:mac|win|linux`，不再用 dev dist 冒充 full；macOS notarization 在正式构建开启，只有显式 `--dev` 才关闭。
- smoke 日志明确输出 `acceptance=development-only`；ad-hoc/unsigned 不会产生 release acceptance audit。

回归覆盖了：

- 缺失 expected identity；
- macOS ad-hoc/no-Team-ID；
- 错误 Team ID、App requirement、`uv` requirement、公证和 stapling；
- 正确 macOS identity；
- 错误 Windows Publisher、thumbprint、signature status；
- 正确 Windows identity；
- JSONL audit 写入。

### 2. macOS launcher 所有权

已修复。

- ownership state 升级为 schema 3，记录固定 owner、launcher format、App version、launcher path、launcher target、更新时间及 SHA-256 launcher identity。
- identity hash 绑定 owner、format、version、path 与 target；读取时同时校验版本格式、时间、字段完整性和 hash。
- 同 target symlink 本身不再构成所有权。删除/替换必须满足：
  - 当前路径与 state 中的 launcher path 完全一致；
  - 当前 symlink 解出的 target 与 state 中的 target 完全一致；
  - owner、format、version 与 identity 可验证。
- 缺失、损坏、不完整或 identity 被篡改的 state 均不会授权删除 launcher，且会保留冲突现场。
- schema 1/2 只作为历史 Polo state marker 迁移：要求有效时间、历史 profile marker 信息，以及当前 symlink 与历史 state 中 path/target 完全一致；迁移/修复后写为 schema 3。
- 更早的无 state launcher 只接受严格完整内容匹配的 Polo 历史 managed launcher，不使用 substring 或仅 target 匹配。
- App 移动后，已验证历史或当前 ownership 可修复到新 bundle target；正常安装、修复与卸载保持可用。

回归覆盖了用户自建同 target symlink、state 缺失、坏 JSON、不完整旧 state、被篡改 identity、用户替换 target、App 路径移动、历史 state 迁移、正常安装/修复/卸载与 shell profile 清理。

### 3. packaged wrapper 本地化

已修复。

- `polo`、`polo.cmd` 内置不依赖外部 runtime 的最小 locale table。
- `polo-ai`、`polo-ai.cmd` 的弃用提示使用同样的最小 locale 判定。
- 支持 `POLO_AI_LOCALE`、locale 环境变量中的 zh/zh-CN 变体；其他 locale 稳定回退英文。
- runtime/CLI/server 缺失分别输出稳定错误码：
  - `POLO_E_BUNDLED_RUNTIME_MISSING`
  - `POLO_E_TERMINAL_FILES_MISSING`
- compatibility warning 使用 `POLO_W_DEPRECATED_COMMAND`。
- Windows installer 生成的 `polo.cmd`/compat shim 与 checked-in wrapper 保持同一契约。
- wrapper 仍然自相对解析 App、Bun、CLI/server，不引入系统 Node/Bun 或外部 locale 文件依赖。

POSIX 真实 wrapper smoke 使用含空格和非 ASCII 的 fixture root，验证了参数、环境、退出码、zh-CN 与 fallback。Windows 原生等价测试已写入正式 workflow，但本机没有 Windows/PowerShell，未声称原生执行。

## 关键文件

- `scripts/release-signing-contract.ts`
- `scripts/__tests__/release-signing-contract.test.ts`
- `apps/electron/scripts/validate-final-artifacts.sh`
- `apps/electron/scripts/validate-final-artifacts.ps1`
- `.github/workflows/electron-artifact-full.yml`
- `apps/electron/electron-builder.yml`
- `scripts/electron-dist.ts`
- `apps/electron/src/main/terminal-integration.ts`
- `apps/electron/src/main/__tests__/terminal-integration.test.ts`
- `apps/electron/resources/bin/polo`
- `apps/electron/resources/bin/polo.cmd`
- `apps/electron/resources/bin/polo-ai`
- `apps/electron/resources/bin/polo-ai.cmd`
- `apps/electron/resources/scripts/windows-terminal-integration.ps1`
- `apps/electron/resources/scripts/tests/test_polo_wrapper_smoke.py`
- `apps/electron/resources/scripts/tests/windows-wrapper-smoke.test.ps1`
- `scripts/__tests__/packaged-wrapper-i18n.test.ts`
- `scripts/__tests__/electron-artifact-pipeline.test.ts`
- `scripts/__tests__/electron-dist.test.ts`
- `apps/electron/resources/release-notes/next.md`

## 自测命令与真实结果

### 全量与静态门禁

- `bun run test`
  - 通过。
  - 主套件：`4885 pass / 19 skip / 0 fail`，`4904 tests / 378 files`。
  - 随后的全部 isolated suites 通过，包括 server concurrency、file-lock races、CLI server spawner 与 Electron isolated interaction suites。
- `bun run typecheck:all`
  - 通过。
- `bun run lint:shared`
  - 通过，`0 errors / 9 warnings`；warning 为仓库既有 unused eslint-disable。
- `bun run lint:electron`
  - 通过，`0 errors / 114 warnings`；warning 为仓库既有 hook/localStorage 等 warning。
- `bun run lint:i18n:parity`
  - 通过，`6 locales / 每个 1642 keys`。
- `bun run lint:i18n:coverage`
  - 通过。
- `bun run lint:i18n:sorted`
  - 通过。
- `bun run test:doc-tools`
  - 通过，`23 tests`。
- `bun run electron:build`
  - 通过；CLI、server、main、preload、renderer、resources 和 sanitized metadata/manifest 校验均成功。
- `bun run electron:validate:cli:runtime`
  - 通过；packaged CLI/server discovery、自相对 symlink launcher、空格与非 ASCII 路径验证成功。

### 针对性回归

执行：

```text
bun test scripts/__tests__/release-signing-contract.test.ts \
  scripts/__tests__/packaged-wrapper-i18n.test.ts \
  scripts/__tests__/electron-artifact-pipeline.test.ts \
  scripts/__tests__/electron-dist.test.ts \
  apps/electron/src/main/__tests__/terminal-integration.test.ts \
  apps/electron/scripts/windows-terminal-integration.test.ts
```

结果：`46 pass / 0 fail / 339 expect()`。

其他：

- `python3 -m unittest apps.electron.resources.scripts.tests.test_polo_wrapper_smoke`
  - `4 tests` 通过。
- `bash -n apps/electron/scripts/validate-final-artifacts.sh apps/electron/resources/bin/polo apps/electron/resources/bin/polo-ai`
  - 通过。
- Ruby `YAML.safe_load` 解析 `.github/workflows/electron-artifact-full.yml`
  - 通过。
- `git diff --check`
  - 通过。
- macOS full 在未提供 release identity 时的 fail-fast 复核
  - 返回码 `1`；
  - 输出：`Full macOS validation requires the release Team ID and App/uv designated requirements`；
  - 发生于 mount/install/profile 等写操作之前。

## macOS arm64 development 最终产物证据

构建命令：

```text
bun run electron:dist:dev:mac --arch=arm64
```

显式最终容器复核：

```text
bun run electron:validate:artifacts:unix -- \
  --mode smoke \
  --release-dir apps/electron/release \
  --arch arm64
```

结果：

- DMG final-container CLI smoke 通过，版本 `0.10.0`。
- ZIP final-container CLI smoke 通过，版本 `0.10.0`。
- 日志明确标记 `mode=smoke acceptance=development-only`。

产物基于代码提交 `80d3f3ff66edf4ebdd2fd30a69c4381dc27c352e` 构建：

- `apps/electron/release/Polo-AI-arm64.dmg`
  - 时间：`2026-07-30T16:32:26-0700`
  - 大小：`278466412` bytes
  - SHA-256：`2783399c04dded29711e50227d85771b62b9cfbd5ad80d7b2cfb2ca6ca45ed38`
- `apps/electron/release/Polo-AI-arm64.zip`
  - 时间：`2026-07-30T16:32:54-0700`
  - 大小：`268800640` bytes
  - SHA-256：`a9929f7b70ebbdb00d29e792e0d60d724cd971af9ad5c4c1da27cbe32144e906`

签名观察：

- App：`Signature=adhoc`、`TeamIdentifier=not set`。
- 嵌套 `uv`：`Signature=adhoc`、`TeamIdentifier=not set`。
- packaged `uv --version`：`uv 0.10.6 (a91bcf268 2026-02-24)`。

以上签名只证明 development smoke 的容器和可执行性，不是生产签名、公证或 release acceptance。

## 残留检查

- 未发现本 worktree 启动的 `electron-builder`、App、packaged server 或 mock provider 残留进程。
- 未发现 Polo/Bun/Electron 相关监听端口。
- 未发现 `polo-final-artifact.*`、`polo-run-server-*`、wrapper/terminal fixture 等临时目录残留。
- 未发现 `~/.polo-ai/runtime/electron.json`。
- 未发现残留 Polo DMG mount。
- 当前仍运行的 Ultra-Coding runner/wait 进程属于本 implement session 编排基础设施，不是产品 App/server 残留。

## 未闭合的外部 release evidence

以下必须由带真实资产与 secrets 的正式 release/nightly 三平台 workflow 完成，本机没有条件伪造或替代：

- 可信、固定、版本不同且包含 macOS ZIP、Windows NSIS、Linux AppImage 与历史 Unix installer 的 pre-POO-14 release 输入；
- Apple Developer ID、预期 Team ID/designated requirements、公证与 stapling 的真实 full 结果；
- Windows 预期 Publisher/thumbprint、真实 Authenticode 签名及 Windows 原生安装/PATH/ownership/升级/卸载结果；
- Linux 原生 AppImage 安装、Xvfb discovery、`polo app/run/sessions`、升级与卸载结果；
- 三平台 previous→current full logs、audit JSONL、commit SHA 与 artifact SHA-256 上传证据。

workflow 对上述字段和资产均 fail-fast，且 full job 使用正式 dist 入口并把验证结果作为 blocking upload gate。是否具备实际 secrets/历史 release assets 以及对应 runner 的成功记录，需由外部 CI/reviewer 核验；本报告不声称通过。
