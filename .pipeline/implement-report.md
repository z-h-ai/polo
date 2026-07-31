# POL-51 实现报告

## 变更摘要

- 收口 Admin 业务实体 ID 的 Unicode 边界：共享 `AdminEntityIdSchema` 现在接受正常 Unicode（包括合法代理对），并拒绝未配对 UTF-16 surrogate；账号 ID、组织 ID、Group ID、Catalog App ID、本地 scope 与缓存统一复用该契约。
- Catalog 同步 RPC 在读取凭据、访问缓存或发起网络请求前拒绝格式错误的组织 ID，稳定返回 `VALIDATION_ERROR`，不再允许 `encodeURIComponent` 抛出的 `URIError` 中断同步、缓存回退或 denied 清理链路。
- Catalog 缓存 key 改为复用无碰撞的 JSON tuple 上下文编码，不再调用会对未配对 surrogate 抛错的 `encodeURIComponent`。
- 缓存读取会根据记录内的结构化 `accountId + organizationId` 将旧 URI 编码 key 迁移为规范 tuple key；若损坏缓存为同一 scope 保存了重复记录，denied 记录优先，保持 fail closed。
- 新增共享 schema、缓存迁移、防御性异常输入及 production RPC 接线回归测试。

## 关键文件列表

- `packages/shared/src/admin/schemas.ts`
- `packages/shared/src/admin/app-catalog-cache.ts`
- `packages/shared/src/admin/__tests__/schemas.test.ts`
- `packages/shared/src/admin/__tests__/app-catalog-cache.test.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `.pipeline/implement-report.md`

## 自测结果

- `bun run test`
  - 通过；基础套件 4,836 pass、19 skip、0 fail（4,855 tests / 370 files），随后仓库全部 `*.isolated.ts` 套件通过。
- `bun run validate:ci`
  - 通过；全 workspace TypeScript、shared 定向测试、19 个文档工具测试及 i18n parity/sorted/coverage 全部通过；6 个 locale 各 1,706 keys。
- `bun run typecheck:all`
  - 通过。
- `bun test ./packages/shared/src/admin/__tests__/schemas.test.ts ./packages/shared/src/admin/__tests__/app-catalog-cache.test.ts ./packages/shared/src/admin/__tests__/context-key.test.ts`
  - 23 pass、0 fail。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 60 pass、0 fail；包含 malformed UTF-16 组织 ID 在缓存访问前 fail closed 的 production RPC 回归。
- `bun run lint:electron`
  - 通过；0 errors、120 个仓库既有 warnings。
- 对本次修改的 shared 文件执行 ESLint
  - 通过；0 errors、0 warnings。
- `bun run electron:build`
  - 通过；main、preload、renderer、resources 和 assets 完整生产构建成功。
- `git diff --check`
  - 通过。

## 遗留问题

- 本任务范围内无已知功能或安全遗留。
- 全量 `bun run lint:shared` 仍会因 5 个与本任务无关的既有 `no-inline-source-auth-check` 错误失败，位置在 `resource-bundle.test.ts`、`token-refresh-manager.test.ts` 和 `token-refresh-manager.ts`；本次修改文件的 shared ESLint 已单独通过。
- Electron lint 仍报告 120 个既有 warning；renderer 构建仍有既有大 chunk 提示，均未由本次变更新增。
