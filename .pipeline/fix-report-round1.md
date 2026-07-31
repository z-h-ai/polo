# POO-16 Reviewer 第 1 轮修复报告

## 处理结果

已修复 management 子命令的 help/version 解析绕过。

- `polo exec sessions --api-key secret-value --help` 现在先识别 `sessions`，命中管理子命令选项白名单后拒绝 `--api-key`，返回 exit 2。
- `polo exec delete <thread_id> --yolo --version` 现在同样先识别 `delete`，拒绝 `--yolo`，返回 exit 2。
- 单独的 `polo exec sessions --help` 和 `polo exec delete <thread_id> --version` 保留正常 help/version 行为。
- 新增 parser 回归和真实 CLI subprocess 回归，覆盖 sessions/delete 分别与 help/version 和禁用选项的组合；敏感 API key 不进入 stderr。

## 关键文件

- `apps/cli/src/execution-parser.ts`
  - 延迟 help/version 分派，先完成 exec 子命令识别及管理选项白名单验证。
- `apps/cli/src/execution-parser.test.ts`
  - 覆盖管理子命令在 help/version 组合下拒绝禁用参数，并验证纯 help/version 仍可用。
- `apps/cli/src/index.test.ts`
  - 通过真实 CLI subprocess 断言组合参数退出 2、stdout 为空且 secret 不泄漏。

## 实际测试

- `bun test apps/cli/src/execution-parser.test.ts apps/cli/src/index.test.ts`
  - 15 pass，0 fail。
- `bun run --cwd apps/cli typecheck`
  - 通过。
- `git diff --check`
  - 通过。

## 遗留问题

- 本轮 reviewer blocker 无已知遗留。
- 未触碰 `.task/session-analysis/` 未跟踪内容。
