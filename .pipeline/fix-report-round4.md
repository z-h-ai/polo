# POL-51 Reviewer 第 4 轮修复报告

## 逐条问题处理结果

### 1. Catalog 并发请求不得压掉明确会话失权

- 已修复。Catalog 请求代次只继续用于阻止成功数据乱序回写，不再参与 401/403、`TOKEN_REVOKED`、`ACCOUNT_DISABLED` 等会话级失权的结束判定。
- 明确失权到达后，主进程先在可信 session CAS 内立即 deny 当前账号的 Catalog access mode 和缓存授权，再执行可能较慢的账号进程停止；较新的网络错误或 5xx 因此不能继续返回 authorized 离线目录。
- `endAdminSession` 仍以真实 session generation、账号和 token 快照作为最终 CAS。只有期间真实切换了会话才返回 `SESSION_CHANGED`；Catalog 请求顺序不能抑制凭据删除和账号清理。
- 新增确定性并发回归，覆盖 A 返回 401 + B 返回 `NETWORK_ERROR`、A 返回 403 + B 返回 HTTP 503。两组均验证临时失败不返回授权缓存、凭据删除、Catalog 缓存和 access mode 最终 denied，新增 Bundle 生命周期权限关闭。

### 2. 通用退出与 Admin 退出的 renderer CAS

- 已修复。Electron API 的 `logout()` 与 `adminLogout()` 现在共享强类型 `SessionLogoutResult`，显式暴露 `SESSION_CHANGED` 等失败结果，不再声明为 `Promise<void>` 或宽泛布尔值。
- renderer 在两种退出开始时都捕获当前 `accountId + local generation` 快照；RPC 返回后，只有结果成功且账号与 generation 仍匹配时才清理会话、组织、工作区和 onboarding 状态。
- `SESSION_CHANGED` 或本地快照变化会直接丢弃旧 continuation，不再通过 `finally` 清空新账号 B 的 UI。
- 新增真实 App 层确定性测试，分别覆盖 Admin 退出和通用 reset：账号 A 退出挂起，账号 B 完成登录和组织状态提交，A 返回 `SESSION_CHANGED` 后 B 的 `currentAdminUser`、组织缓存和 ready 页面均保持不变。

### 3. 安装确认绑定 permissions 与 appConfigVersion

- 已修复。Catalog 安装请求除 Release 指纹外，新增确认时的 `appConfigVersion` 与权限集合。
- 首页在打开确认弹窗时同时捕获 App 元数据和 Catalog 配置版本；确认提交不会改用弹窗期间刷新的版本快照。
- shared 协议提供稳定权限规范化：去除首尾空白、空项和重复项后排序。renderer 发送规范化集合，主进程对 renderer 与当前授权 Catalog 两侧执行同一规范化后严格比较。
- 主进程仍只使用当前授权缓存构造实际安装参数；Release、权限或 `appConfigVersion` 任一变化均返回 `RELEASE_CHANGED`，不会创建下载任务，renderer 随后刷新并要求重新确认。
- 新增权限变化拒绝、权限顺序/重复项规范化接受、`appConfigVersion` 推进拒绝，以及 renderer 请求携带确认版本和规范化权限的回归测试。

## 关键文件

- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.isolated.ts`
- `packages/shared/src/protocol/local-apps.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/main/handlers/local-apps.ts`
- `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/renderer/__tests__/App.organization-deep-link.interaction.isolated.ts`
- `apps/electron/src/renderer/hooks/useAppCatalog.ts`
- `apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
- `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`

## 自测结果

- `bun run test`
  - 完整通过，退出码 0。
  - 常规阶段：4783 pass、19 skip、0 fail，共 4802 tests / 363 files。
  - 脚本后半段发现并逐文件执行的全部 `*.isolated.ts` 套件通过。
- `bun test ./packages/server-core/src/handlers/rpc/admin.isolated.ts`
  - 48 pass，0 fail。
- `bun test ./apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`
  - 13 pass，0 fail。
- `bun test ./apps/electron/src/renderer/__tests__/App.organization-deep-link.interaction.isolated.ts`
  - 5 pass，0 fail。
- `bun test ./apps/electron/src/renderer/hooks/__tests__/useAppCatalog.interaction.isolated.ts`
  - 14 pass，0 fail。
- `bun test ./apps/electron/src/renderer/components/tab-browser/__tests__/HomePage.round2.interaction.isolated.ts`
  - 6 pass，0 fail。
- `bun run typecheck:all`
  - 通过。
- `bun run lint:electron`
  - 0 error；127 个仓库既有 warning。
- 变更文件定向 ESLint
  - 0 error；12 个 `App.tsx` 既有 hook warning及测试环境 `localStorage` warning。
- `git diff --check`
  - 通过。

## 遗留问题

- Reviewer 第 1 轮 suggestion 提到的 SemVer 三份实现仍未统一；继续沿用既往风险判断，不在最后一轮安全与竞态修复中扩大重构范围。
- 仓库级 `bun run lint:shared` 仍有 5 个与本任务无关的既有规则错误，位于 resource bundle / token refresh 相关文件；本轮未修改这些文件。变更涉及的 shared 协议文件定向 ESLint、全量类型检查和全量测试均通过。
- 无其他已知 POL-51 阻断问题。
