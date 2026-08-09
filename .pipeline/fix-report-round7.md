# POO-36 Round 7 修复报告

## 处理结果

1. macOS arm64 手动安装包现在同样验证外层 `Polo-AI-arm64.dmg`：`codesign --verify --strict`、Developer ID notarization assessment 与 stapler validation。外层 DMG 使用独立的 `DMG outer` JSONL 审计记录；挂载后的 App 和 nested uv 审计仍分别保留，arm64 继续为 `updater: false`。
2. 下载器在容量预检和下载前检查既有 `electron/releases/<version>`。只有完整合同、九个白名单资产的大小和批准 SHA-256 都一致时才通过已有目录在锁内恢复；任何缺失、同尺寸异字节或合同冲突都会在下载与容量预检前失败。新下载路径仍保持双份新字节的峰值容量门槛。
3. 已完成且在发布锁内精确断言的补偿现在归档为 `.compensated-history-<version>.json`，不再约束后续的 `latest` 或保留策略。后续手动回滚后，新发布会以当时实际 `latest` 指针写入新的 rollback predecessor。

## 关键文件

- `apps/electron/scripts/validate-final-artifacts.sh`
- `scripts/release-signing-contract.ts`
- `.github/workflows/electron-artifact-full.yml`
- `scripts/polo-release-pull.ts`
- `scripts/publish-electron-release.ts`
- 对应 `scripts/**/*.test.ts` 工作流、签名、下载器和发布状态回归测试。

## 实际自测

- `bun test scripts/publish-electron-release.test.ts scripts/polo-release-pull.test.ts scripts/__tests__/release-signing-contract.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts scripts/electron-release-workflow.test.ts`
  - 62 passed, 0 failed。
  - 覆盖外层 DMG 合同、既有发布目录精确恢复/冲突拒绝、以及 1.0 → 1.1 → 1.2 补偿 → 手动回滚至 1.0 → 1.3 新 predecessor/三版本保留序列。
- `bun run typecheck:all`
  - 通过。
- `git diff --check`
  - 通过。

## 遗留项

- 未执行真实 GitHub Actions 的 macOS 签名、公证和 Zeabur Service Exec；这些仍需由已授权环境在真实 tag 联调中完成。
