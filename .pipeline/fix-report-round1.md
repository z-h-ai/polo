# POL-51 第 1 轮修复报告

## 变更摘要

本轮已修复 Reviewer 指出的 Catalog 异常 `304 Not Modified` 授权回退漏洞：

1. 非强制 Catalog 同步只有在持久化缓存仍为 `authorized`，且当前进程内 access mode 不为 `denied` 时，才携带 `appConfigVersion` 发起条件请求。
2. 收到 304 后，在 session CAS 内重新读取当前 Catalog 缓存与进程内 access mode，并同时校验：
   - 请求不是 force refresh；
   - 请求实际携带了 `appConfigVersion`；
   - 当前缓存仍为 `authorized`；
   - 当前缓存版本与已发送版本严格一致；
   - 当前进程内 access mode 未进入 `denied`。
3. 任一条件不满足时保持 fail closed：建立/维持 denied gate，返回稳定的 `SERVER_ERROR` 和去能力化 denied Catalog 投影，不恢复 online，也不泄露 `remoteUrl`、Release 下载字段或 `trustedReleases`。
4. 增加确定性 production-wiring 回归测试，覆盖“明确失权后 denied 缓存持久化因 disk full 失败，旧 authorized 缓存仍存在，随后服务端异常返回 304”的完整链路。
5. 增加 handler 级竞态测试，覆盖条件请求已经发出后、304 返回前进程内 access mode 转为 denied 的场景。

## Review 阻断问题修复结果

- **问题：旧 authorized 缓存可能在 denied 持久化失败后通过 304 重新开放授权**
  - 结果：已修复。
  - 条件请求资格现在同时受持久化授权状态和进程内 denied gate 约束。
  - 304 提交前会在可信 session CAS 内重新校验缓存、版本和 gate。
  - 异常 304 只返回清洗后的 denied 投影，授权状态保持 denied。

## 关键文件

- `packages/server-core/src/handlers/rpc/admin.ts`
  - 收紧条件请求资格。
  - 合并并强化 304 提交时的授权复核与 fail-closed 响应。
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 新增 304 返回前 access mode 被 deny 的竞态回归测试。
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
  - 新增 NOT_FOUND、denied 缓存写入 disk full、随后异常 304 的 production-wiring 回归测试。

## 自测结果

- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 通过：58 pass，0 fail，321 expect。
- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`
  - 通过：21 pass，0 fail，163 expect。
- `cd packages/server-core && bun run typecheck`
  - 通过。
- `cd apps/electron && bun run typecheck`
  - 通过。
- `bun run test`
  - 通过：项目标准测试与逐文件 isolated 测试全部退出码 0；新增 production-wiring 测试包含在全量复跑中。
- `bun run validate:ci`
  - 通过：全包 typecheck、shared/doc smoke tests、6 个 locale 的 parity/sorted/coverage 检查全部通过。
- `bun run electron:build:main`
  - 通过：Electron main process 构建完成并通过产物校验。
- `git diff --check`
  - 通过。

## 遗留问题

本轮 Review 阻断项范围内无遗留问题。
