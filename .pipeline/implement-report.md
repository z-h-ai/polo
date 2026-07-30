# POL-51 实现报告

## 变更摘要

- 单 App 撤下的 deny gate 现在保持到当前进程结束，不再随停止／取消清理完成而自动释放。Catalog 新缓存写入失败时，即使旧授权缓存仍可读取，`START`、`RESTART` 和 `INSTALL` 仍统一返回 `NOT_AUTHORIZED`。
- 只有后续成功 Catalog 同步明确重新包含 App、且新缓存已提交后，才释放对应完整 scope 的 deny gate；清理仍在运行时延后释放，并以 App lifecycle generation 防止迟到授权覆盖再次撤下。
- AdminClient 增加统一 15 秒有界超时，单一 deadline 同时覆盖 `fetch` 建连、响应头和 `response.text()`。超时会中止请求并稳定映射为 `TIMEOUT`，Catalog 将其作为临时故障进入受限离线缓存回退。
- `readPersistedScopes` 改为固定 8 worker 的有界读取，并在读取 `scope.json` 获得身份后立即按账号／组织／App 过滤，再进入 metadata 和 manager I/O。10,000 scope 扫描不会无上限并发，也不会物化不相关账号／组织的 manager。
- 安装依赖进程增加受控启动 observer；安装取消、shutdown-retain 和 install-uninstall-retain 测试通过进程阶段事件与文件事件同步，不再依赖 2 秒墙钟轮询。
- 未新增 renderer 用户文案；现有 i18n parity、排序和覆盖检查保持通过。

## 关键文件列表

- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/types.ts`
- `packages/shared/src/admin/__tests__/client.test.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `packages/server-core/src/handlers/handler-deps.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/local-app-runtime/manager.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/scoped-registry.test.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts`
- `apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`

## 自测结果

- `bun test`：4800 pass、19 skip、0 fail（4819 tests / 365 files）。
- 全部 19 个 `*.isolated.ts` 文件逐一执行：全部通过。
- AdminClient、scoped registry、manager 三个目标测试连续复跑 3 次：每轮 78 pass、0 fail。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`：50 pass、0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`：12 pass、0 fail。
- `bun run typecheck:all`：通过。
- `bun run electron:build:main`：通过。
- `bun run lint:electron`：0 error；保留仓库既有 warning。
- 变更涉及的 shared Admin 文件单独 ESLint：通过。
- `bun run lint:i18n:parity`、`bun run lint:i18n:sorted`、`bun run lint:i18n:coverage`：全部通过。
- `git diff --check`：通过。

新增确定性回归覆盖：

- Catalog 撤下 App 后缓存写入失败：旧缓存仍在时，公开 `START`、`RESTART`、`INSTALL` 全部 fail closed，且不创建 runtime manager。
- App 清理完成后 deny gate 仍保留；只有成功授权提交调用 `authorizeApps` 后才恢复访问。
- fetch 永久挂起和 response body 永久挂起均在 deadline 后返回 `TIMEOUT`；正常请求完成后计时器不再触发 abort。
- `TIMEOUT` 与 `NETWORK_ERROR` 都保留最后可信 Catalog，并进入 restricted offline。
- 10,000 条持久化 scope 扫描最大同时读取数不超过 8，只创建目标账号／组织中实际安装记录的 manager。
- 依赖安装器阶段通过 observer 和文件事件确定性到达后再触发取消、shutdown 或 uninstall。

## 遗留问题

- 未连接真实 POL-52 服务与生产签名 Bundle 做端到端联调；本轮使用 production wiring、真实 scoped registry、全量单测、全部 isolated 测试和 Electron main production build 验证。
- 聚合 `bun run lint` 当前因仓库缺少 `scripts/check-raw-sends.sh` 在第一步退出；`lint:shared` 还存在与本任务无关的 5 个既有 source-auth 规则错误。本次变更文件已通过可用的针对性 ESLint。
