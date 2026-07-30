# POL-51 第 4 轮阻塞审查修复报告

## 逐项处理结果

### 1. prototype-named Catalog App ID 批量状态异常

已修复。

- 主进程新增业务 ID 字典的 own-property 读取边界；`trustedReleases` 仅在目标 `catalogAppId` 是字典自有属性时返回值，不再读取 `Object.prototype` 上继承的 `constructor`、`toString` 或 `__proto__`。
- Catalog App 的合法业务 ID 契约保持不变，没有通过收窄字符集规避问题。
- 新增真实 Local Apps handler 批量状态回归：同一批包含 `constructor`、`toString`、`__proto__` 和健康 App；前三个 App 同时携带无效 available/installed 版本时均独立返回 `versionError = invalid_semver`，健康 App 保持 `installed`，整个批次不崩溃。

### 2. 同 context 迟到 hydration 覆盖 recent mutation

已修复。

- HomePage 为最近使用记录增加独立的 mutation generation。hydration 开始时捕获 generation，提交结果前同时校验 context load generation 与 mutation generation。
- 任意同 context 的本地打开都会推进 mutation generation，使更早的 GET 快照失效；跨 context 的旧响应仍由原 load generation 丢弃。
- 新增 deferred GET 交互回归：hydration 挂起期间连续打开两个内置 App，迟到快照不能覆盖它们；随后再次打开 App 后，preferences 中仍保留全部三条新记录，证明旧快照不会在后续持久化时删除新历史。

## 关键文件

- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
- `.pipeline/fix-report-round4.md`

## 实际测试与结果

- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
  - 34 pass，0 fail；新增两个确定性回归均通过。
- `bun run typecheck:electron && bun run typecheck:shared`
  - Electron 与 shared TypeScript 检查通过。
- `bun run test`
  - exit 0；基础套件 4833 pass、19 skip、0 fail，随后仓库全部 `*.isolated.ts` 套件通过。
- `bun run validate:ci`
  - exit 0；全 workspace typecheck、shared 定向测试、19 个文档工具测试及 i18n parity/sorted/coverage 全部通过；6 个 locale 各 1706 keys。
- `bun run lint:electron`
  - exit 0；0 errors、120 个仓库既有 warnings。
- `bun run electron:build`
  - exit 0；main、preload、renderer、resources、assets 完整生产构建通过；renderer 转换 5582 modules。
- `git diff --check`
  - 通过。

## 遗留问题

- 本轮两个审查问题均已闭环，无已知功能或安全遗留。
- Electron lint 仍报告 120 个既有 warning；完整构建仍有既有大 chunk 提示，均未由本轮变更新增，也不阻断当前验证。
