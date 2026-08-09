# POO-36 Round 6 修复报告

## 处理结果

1. GitHub Draft 的两处最终 PATCH 已改为 `gh api -F draft=false/true`，保证向 GitHub API 传递 JSON boolean。工作流结构测试捕获两条 PATCH 请求，继续要求同一 `DRAFT_RELEASE_ID`，并保留 approved identity 重验。
2. 定义 compensated marker 生命周期：新版本发布会在 publisher 锁内确认旧 `.compensated-<version>` 的 predecessor 仍精确指向当前 latest 后才移除；随后记录当前版本自己的 rollback predecessor。已补回归：补偿过的 1.1.0 不会阻塞 1.2.0 confirm/finalize。
3. 成功最终化会在删除 `.confirmed-<version>` 前原子写入 `.finalized-<version>.json`，持久化完整 retained SemVer 集合、source release count 和 exact latest target。`assert-finalized` 在锁内要求唯一当前 finalized marker、精确 latest pointer 和磁盘目录集合逐项一致；不足三版本时明确要求保留所有可用版本。
4. Apple Silicon 构建新增 `signing` 验证模式：不参加 updater manifest/前序升级生命周期，但严格执行 Developer ID、notarization、stapling、App/uv identity 校验，并要求 DMG/ZIP 两条 signing audit 记录后才上传。

## 关键文件

- `.github/workflows/electron-release.yml`
- `.github/workflows/electron-artifact-full.yml`
- `apps/electron/scripts/validate-final-artifacts.sh`
- `apps/electron/scripts/afterAllArtifactBuild.cjs`
- `scripts/publish-electron-release.ts`
- `scripts/publish-electron-release.test.ts`
- `scripts/electron-release-workflow.test.ts`
- `scripts/__tests__/electron-artifact-pipeline.test.ts`

## 实际测试

- `bun test scripts/publish-electron-release.test.ts scripts/electron-release-workflow.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts infra/updates-static/PoloCaddyfile.test.ts scripts/polo-release-pull.test.ts` — 53 pass / 0 fail；含真实 Caddy 容器与下载器 fixture。
- `bun run typecheck:all` — 通过。
- `bun run test` — 通过（主并行套件和隔离套件，退出码 0）。
- `git diff --check` — 通过。

## 遗留项

无代码遗留项。真实 tag 验收仍依赖已声明的 GitHub macOS signing/notarization secrets 与 Zeabur/GitHub 发布权限。
