# POO-14 Review 第 2 轮修复报告

## 处理结果

### 1. 共享配置与凭据并发更新丢失

已修复。

- 为共享配置和 secure credential storage 分别增加跨进程事务锁：
  - `.config.transaction.lock`
  - `.credentials.transaction.lock`
- 两类锁均覆盖完整的“重新读取 → 修改/合并 → 持久化”流程，没有复用临时 server 的 `.server.lock`。
- 配置和凭据写入均改为同目录唯一临时文件、`fsync`、原子替换，并保持 `0600` 权限。
- credential mutation 不再依赖进程内缓存；每次锁内操作都会重新读取磁盘状态。
- 锁通过持有者 PID 和 nonce 识别所有权；异常抛出时在 `finally` 中释放，进程异常退出遗留的死锁可由后续进程检测并恢复。
- 所有生产配置 mutation helper 已改为事务式更新；Electron 和 headless server 的初始化、tab-browser 写入也使用相同事务边界。
- 新增真实双临时 server 并发集成覆盖：两个 server 共享用户配置，同时创建不同 workspace、连接和凭据；断言双方更新全部保留、配置在并发期间始终可解析、权限正确、事务锁和临时文件清理完成，并可分别停止和清理各自 runtime。
- 保留上一轮临时 server 独立 runtime/lock、随机端口/token、stale discovery 回退和 discovery 清理阶段边界。

### 2. 终端功能状态硬编码英文

已修复。

- main process 不再返回直接展示的英文 `message`，改为稳定的 `statusCode`、`statusParams` 和结构化 `conflict`。
- renderer 统一通过 `t()` 将状态码映射为本地化文案。
- 补齐 `de`、`en`、`es`、`hu`、`ja`、`pl`、`zh-Hans` 全部现有 locale。
- 安装冲突改为结构化结果返回，首次引导和设置页仍保持现有成功门控及显式操作边界。
- 新增所有状态码、所有 locale 的 renderer 测试，并验证中文冲突状态不会混入英文文案。

## 关键文件

- `packages/shared/src/utils/files.ts`
- `packages/shared/src/utils/__tests__/files.test.ts`
- `packages/shared/src/config/storage.ts`
- `packages/shared/src/credentials/backends/secure-storage.ts`
- `packages/server-core/src/bootstrap/headless-start.ts`
- `apps/cli/src/server-spawner.isolated.ts`
- `apps/electron/src/main/terminal-integration.ts`
- `apps/electron/src/main/terminal-onboarding.ts`
- `apps/electron/src/main/index.ts`
- `apps/electron/src/main/handlers/tab-browser.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/renderer/lib/terminal-integration-status.ts`
- `apps/electron/src/renderer/lib/__tests__/terminal-integration-status.test.ts`
- `apps/electron/src/renderer/pages/settings/AppSettingsPage.tsx`
- `packages/shared/src/i18n/locales/*.json`

## 实际测试命令与结果

1. 专项锁、终端集成和 i18n 状态测试

   ```bash
   bun test packages/shared/src/utils/__tests__/files.test.ts apps/electron/src/main/__tests__/terminal-integration.test.ts apps/electron/src/main/__tests__/terminal-onboarding.test.ts apps/electron/src/renderer/lib/__tests__/terminal-integration-status.test.ts
   ```

   结果：PASS，29 tests passed，0 failed，199 expect calls。

2. secure credential storage migration 专项测试

   ```bash
   bun test packages/shared/src/credentials/__tests__/secure-storage-path-migration.test.ts
   ```

   结果：PASS，6 tests passed，0 failed，17 expect calls。

3. 双临时 server 并发及 stale discovery 集成测试

   ```bash
   bun test ./apps/cli/src/server-spawner.isolated.ts
   ```

   结果：PASS，5 tests passed，0 failed，33 expect calls。真实并发 workspace、连接和凭据更新均保留，两个 server 均独立清理。

4. Renderer 全量测试

   ```bash
   bun test apps/electron/src/renderer
   ```

   结果：PASS，459 tests passed，0 failed，905 expect calls。

5. i18n 校验

   ```bash
   bun run lint:i18n:parity
   bun run lint:i18n:sorted
   bun run lint:i18n:coverage
   ```

   结果：全部 PASS。6 个非英文 locale 与英文基准均为 1626 keys；排序和 literal key coverage 均通过。

6. 全量测试

   ```bash
   bun run test
   ```

   结果：PASS，退出码 0；包含标准测试套件和 `scripts/run-isolated-tests.sh`，新增并发集成覆盖也在全量链路中通过。

7. 全量类型检查

   ```bash
   bun run typecheck:all
   ```

   结果：PASS，退出码 0。

8. Electron build

   ```bash
   bun run electron:build
   ```

   结果：PASS，退出码 0；main、preload、renderer、resources、assets 构建完成，CLI 0.10.0 和 packaged server 0.10.0 生成并通过 packaged CLI artifact validation。

9. Diff 格式检查

   ```bash
   git diff --check
   ```

   结果：PASS，无输出。

10. 补充 lint 检查

    ```bash
    bun run lint:electron
    bun run lint:shared
    ```

    结果：`lint:electron` 退出码 0（仅有仓库既存 warnings）；`lint:shared` 被 5 个仓库既存、与本次变更无关的 `craft-shared/no-inline-source-auth-check` errors 阻断，位置为 `resource-bundle.test.ts`、`token-refresh-manager.test.ts` 和 `token-refresh-manager.ts`，这些文件均未被本次修改。

## 遗留问题

- 本轮两个 blocking issue 均已处理，无已知未完成代码项。
- 仓库现有 `lint:shared` 基线仍有上述 5 个非本任务错误；本轮未扩大范围修改这些文件。
- 当前开发机为 macOS；Windows/Linux 的跨进程锁和终端状态类型已参与全量类型检查及平台无关测试，但未在 Windows/Linux 真机或对应 CI 环境运行，仍需后续平台验证。
