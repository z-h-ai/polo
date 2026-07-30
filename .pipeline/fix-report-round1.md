# POO-14 第 1 轮 reviewer 修复报告

## 结论

本轮 6 个 reviewer issue 均已在代码范围内处理。macOS arm64 的正式 target-aware dist 入口、Electron build、DMG/ZIP 最终容器 smoke 已在本机真实通过。Windows NSIS、Linux AppImage 及三平台 full 跨版本生命周期不能在当前 macOS 宿主代跑；对应 workflow 已设置不可绕过的 previous-release provenance/hash/version 契约，缺少真实且版本不同的历史产物时会在任何安装写操作前失败。

代码提交：

- `beb25e2 POO-14: 收口发布运行时与验收契约`
- `cabb49d POO-14: 校验签名后的 uv 最终产物`

## 逐 issue 处理结果

### 1. `packages/shared` lint 非零

- 修复 `resource-bundle.test.ts`、`token-refresh-manager.test.ts` 的 unsafe member access。
- 将 `token-refresh-manager.ts` 的参数属性直接赋值改为显式 `Object.assign` 更新，消除 parameter-property assignment errors。
- 更新 interceptor packaging contract，使其验证收口后的统一 runtime preparation，而不是已改为委托 shim 的旧平台脚本。
- 最终 `bun run lint:shared`：退出码 0，`0 errors / 9 warnings`。9 条均为原有 unused eslint-disable warnings；没有忽略、降级或关闭规则。

### 2. 正式 dist 入口未统一进入 target-aware runtime preparation

- 新增 `scripts/electron-dist.ts`，顺序固定为：
  1. 按目标 platform/arch 准备 Bun、uv、SDK native alias、ripgrep、interceptor；
  2. 设置 `POLO_AI_REQUIRE_BUNDLED_RUNTIME`、目标 platform/arch 后执行 Electron build；
  3. staging session/Pi helpers；
  4. 调用目标平台 electron-builder。
- 根 `electron:dist`、`electron:dist:mac|win|linux`、3 个 dev dist 入口以及 `apps/electron` 的旧 `dist:*` 入口全部委托该实现。
- `build-dmg.sh`、`build-linux.sh`、`build-win.ps1` 改为兼容委托 shim，不再直接绕过 runtime preparation 调用 builder。
- 非原生平台打包 fail fast，避免在错误宿主上产生伪平台产物。
- `beforePack`、`afterPack` 和最终容器 validator 均校验目标 runtime manifest、目标 arch 和必要文件。
- 新增 `electron-dist.test.ts`、pipeline contract test，覆盖调用顺序、环境传播、正式/旧入口以及非原生拒绝。

### 3. uv 缓存只有架构检查，没有固定版本可信 hash

- 新增 `scripts/uv-runtime-lock.json`，固定 uv `0.10.6` 的 6 个 platform/arch release asset、archive SHA-256 与 extracted binary SHA-256。
- 缓存复用现在必须同时满足目标架构和 pinned binary SHA-256；同架构污染或旧版本会重新下载。
- 下载使用临时目录，校验 upstream `.sha256` 与本地 lock、archive hash、extracted binary hash后，再在目标目录原子替换。
- 每个目标写入 `resources/bin/<platform-arch>/runtime-manifest.json`，记录 version、source、asset hash 与 binary hash；build、afterPack、最终容器均复核。
- 本机打包进一步发现官方 `uv --version` 为 `uv 0.10.6 (a91bcf268 2026-02-24)`，已用严格的“固定版本 + 可选官方 build suffix”解析修复，拒绝相邻版本及任意尾随文本。
- electron-builder 会重新签名 macOS nested Mach-O，签名后文件 hash 合理变化。最终容器因此同时要求：
  - manifest 的 source hash 等于 lock 中的官方 unsigned/release binary hash；
  - nested uv `codesign --verify --strict` 成功；
  - `uv --version` 严格匹配固定版本。
  Windows 同理：若最终 PE hash 因 Authenticode 签名变化，必须具有 `Valid` Authenticode signature；未签名产物仍必须逐字节匹配 pinned hash。Linux 继续要求最终文件 hash 精确匹配。
- 回归覆盖 6 个 target、同架构污染、旧/错误架构、manifest 篡改、原子替换、version suffix 和签名后最终容器契约。

