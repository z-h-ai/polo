# POO-16 实现报告

## 变更摘要

本轮从当前 HEAD `bf0c64ec` 继续，没有重新实施、回退或丢弃已有变更。按照独立 reviewer 报告 `.pipeline/review-report-independent-bf0c64ec.json`，以“最小完整方案”关闭四项运行时、并发与崩溃一致性阻塞：

1. 进程出生身份查询移除 `Bun.spawnSync`，统一使用 `node:child_process.spawnSync`；真实 Node/Electron runtime 不再因缺少全局 Bun 而让 credential `set`、`delete`、CAS 失败。
2. credential writer lock 改为完整私有 claim 文件加原子 hard-link 发布。正式锁从出现第一刻就包含 `lockId`、PID、进程出生身份与创建 generation；竞争者无法观察或接管半发布 owner。ownerless/malformed legacy 锁不再按 mtime 接管，而是 fail closed；只有确认进程死亡或 PID 复用时才能移动旧锁。heartbeat 使用 lockId 隔离 sidecar，迟到 heartbeat 和 release 都不能覆盖或删除新锁。
3. Anthropic OAuth 按 `llm_oauth::<connectionSlug>` 获取独立跨进程 refresh lease。lease 内绕过 invocation overlay 和进程缓存重新读取共享 generation；只有仍过期的同一 identity 才发起 HTTP refresh，成功替换与 `invalid_grant` 清理继续受 CAS 保护。不同 connection identity 不共享锁。
4. credential mutation 改为 copy-on-write。`set`、`delete`、同步 delete 和 CAS 都修改 store 副本；只有临时文件 fsync、原子 rename 和目录持久化成功后才发布新缓存。任何保存失败都会丢弃缓存并重新以磁盘文件为准。

此前 `bf0c64ec` 已完成的配置快照 allowlist、OAuth identity 统一、三平台 CLI 安装入口、`credentials.enc` 原子替换等修复均保留。

## 关键文件

- `packages/shared/src/utils/process-identity.ts`
  - Node/Electron/Bun 通用的进程出生身份查询。
- `packages/shared/src/credentials/backends/secure-storage.ts`
  - 原子文件 lease、安全接管、lockId heartbeat、identity-scoped lease 与 credential copy-on-write。
- `packages/shared/src/credentials/backends/types.ts`、`packages/shared/src/credentials/manager.ts`
  - fresh persisted read 和跨进程 scoped lease 契约；invocation overlay 与共享 credential generation 分离。
- `packages/shared/src/auth/state.ts`
  - OAuth refresh lease、lease 内共享 generation 重读、CAS 刷新与清理。
- `packages/shared/src/credentials/__tests__/secure-storage-write-lock.test.ts`
  - 原子 claim 发布暂停、legacy ownerless fail-closed、真实 Node runtime、同实例 rename 失败缓存一致性等回归。
- `packages/shared/src/auth/__tests__/state.test.ts`
  - 两个独立进程确定性复现并验证“成功者刷新、失败者 invalid_grant”反序竞争。
- `packages/shared/src/credentials/__tests__/fixtures/secure-storage-node-worker.ts`
  - 无全局 Bun 的 Node runtime credential set/CAS/delete 探针。
- `packages/shared/src/auth/__tests__/fixtures/oauth-refresh-worker.ts`
  - 跨进程 OAuth refresh lease 竞争探针。

## 验证结果

- 四项专项及相邻回归：42 pass，0 fail。
- auth/credential 广泛回归：144 pass、6 skip、0 fail。
- `NO_COLOR=1 bun run test`
  - 普通全量：4901 pass、19 skip、0 fail，381 files。
  - 仓库全部 `*.isolated.ts` 测试通过。
- `NO_COLOR=1 bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过。
- 变更 shared 文件 ESLint
  - 通过，0 error。
- `NO_COLOR=1 bun run server:build:subprocess`
  - Session MCP：390 modules / 4.58 MB；Pi Agent：3999 modules / 20.41 MB。
- `NO_COLOR=1 bun run electron:build`
  - CLI/server/main/preload/renderer/resources/assets 全部成功，packaged CLI artifacts `0.10.0` 验证通过。
- macOS arm64 Electron directory assembly
  - `electron-builder --mac dir --arm64` 成功；afterPack 验证 `polo` 与 `polo-ai`。
- `git diff --check` 与变更文件 ESLint通过。

## 验证环境说明

- macOS arm64 assembly 完成后，已清理本轮生成且被 Git ignore 的 `apps/electron/release/mac-arm64`，避免递归全量测试发现 app bundle 内复制的测试源码。
- Node runtime 回归使用真实 `node --experimental-strip-types` 子进程，并确认 `globalThis.Bun` 不存在时 credential set/CAS/delete 全部工作。
- 当前环境没有真实 Windows 或 Linux 主机；本轮未重新执行 Windows NSIS 和 Linux AppImage 实机安装。此前三平台 packaged layout/installer 契约回归仍保持通过。

## 遗留问题

- 本轮四项独立 review 阻断范围内无已知遗留问题，尚待新的独立 reviewer 重新裁决。
- 未执行签名证书、notarization、DMG、NSIS 或真实 Linux AppImage/FUSE 安装。
- 用户已有 `.task/session-analysis/` 及 `.pipeline/fix-report-round1.md`、`.pipeline/fix-report-round2.md` 的删除状态保持未触碰，不纳入本轮提交。
