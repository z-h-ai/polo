# POO-36 Round 9 修复报告

## 处理结果

- `rollback-failed` 现在优先处理同版本仍在生效的 `.rollback-<version>.json` 或 `.confirmed-<version>.json`，仅在没有 live marker 时才接受 `.compensated-history-<version>.json` 作为已完成补偿的归档记录。
- `assert-rollback-target` 使用相同优先级：live marker 存在时必须验证当前 `latest` 正好等于其 predecessor，不能被旧归档记录掩盖。
- 新回归覆盖完整序列：已归档补偿 → 相同版本重试 → 失败补偿，最终 `latest` 精确恢复至原 predecessor。
- 未修改 macOS arm64 外层安装包证据/验收决策，也未 push。

## 关键文件

- `scripts/publish-electron-release.ts`
- `scripts/publish-electron-release.test.ts`

## 实际自测

- `bun test scripts/publish-electron-release.test.ts`
  - 25 passed, 0 failed；包括 live marker 优先级回归。
- `bun run typecheck:all`
  - 通过。
- `bun run test`
  - 全量测试通过（退出码 0）。
- `git diff --check`
  - 通过。

## 遗留项

- 无新增自动修复阻塞项；真实生产 Service Exec 仍需在授权的 tag 联调环境验证。
