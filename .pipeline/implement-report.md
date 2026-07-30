# POL-51 实现报告

## 变更摘要

- 将 renderer 的账号／组织上下文身份从易碰撞的 `${accountId}:${organizationId}` 改为 `JSON.stringify([accountId, organizationId])` 无碰撞元组编码，统一保护 Catalog、状态、生命周期、日志和组件 remount 的上下文 fence。
- 将预留的组织级持久化 key 升级为带 `v2` 标识的元组编码格式；当前生产代码尚无该 key 的持久化读写方，因此不存在需要复制的 legacy 数据，也不会把一个旧碰撞 key 迁移到多个新 scope。
- 增加冒号、Unicode、512 字符实体 ID 回归，并覆盖 legacy 拼接会碰撞的两个账号／组织上下文之间 Catalog、批量状态、START 生命周期和 HomePage 日志迟到响应隔离。

## 关键文件列表

- `apps/electron/src/renderer/lib/organization-storage.ts`
- `apps/electron/src/renderer/hooks/__tests__/useOrganizationContext.isolated.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`

## 自测结果

- `bun run test`：通过；项目常规测试和全部 `*.isolated.ts` 测试均通过。
- `bun run validate:ci`：通过；全 workspace TypeScript、shared 配置测试、文档工具测试和 i18n parity/sorted/coverage 均通过。
- `bun run typecheck:all`：通过。
- `bun run lint:electron`：通过，0 error；输出仓库既有的 131 个 warning。
- `bun run electron:build:renderer`：生产构建通过；仅输出既有 chunk size warning。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useOrganizationContext.isolated.ts`：14/14 通过。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`：28/28 通过。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`：12/12 通过。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.test.ts`：8/8 通过。
- `git diff --check`：通过。

## 遗留问题

- 未发现本轮组织上下文无碰撞编码问题的已知代码遗留。
- HomePage 的 Radix Dialog 交互测试仍输出仓库既有的 function-component ref warning，但测试通过，且与本次上下文 key 修复无关。
