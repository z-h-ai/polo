# POO-16 实现报告

## 变更摘要

本轮从当前 HEAD `f585c806` 继续，没有重新实施、回退或丢弃已有变更。针对 Ultra-Coding review 升级的五项 P0 安全/架构缺口完成修复：

1. CLI 配置快照改为显式 allowlist，仅复制 `config.json`、`sources/`、`skills/`、`statuses/`、`labels/`、`.claude-plugin/` 与 `permissions.json` 等运行时输入；global scope 始终重建最小 manifest。`automations.json`、history、messaging、retry queue、views、应用连接状态及其中的 bearer/basic/Authorization secret 不再进入持久 Thread。
2. Anthropic OAuth 从读取、刷新到失败清理都只使用 `llm_oauth::<connectionSlug>`。移除 CLI 链路对 `claude_oauth::global` 的读取、双写和双删；进程内 refresh mutex 也按 connection slug 隔离。
3. OAuth token 轮换增加跨进程 compare-and-swap：旧刷新者不能覆盖或删除另一进程已经写入的新 token，刷新仅原子更新同一 credential identity。
4. macOS/Linux/Windows 安装器均交付 `polo` 与 `polo-ai` 两个同实现 CLI 入口，并拒绝覆盖非 Polo 管理的命令。macOS 使用指向已安装 app bundle 的用户 PATH symlink；Linux 挂载 AppImage 后直接调用包内 CLI launcher，GUI 改由 `polo-gui` 显式启动；Windows 两个 `.cmd` 均调用安装目录内的 `polo.cmd`，GUI 同样使用 `polo-gui.cmd`。
5. `credentials.enc` 改为同目录唯一 `0600` 临时文件、文件 fsync、原子 rename 及 Unix 父目录 fsync。写入或 rename 失败保留旧 store；不可解密文件不再自动删除，且拒绝被后续写入静默覆盖。
6. credential writer lock 改为原子 lock directory，记录 `lockId`、PID、进程出生身份与 heartbeat。活进程不会因 mtime 或系统休眠被接管；仅确认 owner 已死亡或 PID 复用时才能原子移走旧锁；释放前校验 `lockId`，旧 owner 无法删除新锁。同步 credential 删除也进入同一锁协议。

## 关键文件

- `apps/cli/src/one-shot.ts`、`apps/cli/src/one-shot.test.ts`
  - workspace/global 配置快照 allowlist 与 secret 负向回归。
- `packages/shared/src/auth/state.ts`、`packages/shared/src/auth/__tests__/state.test.ts`
  - connection-scoped Anthropic OAuth、按 identity 的 refresh mutex、刷新成功/失败隔离回归。
- `packages/shared/src/credentials/manager.ts`
  - invocation overlay 对齐及 OAuth compare-and-swap 入口。
- `packages/shared/src/credentials/backends/secure-storage.ts`
  - 跨进程 owner lock、heartbeat、安全接管、原子凭据写入及损坏文件保留。
- `packages/shared/src/credentials/backends/types.ts`
  - credential backend compare-and-swap 契约。
- `packages/shared/src/credentials/__tests__/secure-storage-write-lock.test.ts`
  - 三实例并发、活 owner 超时、死亡 owner 接管、旧 owner 迟到释放、rename 失败与 stale OAuth writer 回归。
- `scripts/install-app.sh`、`scripts/install-app.ps1`、`scripts/install-cli-entrypoints.test.ts`
  - 三平台双 CLI 入口、用户 PATH、GUI 显式入口与命令所有权保护。

## 验证结果

- 专项回归：69 pass，0 fail。
  - 覆盖 workspace/global secret 排除、connection-scoped OAuth、刷新成功/瞬时失败/invalid_grant、原子写失败、活 owner/system-suspend 等价场景、死亡 owner 接管、旧 owner 迟到释放、三个独立进程并发、stale token CAS 与三平台安装入口。
- `NO_COLOR=1 bun test`
  - 4897 pass、19 skip、0 fail，381 files。
- `NO_COLOR=1 bun run test`
  - 普通全量测试及仓库全部 13 个 `*.isolated.ts` 测试通过。
- `NO_COLOR=1 bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过。
- 变更 shared 文件 ESLint
  - 通过，0 error。
- `NO_COLOR=1 bun run server:build:subprocess`
  - Session MCP：390 modules / 4.58 MB；Pi Agent：3999 modules / 20.41 MB。
- `NO_COLOR=1 bun run electron:build`
  - CLI/server/main/preload/renderer/resources/assets 全部构建成功，packaged CLI artifacts `0.10.0` 验证通过。
- macOS arm64 Electron directory assembly
  - `electron-builder --mac dir --arm64` 成功；afterPack 验证 `polo` 与 `polo-ai`。
  - 从 `/`、干净 PATH、安装式 symlink 启动两个入口，均输出 `0.10.0`。
- `bash -n scripts/install-app.sh`、`git diff --check`
  - 均通过。

## 验证环境说明

- macOS arm64 assembly 完成并验证后，已清理本轮生成且被 Git ignore 的 `apps/electron/release/mac-arm64`。若保留该目录，仓库根部递归 `bun test` 会再次发现 app bundle 内复制的测试源码并产生验证污染；清理后标准全量门禁通过。
- 当前环境没有 PowerShell，因此 Windows installer 使用契约回归与 Windows packaged launcher layout 回归验证；未执行真实 Windows NSIS 安装。

## 遗留问题

- 本轮五项 review 阻断范围内无已知遗留问题。
- 未执行签名证书、notarization、DMG、NSIS 或真实 Linux AppImage/FUSE 安装；macOS arm64 directory assembly 与三平台 packaged layout 已验证。
- 用户已有 `.task/session-analysis/` 及 `.pipeline/fix-report-round1.md`、`.pipeline/fix-report-round2.md` 的删除状态保持未触碰，不纳入本轮提交。