### 4. previous release 不同版本与可信来源未闭合

- 新增 `validate-previous-release-contract.ts`，在生命周期写操作前验证：
  - immutable semantic tag；
  - 40 字符 tag commit SHA；
  - tag 内 Electron package version；
  - previous/current version 必须不同；
  - 平台历史 artifact 的固定文件名与 SHA-256；
  - Unix 历史 installer 的 SHA-256。
- `.github/workflows/electron-artifact-full.yml` 的 release、nightly、workflow_dispatch 三平台 matrix 使用固定 provenance 输入；下载后先生成 `verified-contract-<platform>.json`，再进入 full build/lifecycle。
- workflow 将 `GITHUB_SHA`、previous tag/version/commit、previous/current artifact hash、contract JSON 与完整 full log作为 blocking artifact 上传。
- 当前仓库可见的唯一 tag 是 `v0.11.0`，但该 tag 内 `apps/electron/package.json` 版本与当前均为 `0.10.0`；它不能合法充当 previous release。当前组织 GitHub token 还被 PAT lifetime policy 拒绝，因此本机无法选择并下载另一个可信、三平台齐全的历史 release。
- 没有伪造三平台 full 成功：release/nightly 必须配置真实不同版本的 tag、commit 和各资产 hash，否则 workflow fail fast。外部 runner 的真实成功日志仍是待补的发布证据，详见“遗留/外部事项”。

### 5. 第二次 `polo app` 未证明 macOS focus

- 新增原生 JXA probe `macos-running-app-state.jxa`，通过 AppKit 的 `NSRunningApplication.active` 与 `NSWorkspace.frontmostApplication` 获取可执行状态。
- macOS full 流程现在验证：
  - cold launch 后 App active/frontmost；
  - 激活 Finder 后原 App 进入 background；
  - 第二次走生产 `polo app`；
  - PID 不变，且同一 PID 再次 active/frontmost。
- 每一阶段输出 `macos-focus-state phase=...` 到 `full-validation-macos.log`，便于 CI 诊断。
- 本机原生 probe 测试已实际读取当前 frontmost application 并通过；完整 App focus lifecycle 需要 macOS full runner 和可信 previous artifact。

### 6. `--polo-cli` 早退分支模块级翻译

- 移除 module evaluation 阶段的 `i18n.t()`。
- shared locale registry 新增 `resolveSupportedLanguage()` 与 registry-based `translateRegistryMessage()`；CLI 文件缺失的早退分支直接从系统 locale 解析并读取稳定 registry，不依赖尚未初始化/尚未切换 locale 的 i18next singleton。
- 正常 App 初始化也复用同一个 locale resolver，删除 Electron 内硬编码语言映射。
- 新增 early-error contract 与 locale registry fallback 测试；i18n parity/sorted/coverage 全部通过。

## 关键文件

- `.github/workflows/electron-artifact-full.yml`
- `scripts/electron-dist.ts`
- `scripts/prepare-platform-runtime.ts`
- `scripts/build/common.ts`
- `scripts/uv-runtime-lock.json`
- `scripts/validate-previous-release-contract.ts`
- `apps/electron/scripts/beforePack.cjs`
- `apps/electron/scripts/afterPack.cjs`
- `apps/electron/scripts/validate-final-artifacts.sh`
- `apps/electron/scripts/validate-final-artifacts.ps1`
- `apps/electron/scripts/macos-running-app-state.jxa`
- `apps/electron/src/main/index.ts`
- `packages/shared/src/i18n/languages.ts`
- `scripts/__tests__/electron-artifact-pipeline.test.ts`
- `scripts/__tests__/prepare-platform-runtime.test.ts`
- `scripts/__tests__/electron-dist.test.ts`
- `scripts/__tests__/previous-release-contract.test.ts`
- `scripts/__tests__/electron-cli-early-i18n.test.ts`
- `scripts/__tests__/macos-focus-probe.test.ts`

## 自测命令与真实结果

最终代码状态执行：

