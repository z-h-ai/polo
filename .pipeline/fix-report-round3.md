# POO-14 第 3 轮 Reviewer 修复报告

## 变更摘要

本轮闭合 `.pipeline/review-report-round3.json` 的唯一 blocking issue：

- 新增单一、anchored、跨 JavaScript/Bash/.NET regex 兼容的 SemVer 2.0.0 pattern 文件。
- persisted previous-release validator、Unix preflight、Windows preflight 和正式 full workflow 均读取该 pattern，不再各自维护宽松或不同的正则。
- validator 分别校验 `tag`、`expectedVersion`、`resolvedVersion`、`currentVersion`，再执行 resolved/expected 与 previous/current 差异检查。
- Unix/Windows preflight 也对从旧 tag 读取的 resolved version 和当前 Electron version 做严格 SemVer 校验。
- 补充合法 prerelease/build、core 与 numeric prerelease 前导零、空 identifier、连续点、非法分隔符、尾缀的直接 validator/preflight 回归，以及 workflow 单一 pattern 来源的防漂移契约。

代码提交：

- `7a026f3 POO-14: 统一 previous release SemVer 契约`

## Blocking issue 处理结果

### 单一严格 SemVer 2.0.0 契约

处理结果：

1. `scripts/strict-semver-pattern.txt` 是四类消费者的唯一 regex 来源。表达式同时具备 `^`/`$` 锚定，并遵守 SemVer 2.0.0 的 core、prerelease 与 build identifier 规则。
2. `scripts/strict-semver.ts` 读取同一 pattern，提供 `isStrictSemver` 与带且仅带一个 `v` 前缀的 `parseStrictSemverTag`。
3. `scripts/validate-previous-release-contract.ts` 不再使用旧 `\d+` 宽松 pattern：
   - 合法 `v0.9.0-rc.1+build.7` 可通过；
   - `v01.2.3`、`v1.2.3-01`、空 identifier、连续点、非法分隔符及尾缀均在任何 artifact hash/lifecycle 写入前拒绝；
   - `expectedVersion`、`resolvedVersion`、`currentVersion` 分别独立校验，非法字段不会被模糊成 version mismatch。
4. `scripts/preflight-previous-release.sh`、`scripts/preflight-previous-release.ps1` 和 `.github/workflows/electron-artifact-full.yml` 均读取同一个 pattern 文件。workflow 同时在 setup/install 前校验 tag 与 pinned previous version。
5. workflow contract test 明确断言 Unix、Windows、workflow、TypeScript validator 都引用该单一文件，并拒绝重新引入 inline regex，防止四处规则再次漂移。

## 关键文件

- `scripts/strict-semver-pattern.txt`
- `scripts/strict-semver.ts`
- `scripts/validate-previous-release-contract.ts`
- `scripts/preflight-previous-release.sh`
- `scripts/preflight-previous-release.ps1`
- `.github/workflows/electron-artifact-full.yml`
- `scripts/__tests__/previous-release-contract.test.ts`
- `scripts/__tests__/previous-release-preflight.test.ts`
- `scripts/__tests__/electron-artifact-pipeline.test.ts`
- `apps/electron/resources/release-notes/next.md`

## 自测命令与真实结果

### 针对性回归

```bash
bun test scripts/__tests__/previous-release-contract.test.ts \
  scripts/__tests__/previous-release-preflight.test.ts \
  scripts/__tests__/electron-artifact-pipeline.test.ts
bash -n scripts/preflight-previous-release.sh
ruby -e 'require "yaml"; YAML.safe_load(File.read(".github/workflows/electron-artifact-full.yml"), aliases: true)'
git diff --check
```

结果：

- targeted suites：`21 pass / 0 fail / 406 expect()`。
- 合法 `0.9.0-rc.1+build.7` 在 parser、tag、四个 version fields 和 Unix preflight 中通过。
- 非法 core 前导零、numeric prerelease 前导零、空 identifier、连续点、非法分隔符、尾缀在 validator 与 Unix preflight 中拒绝。
- Bash syntax、workflow YAML parse 与 whitespace gate 均通过。
- 本机未安装 `pwsh`，因此没有声称运行 Windows PowerShell native preflight；其 pattern 来源和调用方式由 workflow/fixture 静态契约覆盖。

### 全量门禁

```bash
bun run test
bun run typecheck:all
bun run lint:shared
bun run lint:electron
bun run lint:i18n:parity
bun run lint:i18n:sorted
bun run lint:i18n:coverage
bun run test:doc-tools
bun run electron:build
bun run electron:validate:cli:runtime
git diff --check
```

真实结果：

- `bun run test`：退出码 0。
  - 主套件：`4917 pass / 19 skip / 0 fail / 12383 expect()`，380 files。
  - server concurrency、file-lock races、CLI server spawner、Electron/UI isolated suites全部通过。
- `bun run typecheck:all`：通过。
- `bun run lint:shared`：退出码 0，`0 errors / 9 warnings`；均为既有 warning。
- `bun run lint:electron`：退出码 0，`0 errors / 114 warnings`；均为既有 warning。
- i18n parity：通过，6 locales、每个 1642 keys；sorted 与 coverage 均通过。
- doc-tools：`23 tests passed`。
- Electron build：通过；CLI/server/main/preload/renderer/resources 均构建成功，sanitized CLI artifact 版本 `0.10.0`。
- packaged runtime validation：通过；packaged server discovery、自相对 symlink launcher、空格与非 ASCII 路径均通过。
- `git diff --check`：通过。

## 残留检查

- 测试与构建完成后未发现本 worktree 相关的 Electron、Polo server、mock provider 或 CLI 子进程。
- 检查发现一份 09:21 产生、无关联进程的旧 `polo-real-run-usage.gNOlMc` fixture 目录；已按其精确路径移入废纸篓。复查未发现 `polo-run-server-*`、`polo-artifact-e2e-*` 或 previous-release fixture 临时目录。
- 本轮只修改 previous-release contract/build workflow 源码，不执行安装/PATH/App lifecycle 写入。

## 遗留 external evidence

- 本轮在 macOS arm64 宿主完成源码全量门禁、Electron build 与 packaged runtime validation；未声称执行 Windows native PowerShell/NSIS full 或 Linux AppImage/Xvfb full。
- 本轮未重建 DMG/ZIP：SemVer contract 文件和 workflow 不进入 Electron App 容器，既有 development artifact 不能作为 production release evidence。
- 真实 release acceptance 仍需要正式三平台 runner、可信且版本不同的 previous release assets、Apple/Windows 生产签名与公证 secrets，输出 verified contract、artifact hashes 以及 install/upgrade/discovery/run/sessions/uninstall full logs。
- 仓库的 full fail-fast、previous-release provenance、精确签名 identity 与 notarization/stapling 契约均未放宽；本报告不虚报外部 runner、production signature 或 previous-to-current lifecycle 结果。
