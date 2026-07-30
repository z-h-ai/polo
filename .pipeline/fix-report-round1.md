# POL-51 第 1 轮 Review 修复报告

## 每个 issue 的处理结果

### 1. Catalog business appId 的 NUL 支持

- 已修复。
- `polo-app.json.appId` 与安装请求的 `expectedManifestAppId` 统一复用 shared `AdminEntityIdSchema`。
- business appId 继续与 manifest 严格相等比较；runtime appId、版本、入口和路径仍使用原有文件系统／运行时安全约束。
- 新增真实 Bundle 安装回归，使用 512 个 NUL 字符的合法 Catalog appId 完成下载、解压、manifest 校验和安装。

### 2. 最近使用持久化的最坏情况长度

- 已修复。
- 增加统一的最坏情况边界：
  - v2 account/organization context key：6,154 字符。
  - 完整 Catalog scope recent id：9,236 字符。
- preferences 写入、读取清洗、配置 Zod 校验和 renderer 清洗复用相同边界。
- 新增 512 字符 NUL account/organization/catalogAppId 的 renderer RPC 透传测试，以及跨新进程的真实 preferences reload 测试。

### 3. denied / withdrawn 状态投影去能力化

- 已修复。
- 增加 shared 严格 allowlist DTO，并由单项状态、批量状态、已安装列表和 STOP 响应共同复用。
- denied / withdrawn 投影移除 `url`、`port`、`pid`、`installationStatus`、`progress`、`availableRelease` 和 `error.details`；保留完整 scope、安全版本／状态信息及日志、STOP、UNINSTALL 管理所需字段。
- 新增 running App 慢状态读取与 App withdrawal fence 并发回归，确认旧响应不会泄露 localhost 或进程能力。

### 4. Catalog busy polling 热路径磁盘与 Zod 开销

- 已修复。
- Catalog cache 首次从磁盘读取后保留进程内已验证快照；相同配置路径的状态查询直接读取内存。
- `saveAppCatalog` 和 denied transition 在原子 rename 成功后才发布新内存快照；写入失败不会污染进程内已提交状态。
- 所有 cache 更新改为不可变构造，避免失败写入提前修改当前快照。
- 新增 10,000 App、连续 100 次状态读取回归，断言磁盘读取计数不增长，不再重复 read/JSON parse/Zod validate。

## 关键文件

- `apps/electron/src/main/local-app-runtime/manager.ts`
- `apps/electron/src/main/local-app-runtime/manifest.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts`
- `packages/shared/src/config/home-recent-limits.ts`
- `packages/shared/src/config/preferences.ts`
- `packages/shared/src/config/validators.ts`
- `apps/electron/src/renderer/lib/home-recent-apps.ts`
- `packages/shared/src/protocol/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/admin/__tests__/app-catalog-cache.test.ts`

## 实际运行的测试及结果

- `bun run test`
  - 常规测试：4,828 passed，19 skipped，0 failed（369 files）。
  - 20 个 isolated 测试文件：304 passed，0 failed。
- `bun run typecheck:shared`：通过。
- `bun run typecheck:electron`：通过。
- `cd packages/server-core && bun run tsc --noEmit`：通过。
- 变更文件 ESLint：
  - shared：0 error，0 warning。
  - Electron：0 error；2 个既有 localStorage 迁移测试 warning，无新增 lint error。
- `git diff --check`：通过。

## 遗留问题

- 本轮 4 项 blocking issue 均已修复，无功能性遗留问题。
- 全量测试中的 19 项 skip 为既有平台／外部 E2E 条件跳过；与本轮变更无关。
