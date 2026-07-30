# POL-51 第 1 轮审查修复报告

## 逐条处理

1. App 级 deny gate 范围
   - 将 scoped registry 的生命周期 fence 改为按操作策略捕获。
   - App/组织 fence 只约束 `INSTALL`、`START`、`RESTART` 及其迟到提交；状态、安装记录、日志、取消、`STOP`、`UNINSTALL` 和 retained-scope 扫描只保留账号会话 fence。
   - 保持“先建立 deny gate、后写 Catalog 缓存”的 fail-closed 时序。缓存写入失败不会释放 gate；后续成功同步明确重新包含 App 并成功提交缓存后才释放。
   - production wiring 回归覆盖：缓存写失败时生命周期仍拒绝；状态、日志、停止、卸载和 retained 扫描可用；成功重新收录后可再次启动。

2. 不兼容新 Release 与旧版本启动
   - 平台/架构兼容性只限制未安装 App 的安装和已安装 App 的更新。
   - 已安装旧版本在新 Release 不兼容时，在线和受限离线均保留“打开”；不会误显示“更新”。
   - 增加已安装/未安装、在线/离线组合回归。

3. 明确组织失权后的本地数据管理
   - renderer 不再清空已有 Catalog 和运行状态；将目录标记为 `denied/unavailable`，刷新真实本地状态并推进授权上下文 generation，丢弃失权后迟到的启动结果。
   - HomePage 保留已安装 App 卡片，主操作不可用，同时继续提供状态、日志、停止和卸载入口。
   - Local Apps IPC 拆分“可执行生命周期授权”和“已缓存 scope 数据管理授权”：组织级拒绝后允许状态、日志、停止、卸载；安装/更新/启动/重启继续 fail closed。
   - 新增账号级 session-ending gate 查询，确保慢登出窗口内所有公开 RPC 仍立即 fail closed，不把组织级受限管理扩展到已结束账号。

4. 安装确认大小单位国际化
   - `formatBytes` 的 B/KB/MB/GB 全部改为 `t()` locale key。
   - 为 en、zh-Hans、de、es、hu、ja、pl 补齐并排序 4 个单位 key。
   - 增加英语、简体中文、德语格式化测试，并通过 locale parity/sorted/coverage 校验。

## 关键文件

- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/components/tab-browser/OrganizationAppCard.tsx`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`
- `packages/shared/src/admin/app-catalog-access.ts`
- `packages/shared/src/i18n/locales/*.json`
- 对应 main、renderer、production-wiring、i18n 回归测试文件

## 自测结果

- `bun test`
  - 4802 pass，19 skip，0 fail（365 个测试文件）。
- 4 个受影响 isolated 测试文件逐个执行
  - Local Apps IPC：18 pass。
  - Admin + scoped runtime production wiring：12 pass。
  - `useAppCatalog` 交互：19 pass。
  - HomePage 交互：10 pass。
- 定向非 isolated 回归
  - App Catalog 账号 gate、scoped registry、OrganizationAppCard、locale parity：59 pass，0 fail。
- `bun run --cwd apps/electron typecheck`
  - 通过。
- `bun run --cwd apps/electron lint`
  - 通过，0 error；仅仓库既有 warning。
- `bun run lint:i18n:parity`
  - 通过，6 个非英文 locale 与英文 1706 keys 一致。
- `bun run lint:i18n:sorted`
  - 通过。
- `bun run lint:i18n:coverage`
  - 通过。

## 遗留问题

- 本轮 4 项阻塞审查问题均已处理，无已知功能遗留。
- 工作区原有 `fix-report-round2.md`～`fix-report-round4.md` 删除状态及未跟踪的 `design-demos/`、`docs/spec-home-app-admin-config*.md` 未纳入本轮修改与提交。
