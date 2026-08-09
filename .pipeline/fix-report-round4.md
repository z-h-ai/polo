# POO-36 第 4 轮修复报告

## 处理结果

1. 同版本重试现在识别“当前 latest 已确认”的恢复状态：不再创建新的 rollback marker，因此保留最初 `previousTarget`。回归覆盖 `1.1.0` 覆盖 `1.0.0`、confirm、中断、相同字节重试、GitHub 最终化失败后精确恢复 `1.0.0`。
2. Draft job 在逐字节比较/创建后，通过 GitHub REST 读取数值 release ID，并把九个白名单 asset 的 ID、名称、大小和由已组装文件计算的 SHA-256 输出给 production。下载器只按 release ID 获取 Release；当前 Draft 的 ID/九个资产 ID、名称、大小不一致会在下载前拒绝，下载后的 SHA-256 不一致会在进入 PVC 前拒绝。
3. GitHub Release 被正向读取为非 Draft 后，workflow 通过 `updates-static-v4` Service Exec 调用新增的锁内 `finalize`/`assert-finalized`。该转换移除 `.confirmed-<version>` 并重新执行保留清理；finalize 可安全重试。回归覆盖手工回滚至最旧版本后成功发布 `1.3.0`，最终恰好保留 `1.1.0`、`1.2.0`、`1.3.0`。
4. 四处 rollback + `assert-not-latest` 补偿已收敛到受版本控制的复合 action `.github/actions/zeabur-rollback-failed`，仍保留三次重试、同一 Service Exec、独立指针断言和失败退出。

## 关键文件

- `.github/workflows/electron-release.yml`
- `.github/actions/zeabur-rollback-failed/action.yml`
- `scripts/electron-release-draft-identity.ts`
- `scripts/electron-release-draft-identity.test.ts`
- `scripts/polo-release-pull.ts`
- `scripts/polo-release-pull.test.ts`
- `scripts/publish-electron-release.ts`
- `scripts/publish-electron-release.test.ts`
- `scripts/electron-release-workflow.test.ts`
- `infra/updates-static/Dockerfile`

## 实际自测

- `NO_COLOR=1 bun test scripts/electron-release-contract.test.ts scripts/electron-release-bundle.test.ts scripts/electron-release-draft-identity.test.ts scripts/publish-electron-release.test.ts scripts/polo-release-pull.test.ts scripts/electron-release-workflow.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts infra/updates-static/PoloCaddyfile.test.ts`：57 pass、0 fail、509 assertions。
- `NO_COLOR=1 bun run typecheck:all`：通过。
- `NO_COLOR=1 bun run test`：完整门禁通过。
- `docker build --pull=false -f infra/updates-static/Dockerfile -t polo-updates-static-poo36:round4 .`：通过；镜像包含 Draft identity helper、下载器和 publisher。
- 容器内 `caddy validate`：通过；无 `GH_TOKEN` 与伪造的 Draft identity 均 fail closed（退出码 1）。
- workflow 与复合 action YAML 解析通过，`git diff --check` 通过。

## 遗留项

- 本地验证没有访问生产 Zeabur、GitHub Draft Release 或真实 token。首次生产 tag 联调仍依赖任务快照列出的 production Environment 与 Zeabur `GH_TOKEN` 授权。
- GitHub 发布已正向确认后，若后续 finalize Service Exec 三次都不可达，workflow 将失败以便人工跟进；GitHub Release 保持已发布，PVC 保持确认前的安全 marker，下一次相同版本 finalize 可幂等补做。
