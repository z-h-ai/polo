# POO-36 Round 5 修复报告

## 处理结果

1. GitHub 最终发布链路现在只使用 `DRAFT_RELEASE_ID`。生产审批后、PATCH `draft=false` 前会按该 ID 重新读取 Release，严格校验 Draft 状态、tag、target commit、九个 asset 的 ID/名称/大小，并逐个按 asset ID 重新下载校验 SHA-256。发布后的查看和失败后的 Draft 恢复也只访问同一 ID；ID 缺失或任何身份变化均失败关闭，绝不按 tag 查找替代 Release。
2. 最终化保留策略改为严格且可重试。保留 `.confirmed-<version>` 到容量清理和三（或不足三时全部）安全目录清单均验证完成后才删除；清理或 marker 删除失败均返回非零并保留状态。`assert-finalized` 在发布锁内验证 latest、无残留 rollback/confirmed/compensated marker、latest 在目录清单中且目录数不超过三。
3. 回滚补偿将原 predecessor 持久化为 `.compensated-<version>.json`，所有重试均在 publisher 锁内要求 `electron/latest` 精确等于该 predecessor（bootstrap 时要求不存在 latest）。复用的 composite action 改为调用 `assert-rollback-target`，不再把“不是失败版本”误判为成功。

## 关键文件

- `.github/workflows/electron-release.yml`
- `.github/actions/zeabur-rollback-failed/action.yml`
- `scripts/electron-release-draft-identity.ts`
- `scripts/publish-electron-release.ts`
- `scripts/electron-release-draft-identity.test.ts`
- `scripts/publish-electron-release.test.ts`
- `scripts/electron-release-workflow.test.ts`

## 实际测试

- `bun test scripts/publish-electron-release.test.ts scripts/electron-release-draft-identity.test.ts scripts/electron-release-workflow.test.ts` — 32 pass / 0 fail。
  - 覆盖精确 Draft ID/资产身份拒绝、错误 latest 指针的补偿重试拒绝、bootstrap 无 latest、保留清理失败和 stale marker 删除失败。
- `bun test infra/updates-static/PoloCaddyfile.test.ts scripts/polo-release-pull.test.ts` — 10 pass / 0 fail，包含真实 Caddy 容器与下载器 fixture。
- `bun run typecheck:all` — 通过。
- `bun run test` — 通过（主并行套件及隔离套件；命令退出码 0）。
- `git diff --check` — 通过。

## 遗留项

无代码遗留项。首次真实 tag 联调仍需要任务快照中列出的 GitHub production/Zeabur secrets 与服务授权。
