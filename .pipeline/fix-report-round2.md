# POO-37 Round 2 修复报告

## 逐项修复结果

1. `metadata.ts` 现在是 archive、browser export 与 Creator server content validation 共用的 browser-safe YAML/元数据核心。它使用浏览器可运行的 `yaml` 解析完整 frontmatter，覆盖 folded scalar、block scalar、嵌套字段和 inline comment；`description` 不是非空字符串时统一返回 `invalid_skill_content` / `description`。发布 manifest 声明 `yaml` 依赖，且 browser runtime 测试在 `Buffer`、`process`、`require` 均为 `undefined` 时实际解析成功。
2. 归并 `SKILL.md` 入口契约：缺失、仅嵌套、大小写变体及多个候选均由共享核心返回同一个 `skill_file_count`、`<root>/SKILL.md` 与相同 message。archive validator 仅透传该核心 issue，不再保留会漂移的独立 basename 校验。
3. 恢复正文非空要求。browser/archive 的错误为 `invalid_skill_content`，`field: content`、统一 message/suggestion；`validateCreatorSkillContent` 同时保留该 code 并把 field 映射到 server content-validation 的 `path`。
4. 保留 Round 1 的严格 UTF-8 解码与包装噪音单一过滤契约。package verifier 会在去除注释和字面量后拒绝可执行代码中的 `Buffer`、`process`、`require` 及 `node:*` builtin 引用；它不会把 YAML 库内部仅用于错误文本的单词误报为运行时依赖。

## 关键文件

- `packages/shared/src/creator-skills/metadata.ts`
- `packages/shared/src/creator-skills/archive.ts`
- `packages/shared/src/creator-skills/skill-content.ts`
- `packages/shared/src/creator-skills/__tests__/metadata.test.ts`
- `packages/shared/src/creator-skills/__tests__/archive.test.ts`
- `packages/shared/src/creator-skills/__tests__/skill-content.test.ts`
- `packages/shared/scripts/verify-creator-skills-package.ts`
- `packages/shared/package.json`
- `packages/shared/package.publish.json`

## 执行命令与结果

- `bun install --frozen-lockfile`：通过。
- `bun run --cwd packages/shared build:creator-skills`：通过。
- `bun test packages/shared/src/creator-skills/__tests__`：89 pass、0 fail、493 assertions；包含无 Node global browser runtime、严格 UTF-8、包装噪音、真实 YAML、四种 `SKILL.md` 候选布局和空正文回归。
- `bun run typecheck:shared`：通过。
- `bun run --cwd packages/shared test:creator-skills-package-failures`：通过（early-exit、spawn-error、wrapper spawn-error 生命周期回归）。
- `git diff --check`：通过。
- `bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts --allow-dirty-snapshot --output-dir /tmp/poo-37-shared-fix-round2-final`：通过。客观产物为 `/tmp/poo-37-shared-fix-round2-final/proof.json` 与 `lifecycle-proof.json`；本地 tarball SHA-256 为 `1bd1c127a5d5bf4a4b32f5ed76f4e9bb1e69ff219b4de7e46a82f3ef2a4f46ef`，npm integrity 为 `sha512-74tmw0Xde/+Y18b24rM8MoXd2FzseqPj4odkVyCE/nhcvcC4VFyoKtd6xbP/lcM7faC1ZTbhAouX3kIkLS8kzA==`。该 proof 的 `npm ci` frozen install、CommonJS/ESM import、TypeScript、Next production build/route/client build、browser metadata contract 均为 passed；生产 Next 进程 SIGTERM 退出，`forcedKill: false`，生命周期 proof `exitCode: 0` 且 `processGroupReaped: true`。

## 尚未处理的外部发布决策

未创建 `shared-v0.13.2` tag、未 push、未发布 GitHub Packages，也未执行 registry-backed clean install。这些是 policy 延后的外部授权事项；上面的证据仅证明本地候选 tarball 的冻结 clean-install，不能替代 registry release 或 registry 证据。
