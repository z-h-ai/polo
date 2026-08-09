# POO-37 Round 3 修复报告

## 逐项修复结果

1. 共享 browser-safe YAML core 将 `toJS` 的 alias 展开限制为 32，并把 parse、materialization、未知/坏 alias 或 tag 相关异常统一转换为 `invalid_skill_content`、`field: frontmatter`、稳定 message `SKILL.md frontmatter must contain valid YAML metadata`。archive 和 `validateCreatorSkillContent` 均通过该核心传播相同结构化失败，不再泄露 YAML 原始异常。
2. emoji-only icon 校验已移入 `validateCreatorSkillMetadata`。URL、文件路径和带装饰文字的 emoji 都在 browser、content validator、archive 中统一产生 `invalid_skill_content` / `icon` 及同一 message；archive 原有独立 icon 分支已删除。
3. 增加 `resolveCreatorSkillRoot` 单一根目录契约。empty、noise-only、wrong-root（archive/browser 传入预期 slug）和 multiple-root 都返回 `invalid_skill_root`、空 path、`ZIP must contain exactly one root directory matching the Creator Skill slug`；archive 结构检查复用它。
4. package staging 改用仓库现有完整 SemVer 2.0 实现的 `isStrictSemVer`，支持合法 prerelease/build metadata，拒绝 `1.0.0-01`、`1.0.0-alpha.01`、leading-zero core、四段版本和 `v` 前缀。
5. 删除会漂移的公开 `CreatorSkillMetadataSchema`；`SkillVersionMetadataSchema` 现在仅作为 Zod transport adapter，并调用同一个 `validateCreatorSkillMetadata` core。name、description、数组、icon 与根目录规则的生产实现只保留该核心。

## 关键文件

- `packages/shared/src/creator-skills/metadata.ts`
- `packages/shared/src/creator-skills/archive.ts`
- `packages/shared/src/creator-skills/skill-content.ts`
- `packages/shared/src/creator-skills/schemas.ts`
- `packages/shared/src/admin/semver.ts`
- `packages/shared/scripts/stage-creator-skills-package.ts`
- `packages/shared/src/creator-skills/__tests__/{metadata,archive,skill-content,schemas}.test.ts`
- `packages/shared/src/admin/__tests__/semver.test.ts`

## 执行命令与结果

- `bun run --cwd packages/shared build:creator-skills`：通过。
- `bun run typecheck:shared`：通过。
- `bun test packages/shared/src/creator-skills/__tests__ packages/shared/src/admin/__tests__/semver.test.ts`：98 pass、0 fail、581 assertions。覆盖 alias 限制、稳定 YAML 错误、三类非法 icon、empty/noise-only/wrong/multiple root、严格 UTF-8、包装噪音、无 Node global browser runtime 与 SemVer 边界。
- `bun run --cwd packages/shared test:creator-skills-package-failures`：通过（early-exit、spawn-error、wrapper spawn-error lifecycle）。
- `git diff --check`：通过。
- `bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts --allow-dirty-snapshot --output-dir /tmp/poo-37-shared-fix-round3-final`：通过。客观产物为 `/tmp/poo-37-shared-fix-round3-final/proof.json` 与 `lifecycle-proof.json`；local tarball SHA-256 为 `97603727521ac1715502fb99faab29e9567ff8cd0c0630f5c1a09b8171f103fd`，npm integrity 为 `sha512-5cZPU1RL8pWcffJ86wSSAgTW0THwkA79nyNnGzF+ha96JmG5yhm/IWqWbdZQgtwlkdCg9i4TsniO3bZJu16EdQ==`。proof 中 `npm ci` frozen install、CJS/ESM、TypeScript、Next production route/client build、browser metadata contract 与 tarball boundary 均为 passed；Next SIGTERM 退出 `forcedKill: false`，lifecycle proof `exitCode: 0`、`processGroupReaped: true`。

## 未处理的外部发布授权

未创建 `shared-v0.13.2` tag、未 push、未发布 GitHub Packages，也未执行 registry-backed clean install。上述仅为本地候选 tarball 的冻结 clean-install/lifecycle 证据，不能替代 registry release 或 registry 验证。
