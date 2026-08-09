# POO-37 修复报告（round 1）

## 修复结果

1. `metadata.browser` 已改为真正 browser-safe：metadata parser 不再导入 `gray-matter`、Zod 或任何 Node 模块。构建后的 `metadata.browser.mjs` 已静态检查，不含 `Buffer`、`process`、`require` 或 `node:`；package verifier 现在将这些标记视为失败。`package-exports` 测试实际以 `Buffer`、`process`、`require` 全部为 `undefined` 的 Node ESM 环境加载 browser bundle 并运行 parser，通过。
2. archive validator 不再对 `SKILL.md` 调用 `Buffer.toString('utf8')`。它把原始 `Uint8Array` 交给 browser-safe parser 的 `TextDecoder('utf-8', { fatal: true })`，非法 UTF-8 在两端均返回 `invalid_skill_utf8`、同一路径和同一消息。
3. `__MACOSX`、`.DS_Store`、`Thumbs.db`、`desktop.ini`、AppleDouble（`._*`）过滤已移入 `metadata.ts:isCreatorSkillPackagingNoise`。archive 和 browser parser 复用这一函数；两端的回归测试均已覆盖。
4. 发布包重新构建并通过 tarball frozen clean-install、CJS/ESM/root import、browser metadata import、Next production build/route 与 CI-style process lifecycle proof。

## 关键文件

- `packages/shared/src/creator-skills/metadata.ts`
- `packages/shared/src/creator-skills/archive.ts`
- `packages/shared/src/creator-skills/__tests__/metadata.test.ts`
- `packages/shared/src/creator-skills/__tests__/archive.test.ts`
- `packages/shared/src/creator-skills/__tests__/package-exports.test.ts`
- `packages/shared/scripts/verify-creator-skills-package.ts`
- `packages/shared/dist/creator-skills/metadata.browser.{cjs,mjs}`

## 执行命令与结果

| 命令 | 结果 |
| --- | --- |
| `bun run --cwd packages/shared build:creator-skills` | 通过；browser bundle 静态扫描未发现 `Buffer`/`process`/`require`/`node:` |
| `bun test packages/shared/src/creator-skills/__tests__` | 84 passed, 0 failed |
| `bun run typecheck:shared` | 通过 |
| `bun run --cwd packages/shared test:creator-skills-package-failures` | 通过（3 个 lifecycle regression） |
| `bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts --allow-dirty-snapshot --output-dir /tmp/poo-37-shared-fix-round1-lifecycle` | 通过；`proof.json` 和 `lifecycle-proof.json` 均已生成 |

## 打包 / lifecycle 证据

- tarball: `/tmp/poo-37-shared-fix-round1-lifecycle/z-h-ai-shared-0.13.2.tgz`
- SHA-256: `fb67a5433be791329ffd58117fc8994e2b571a0eeeec9f5e3db455e2928275b3`
- integrity: `sha512-vdqrRjW69hzJLtmuC3Dc1ZzbbO9w+4PwSas7N/+mJnASHKClNj/8QNDHZcFx8jxqVLst5hX+cr8BcQpVwemFeQ==`
- shasum: `a19be692955adfa43cd7a2c79cdd146ae04ba910`
- frozen clean-consumer lock integrity 与上述 integrity 一致。
- `lifecycle-proof.json`: exit code 0、无 exit signal、process group 已回收、无需强制终止。

## 未处理的外部发布决策

未创建 tag、未 push、未发布 GitHub Packages。是否推送 `shared-v0.13.2` 并执行 registry-backed clean install 仍需外部发布授权；本轮不将本地 tarball proof 误报为 registry 发布成功。