- `bun run test`：退出码 0；主测试及全部 isolated suites 均通过，无失败。
- `bun run typecheck:all`：通过。
- `bun run lint:shared`：通过，0 errors、9 warnings。
- `bun run lint:electron`：通过，0 errors、114 warnings。
- `bun run lint:i18n:parity`：通过，6 locales、每个 1642 keys。
- `bun run lint:i18n:sorted`：通过。
- `bun run lint:i18n:coverage`：通过。
- `bun run test:doc-tools`：20 tests passed。
- `bun run electron:build`：通过；CLI/server artifacts 版本 `0.10.0`。
- `bun run electron:validate:cli:runtime`：通过；packaged server discovery、自相对 symlink launcher、含空格和非 ASCII 路径均通过。
- `bun test scripts/__tests__/prepare-platform-runtime.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts`：15 passed、0 failed。
- `node --check apps/electron/scripts/afterPack.cjs`：通过。
- `bash -n apps/electron/scripts/validate-final-artifacts.sh`：通过。
- workflow YAML 使用 Ruby YAML parser 解析：通过。
- `git diff --check`：通过。

构建过程中真实发现并修复两项门禁问题：

1. 第一次正式 dist 在 native uv version 检查处失败，因为官方输出携带 build suffix；修复严格 parser 并补测试后重跑。
2. 第一次显式 final-container smoke 发现 electron-builder 会重新签名 nested uv，导致签名前 manifest hash与签名后文件 hash不同；改为 pinned source hash + 最终平台签名 + version 三重契约后重跑。

## 最终 macOS arm64 产物证据

- 构建命令：`bun run electron:dist:dev:mac --arch=arm64`
- 结果：退出码 0；electron-builder 的 afterAllArtifactBuild 门禁自动完成 DMG/ZIP 最终容器 smoke。
- 构建时代码 HEAD：`cabb49d08c1443dcc468f7ed604c6bc12d09e607`；本报告与 release note 随后单独提交，不改变已打包代码。
- App/CLI 版本：`0.10.0`
- uv：`0.10.6`，运行输出 `uv 0.10.6 (a91bcf268 2026-02-24)`；nested code signature 验证通过。
- DMG：
  - 路径：`apps/electron/release/Polo-AI-arm64.dmg`
  - 大小：278,459,443 bytes
  - SHA-256：`c838f896b18ea79ae845c741b6f5f1928f56f88e22f836a77f3af2d1114a4427`
  - mtime：`2026-07-30T15:45:04-0700`
- ZIP：
  - 路径：`apps/electron/release/Polo-AI-arm64.zip`
  - 大小：268,791,137 bytes
  - SHA-256：`dbf3b09bcf0478456ab99a6556192951b56e6878c197817969aba7f32ff4a363`
  - mtime：`2026-07-30T15:45:35-0700`
- 构建完成后再次显式执行：
  `bun run electron:validate:artifacts:unix -- --mode smoke --release-dir apps/electron/release --arch arm64`
  结果：`DMG final-container CLI smoke passed (0.10.0)`、`ZIP final-container CLI smoke passed (0.10.0)`。

## 现场清理检查

- `ps` 未发现本 worktree 相关 Electron、Polo server 或 mock provider 进程。
- `lsof -nP -iTCP -sTCP:LISTEN` 未发现 Polo/Bun/Electron 相关监听端口。
- 未发现 `polo-server-smoke-*`、`polo-run-server-*`、`polo-final-artifact.*`、`polo-artifact-e2e-*`、`polo-cli-runtime-*` 临时目录。
- 未发现用户 runtime discovery 文件 `~/.polo-ai/runtime/electron.json`。
- 清理了本轮用于计算/核验 uv 六平台 archive/binary hash 的两个已确认临时目录（约 484 MiB）。

## 遗留/外部环境事项

- 当前 macOS arm64 宿主不能原生执行 Windows NSIS、PowerShell ownership/Authenticode 生命周期，也不能执行 Linux AppImage/Xvfb 生命周期；未声称这些原生 E2E 已在本机通过。
- 仓库必须先提供一个真实、版本不同、包含 macOS x64 ZIP、Windows x64 NSIS、Linux x64 AppImage 和对应历史 Unix installer 的 immutable release，并将 tag、full commit SHA、版本及各 SHA-256 配置到 workflow inputs/repository vars。随后由正式 release/nightly matrix 产出三平台 `verified-contract`、full logs 与安装/升级/discovery/focus/run/sessions/uninstall 成功证据。
- 当前唯一 `v0.11.0` tag 的内部 Electron version 与 HEAD 同为 `0.10.0`，因此按批准裁决必须拒绝，不能用作升级证明。
