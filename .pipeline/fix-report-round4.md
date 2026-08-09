# POO-37 Round 4 修复报告

## 修复结果

1. ZIP 根目录契约：共享 `resolveCreatorSkillRoot` 现在识别显式目录记录（例如 `polo-test/`）并与其 `polo-test/SKILL.md` 共同构成唯一合法根。根级普通文件仍返回 `invalid_skill_root`（空 path、固定 root message）；错根与多根维持同一失败契约。archive 将目录类型传入同一共享解析器。
2. 原始 `name` 校验：`name` 不再 trim；带前导或尾随空白的 YAML 字符串按严格 kebab-case `name` contract 拒绝。`description` 仍保持既有的显示文本 trim 语义。
3. 元数据项长度：共享 browser-safe metadata core 恢复并统一执行 `globs` 每项最多 2048 字符、`alwaysAllow`/`requiredSources` 每项最多 512 字符。browser parser、server content validator、archive validator 和 `SkillVersionMetadataSchema` 都通过该核心。
4. 去重：`ValidatedSkillMetadata` 改为共享 `CreatorSkillMetadata` 的类型别名，`isValidCreatorSkillSlug` 复用 `CREATOR_SKILL_NAME_PATTERN`；保持既有导出和运行时兼容性。

## 关键文件

- `packages/shared/src/creator-skills/metadata.ts`
- `packages/shared/src/creator-skills/archive.ts`
- `packages/shared/src/creator-skills/skill-content.ts`
- `packages/shared/src/creator-skills/__tests__/metadata.test.ts`
- `packages/shared/src/creator-skills/__tests__/archive.test.ts`
- `packages/shared/src/creator-skills/__tests__/skill-content.test.ts`
- `packages/shared/src/creator-skills/__tests__/schemas.test.ts`
- `packages/shared/dist/creator-skills/*`（由 browser-safe bundle 构建生成）

## 验证命令与结果

```text
bun test packages/shared/src/creator-skills/__tests__ packages/shared/src/admin/__tests__/semver.test.ts
# 102 pass, 0 fail, 622 assertions

bun run typecheck:shared
# passed

bun run --cwd packages/shared build:creator-skills
# passed

bun run --cwd packages/shared test:creator-skills-package-failures
# passed（proof failure lifecycle regressions 均通过）

bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts --allow-dirty-snapshot --output-dir /tmp/poo-37-shared-fix-round4-final
# passed；CI-style process lifecycle passed
```

新增回归覆盖：显式 ZIP 根目录记录、根级普通文件、错根/多根延续拒绝、原始 name 前后空白、三个数组字段的 max/overflow 边界，并分别经过 browser、content、archive、schema adapter。

## 本地打包与 lifecycle 客观证据

`/tmp/poo-37-shared-fix-round4-final/proof.json` 记录本地候选包 `@z-h-ai/shared@0.13.2`：

- tarball：`z-h-ai-shared-0.13.2.tgz`
- SHA-256：`cb8ffc1d2b38545d64485c413cbf4835958ae201d541a63b207a7c19ef035f56`
- frozen `npm ci`、CJS require、ESM import、TypeScript、Next production build/route/client build、browser metadata contract、negative tarball boundary 均为 `passed`。
- `/tmp/poo-37-shared-fix-round4-final/lifecycle-proof.json`：exit code `0`、`processGroupReaped: true`、无存活子进程。

该证据是本地打包候选的 clean-install/lifecycle proof；`gitSnapshotClean` 为 `false`，并非 GitHub Packages registry 发布证据。

## 未处理的外部决策

未创建 tag、未 push、未尝试 registry 发布。`shared-v0.13.2` tag、GitHub Packages release 与 registry clean-install 仍需要外部授权，按 policy 延后处理。
