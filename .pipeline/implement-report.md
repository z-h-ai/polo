# POO-16 实现报告

## 变更摘要

本轮从当前 HEAD `2f15cf0a` 继续，没有重新实施、回退或丢弃已有变更。按照独立 reviewer `46e286e3-58bc-4a96-a52f-147db874ce1e` 的退件和 2026-08-04 人工裁决完成最小完整修复：

1. 人工裁决允许共享配置工作区中 `sources/`、`skills/` 已存在的 header、env、OAuth client secret 等配置值进入权限受控的 `config-snapshot/`。配置快照仍采用显式 allowlist，排除 automations、history、messaging、views 等无关应用状态；命令行显式传入的 API key、token 和 Authorization header 仍不得进入配置快照、session、Thread metadata、JSONL 或日志。
2. credential writer lock 新增内核所有权层：macOS/Linux 使用 `flock`，Windows 使用 named mutex。进程正常退出、崩溃或 SIGKILL 后由内核释放所有权；当前版本进程先持有 native lock，再进入原 identity-bearing file claim，兼容旧版本进程的同时消除多个 current writer 并发接管 dead-owner lock 的 TOCTOU。
3. `exec resume --help`、`exec sessions --help`、`exec delete --help` 改为 command-aware 帮助，只展示各自支持的参数。管理子命令接收 execution-only 参数仍先报错并退出 2，不能用 `--help` 绕过校验。
4. CLI/server bundle 将 `koffi` 保持为外部 native 依赖；macOS、Linux、Windows 安装包都显式携带 Koffi。afterPack layout 验证新增 package loader 和目标平台 native binary 检查，避免只在源码环境可用。

## 关键文件

- `packages/shared/src/credentials/backends/native-write-lock.ts`
  - POSIX `flock`、Windows named mutex、异步/同步超时获取与幂等释放。
- `packages/shared/src/credentials/backends/secure-storage.ts`
  - native lock correctness boundary 与 legacy claim 兼容屏障组合。
- `packages/shared/src/credentials/__tests__/secure-storage-write-lock.test.ts`
  - 48 个 dead-owner reclaimers 单赢家竞争、存活 owner 阻塞、SIGKILL 后自动释放等回归。
- `apps/cli/src/one-shot.ts`、`apps/cli/src/execution-parser.ts`
  - 配置快照裁决边界和 command-aware help 路由。
- `apps/electron/electron-builder.yml`、`apps/electron/scripts/packaged-cli-layout.cjs`
  - 三平台 native dependency 交付与 afterPack 验证。
- `spec-polo-run-exec.md`
  - 记录受控配置快照允许保留共享 source/skill 配置值的人工裁决。

## 验证结果

- credential native/legacy writer lock 专项：11 pass，0 fail。
- CLI parser/index/one-shot 专项：35 pass，0 fail。
- auth/credential/CLI/package 广泛回归：194 pass、6 skip、0 fail。
- packaged CLI layout（含三平台 Koffi 缺失拒绝）：12 pass，0 fail。
- `NO_COLOR=1 bun run test`
  - 普通全量：4903 pass、19 skip、0 fail，381 files。
  - 仓库全部 `*.isolated.ts` 测试通过。
- `NO_COLOR=1 bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过。
- 变更 shared 文件 ESLint：通过，0 error。
- `NO_COLOR=1 bun run server:build:subprocess`
  - Session MCP：390 modules / 4.58 MB；Pi Agent：3999 modules / 20.41 MB。
- `NO_COLOR=1 bun run electron:build`
  - CLI/server/main/preload/renderer/resources/assets 全部成功，packaged CLI artifacts `0.10.0` 验证通过。
- macOS arm64 Electron directory assembly
  - `electron-builder --mac dir --arm64` 成功；afterPack 验证 `polo`、`polo-ai` 和 Koffi native payload。
  - 从 `/` 和最小环境运行包内 `polo --version`、`polo-ai --version`、`polo exec sessions --json` 均退出 0，版本为 `0.10.0`。
- `git diff --check`：通过。

## 验证环境说明

- 第一次全量测试出现一个与本变更无关的 local-app process-tree 时序失败，单测立即重跑通过；最终干净全量运行通过。
- 另一次全量运行与 macOS assembly 并发，仓库脚本扫描到生成的 `.app` 内复制测试文件并因路径空格退出；清理精确生成目录后，最终全量运行通过。
- macOS arm64 assembly 和 smoke 完成后，已清理本轮生成且被 Git ignore 的 `apps/electron/release/mac-arm64` 与临时 HOME。
- 当前环境没有真实 Windows 或 Linux 主机；Windows named mutex 由类型检查、契约测试和三平台 packaged layout 覆盖，未执行 Windows/Linux 实机运行。

## 遗留问题

- 本轮人工裁决和其余退件范围内无已知遗留问题，尚待新的独立 reviewer 重新裁决。
- 未执行签名证书、notarization、DMG、NSIS 或真实 Linux AppImage/FUSE 安装。
- 用户已有 `.task/session-analysis/` 及 `.pipeline/fix-report-round1.md`、`.pipeline/fix-report-round2.md` 的删除状态保持未触碰，不纳入本轮改动。
