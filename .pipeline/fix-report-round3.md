# POO-36 第 3 轮修复报告

## 处理结果

1. 发布 workflow 现在是可观测的补偿状态机：Zeabur pull、公开校验、Zeabur confirm/指针校验，以及 GitHub Release 最终发布都使用 `continue-on-error` 捕捉明确失败和响应不确定，并在后续发布前以同一 `updates-static-v4` Service Exec 重试 `rollback-failed` 和独立 `assert-not-latest`。三次均不可达时 job fail closed，Draft 不会被发布。
2. GitHub 最终发布移入生产状态机。`gh release edit --draft=false` 成功后仍会读取 `isDraft`；任何失败或结果不确定都会先补偿 PVC，再通过 GitHub API 尝试恢复 Draft 并验证。仅全部确认成功才结束为公开 Release。
3. Caddy 将所有 `electron` 下点前缀内部状态、锁及其子路径、`.latest-*` 临时软链接及其子路径，以及未确认的版本目录拒绝为非成功响应；公共下载仅经 `electron/latest`。真实 Caddy 容器对 GET/HEAD 覆盖这些嵌套路径，写请求仍为 405。
4. 已验证复用的 `.incoming/<version>` 与新下载路径同样在成功 publish 后清理；清理首次失败只告警、不把原子切换变成失败，下一次幂等 pull 会再次清理。回归测试证明第二次实际移除该目录。
5. `rollback-failed` 对“首次 Service Exec 已断连但尚未切换”及“已完成过补偿”的重试安全幂等：目标版本已经不是 latest 时返回成功，随后由独立断言证明这一事实。代码注释说明 rollback/confirmed marker 的生命周期和跨 Service Exec 不变量。
6. 主测试套件不再使用宿主 CPU 核数的无上限并行与 5 秒默认 timeout。`bun run test` 固定为 4 个 worker、每 worker 最多 8 个并发测试、15 秒默认单测 timeout；原先在共享负载下偶发超时的 CLI 测试已在完整门禁中通过。

## 关键文件

- `.github/workflows/electron-release.yml`
- `infra/updates-static/PoloCaddyfile`
- `infra/updates-static/PoloCaddyfile.test.ts`
- `scripts/publish-electron-release.ts`
- `scripts/publish-electron-release.test.ts`
- `scripts/polo-release-pull.ts`
- `scripts/polo-release-pull.test.ts`
- `scripts/electron-release-workflow.test.ts`
- `package.json`

## 实际自测

- `NO_COLOR=1 bun test infra/updates-static/PoloCaddyfile.test.ts scripts/electron-release-workflow.test.ts scripts/polo-release-pull.test.ts scripts/publish-electron-release.test.ts`：33 pass、0 fail、207 assertions。
- `docker run --rm ... caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`：通过；Caddyfile 仅有格式化提示。
- `NO_COLOR=1 bun run typecheck:all`：通过。
- `NO_COLOR=1 bun run test`：完整门禁通过，包含隔离测试；4 worker / 8 并发 / 15 秒运行契约下未再出现上一轮的 5 秒 CLI timeout。
- `git diff --check`：通过。

## 遗留项

- 本地测试使用临时目录、fixture 和真实 Caddy 容器；未调用生产 Zeabur 服务、真实 GitHub Draft Release 或任何 token。首次线上联调仍需任务快照列出的 production Environment 与 Zeabur `GH_TOKEN` 授权。
- 若 Zeabur 完全不可达，workflow 无法远程证明指针，但会在三次补偿失败后停止，且不会执行 GitHub Release 正式发布。
