# POO-16 Reviewer 第 2 轮修复报告

## 处理结果

### 1. 打包 fresh install 缺少默认资源

- `createConfigurationSnapshot()` 现在优先从 `<POLO_AI_BUNDLED_ASSETS_ROOT>/resources` 解析资源，匹配 packaged server launcher 的 distribution root 约定。
- 仍保留 `<root>/apps/electron/resources` 的 source-tree 路径和本仓库源码 fallback，兼容现有开发入口。
- 新增 empty config + 模拟 packaged distribution 回归，验证 `config-defaults.json` 和 `permissions/default.json` 都从 `resources/` 写入私有快照。

### 2. abandoned Thread 的 owner sidecar symlink

- `repairAbandonedCliThread()` 在读取已存在的 `owner.json` 前执行 canonical controlled-root 校验。
- owner sidecar 若为指向 CLI root 外的 symlink，修复流程立即失败关闭，不读取外部 owner 数据，也不改变 Thread 状态。
- 新增 symlink-owner 回归，验证外部内容未被采用，`thread.json` 仍未写入 `interrupted`。

## 关键文件

- `apps/cli/src/one-shot.ts`
- `apps/cli/src/one-shot.test.ts`
- `apps/cli/src/cli-thread-store.ts`
- `apps/cli/src/cli-thread-store.test.ts`

## 实际测试

- `bun test apps/cli/src/one-shot.test.ts apps/cli/src/cli-thread-store.test.ts`
  - 29 pass，0 fail。
- `bun run --cwd apps/cli typecheck`
  - 通过。
- `bun run test`
  - 通过（包含 isolated 测试）。
- `bun run typecheck:all && bun run server:build:subprocess`
  - 通过；session MCP 390 modules / 4.58 MB，Pi agent 3999 modules / 20.41 MB。
- `git diff --check`
  - 通过。

## 遗留问题

- 两项 reviewer blocker 均无已知遗留。
- 未触碰 `.task/session-analysis/` 未跟踪内容。
