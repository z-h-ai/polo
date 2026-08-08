# POO-29 第 4 轮修复报告

## 本轮处理

- 发布 RPC 明确归类为 `LOCAL_ONLY`，并补远程 workspace 路由验证。
- Python payload 统一为 Electron 运行时所需的 `pyproject.toml + uv.lock`，不再将仅有 `requirements.txt` 视为可运行产物。
- ZIP central directory 和 payload 正确保留显式目录项；共同外层目录会在忽略目录项后剥离，空目录不会与实际文件冲突。
- 多入口按钮直接把 candidate 传入 publish 调用，避免 React state 尚未提交时遗漏 `selectedEntry`。
- ZIP 解压前限制继续覆盖压缩比 bomb，并补显式目录/空目录回归。

## 测试

- `bun test packages/shared/src/admin/__tests__/creator-app-publishing.test.ts`：10 pass。
- `bun test packages/server-core/src/handlers/rpc/admin.test.ts packages/server-core/src/services/creator-app-publications.test.ts`：29 pass。
- `bun test packages/shared/src/protocol/__tests__/routing.test.ts apps/electron/src/transport/__tests__/routed-client.test.ts`：29 pass。
- `bun run typecheck:all`：通过。
- `NO_COLOR=1 bun run test`：完成并通过；未复现 `mode-manager.test.ts` 无期限占用。

## 遗留问题

组织共享的最终平台发布仍需 Polo Admin 服务端提供组织级持久化与 Catalog 写入端点；该服务不在本 worktree。本地持久化不能替代该平台边界。
