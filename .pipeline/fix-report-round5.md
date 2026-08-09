# POO-37 Round 5 修复报告

## 修复结果

共享 browser-safe metadata core 的 `description` 上限已改为 Unicode code points 计数：保留既有非空（最少 1 个 code point）和 1024 上限，避免 JavaScript UTF-16 `.length` 将每个非 BMP 字符计为两个 code units。

- `😀`.repeat(1024) 合法。
- `😀`.repeat(1025) 以既有结构化 `invalid_skill_content` / `description` / `Creator Skill description must be at most 1024 characters` 拒绝。
- browser metadata parser（含无 `Buffer` / `process` / `require` 的已构建 bundle）、server content validator、`SkillVersionMetadataSchema`、archive validator 全部复用同一 metadata core，并有各自的边界回归。
- 未改变其他 YAML、UTF-8、ZIP root、noise、alias、icon 或 browser-safe 规则。

## 关键文件

- `packages/shared/src/creator-skills/metadata.ts`
- `packages/shared/src/creator-skills/__tests__/metadata.test.ts`
- `packages/shared/src/creator-skills/__tests__/skill-content.test.ts`
- `packages/shared/src/creator-skills/__tests__/schemas.test.ts`
- `packages/shared/src/creator-skills/__tests__/archive.test.ts`
- `packages/shared/src/creator-skills/__tests__/package-exports.test.ts`
- `packages/shared/dist/creator-skills/index.cjs`
- `packages/shared/dist/creator-skills/metadata.browser.cjs`
- `packages/shared/dist/creator-skills/metadata.browser.mjs`

## 验证命令与结果

```text
bun test packages/shared/src/creator-skills/__tests__/metadata.test.ts packages/shared/src/creator-skills/__tests__/archive.test.ts packages/shared/src/creator-skills/__tests__/skill-content.test.ts packages/shared/src/creator-skills/__tests__/schemas.test.ts
# 49 pass, 0 fail

bun run typecheck:shared
# passed

bun run --cwd packages/shared build:creator-skills
# passed

bun test packages/shared/src/creator-skills/__tests__/package-exports.test.ts
# 1 pass; browser bundle runs with Buffer/process/require undefined and covers 1024/1025 non-BMP descriptions

bun test packages/shared/src/creator-skills/__tests__ packages/shared/src/admin/__tests__/semver.test.ts
# 104 pass, 0 fail, 634 assertions

bun run --cwd packages/shared test:creator-skills-package-failures
# passed（proof failure lifecycle regressions）

bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts --allow-dirty-snapshot --output-dir /tmp/poo-37-shared-fix-round5-final
# passed；CI-style process lifecycle passed
```

## 本地打包与 lifecycle 客观证据

`/tmp/poo-37-shared-fix-round5-final/proof.json`：本地候选包 `@z-h-ai/shared@0.13.2`、tarball `z-h-ai-shared-0.13.2.tgz`、SHA-256 `e8b0a8cd5e0017397420cc931dee394229176cd8629164c940ed11cb65ac0103`。

frozen `npm ci`、CJS require、ESM import、TypeScript、Next production build/route/client build、browser metadata contract、negative tarball boundary 全为 `passed`。`lifecycle-proof.json` 记录 exit code `0`、`processGroupReaped: true`、无存活子进程。

这是本地候选包的 clean-install/lifecycle 证据；`gitSnapshotClean` 为 `false`，不是 GitHub Packages registry 发布证据。

## 未处理的外部事项

未 push、未创建 tag、未处理 registry release。`shared-v0.13.2` tag、GitHub Packages release 与 registry clean-install 仍需外部授权。
