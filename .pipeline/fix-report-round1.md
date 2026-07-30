# POO-21 Review Round 1 修复报告

## 逐项修复

### 1. `ledger_committed → committed` 窗口可删除唯一旧目录

已修复。

- 更新与干净卸载不再在 journal 仍为 `ledger_committed` 时把旧目录发布到 `skill-backups/`。
- 旧正式目录在事务不可回滚前始终保留于
  `.creator-skill-ops/<operationId>/backup`，备份管理 API 不可见、不可删除。
- `committed` journal 的文件内容、文件 fsync、rename 和 journal 目录 fsync
  全部成功后，才在备份管理锁内写入元数据并原子 rename 到永久备份目录。
- `committed` 落盘失败时仍用隐藏事务备份恢复旧目录和旧 Ledger；目录 fsync
  不支持时保留 committed journal 和隐藏备份，交给启动恢复安全完成。
- 启动恢复对 committed journal 幂等发布永久安全快照；更新和干净卸载使用
  同一提交顺序。
- 新增更新、干净卸载的并发“全部删除备份”与 committed fsync 故障测试，
  并验证 committed 落盘前永久备份不可见、恢复后才可管理。

### 2. 不同 slug 并发覆盖 workspace 级 Ledger

已修复。

- 新增 workspace 级 `creator-skills.json` 进程队列和独占 lock file。
- 安装、更新、卸载及安全状态元数据更新在该锁内重新读取并合并 Ledger；
  workspace+slug 锁继续保护目录交换。
- 回滚不再用旧快照覆盖整个 Ledger，只恢复当前 journal 对应 slug，保留锁外
  已提交的其他 slug 记录。
- workspace 路径在生成队列 key 前统一 canonicalize，避免同一目录的路径别名
  绕过进程互斥。
- 新增不同 slug 并发安装，以及卸载与安全状态更新交错执行的确定性测试；
  另覆盖旧 journal 恢复时保留其他 slug 新记录。

### 3. 成员资格刷新后旧 Catalog 请求重新污染缓存

已修复。

- Creator Artifact Catalog 缓存增加全局、用户、用户+组织三级单调 generation。
- Catalog 请求只在返回时 generation 与发起时完全一致才写缓存。
- 登录、账号切换、退出、认证失效、成员资格刷新和相关成员变更均先递增对应
  generation，再清理缓存。
- `LIST_ORGANIZATIONS` 在请求开始和权威响应完成时各推进一次 generation，
  同时覆盖刷新前已在途请求和刷新期间新发起的请求。
- 新增延迟 Catalog 响应跨越成员刷新边界，以及刷新进行期间 Catalog 请求的
  回归测试，确认旧权限内容不会重新进入缓存。

## 关键文件

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/ledger.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/server-core/src/handlers/rpc/admin.test.ts`

## 自测结果

- `bun test packages/shared/src/creator-skills/__tests__/installer.test.ts`
  - 31 pass，0 fail，221 assertions。
- `bun test packages/shared/src/creator-skills/__tests__`
  - 48 pass，0 fail。
- `cd packages/server-core && bun test src/handlers/rpc/admin.test.ts`
  - 24 pass，0 fail，115 assertions。
- `bun test ./packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`
  - 8 pass，0 fail，50 assertions。
- `bun run test`
  - exit 0；标准测试及仓库全部 `*.isolated.ts` 均通过。
- 最终代码再次执行 `bun test`
  - 4835 pass，19 skip，0 fail；12025 assertions，共 369 个文件。
- `bun run typecheck:all`
  - exit 0；全部 package typecheck 通过。
- 最终代码再次执行 server-core 与 shared `tsc --noEmit`
  - 通过。
- shared 本次变更文件 ESLint
  - 0 error。
- `git diff --check`
  - 通过。

## 遗留问题

- Review Round 1 列出的 3 个阻塞问题均已修复，无已知功能遗留。
- server-core 没有独立 ESLint script；从仓库根目录直接调用 ESLint 9 不会加载
  package 级旧配置，因此使用已有 shared package 配置检查 shared 变更，并以
  server-core typecheck、目标测试及全量测试覆盖 server-core 变更。
