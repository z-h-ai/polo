# POO-37 实现报告

## 变更摘要

- 移除了 Creator Skill ZIP 对 `SKILL.md`、`icon.png`、`references/` 的业务路径白名单；根目录下普通文件和任意业务目录（包括 `agents/`、`scripts/`、`assets/`、`templates/`、自定义目录）现在可通过。
- 保留 ZIP 安全边界：路径穿越/绝对路径、链接与特殊文件、重复或大小写冲突、嵌套压缩包、原生可执行文件、PNG 校验、ZIP bomb、文件数及大小上限仍由 archive validator 执行。
- Creator `SKILL.md` 契约现在要求 `name` 为 1–64 字符严格 kebab-case、`description` 为 1–1024 字符，并要求 `name` 与 ZIP 根目录一致。
- 新增 browser-safe `@z-h-ai/shared/creator-skills/metadata`：接收标准化 ZIP entries，定位唯一根级 `SKILL.md`，返回严格校验后的 `slug`/metadata；其浏览器 bundle 不含 Node-only 依赖。服务端 archive validator 复用该 parser 的元数据和根目录契约。
- 发布 manifest 升级为 `@z-h-ai/shared@0.13.2`；保留 monorepo 内部名 `@polo-ai/shared`。发布包同时暴露 root、Creator Skill、fixtures、metadata、Creator App publishing 入口。
- staging 不再硬编码版本号，改为校验 `@z-h-ai/shared` 和合法 SemVer。

## 关键文件

- `packages/shared/src/creator-skills/archive.ts`
- `packages/shared/src/creator-skills/metadata.ts`
- `packages/shared/src/creator-skills/skill-content.ts`
- `packages/shared/package.json`
- `packages/shared/package.publish.json`
- `packages/shared/scripts/build-creator-skills.ts`
- `packages/shared/scripts/stage-creator-skills-package.ts`
- `packages/shared/scripts/verify-creator-skills-package.ts`
- `packages/shared/src/creator-skills/__tests__/archive.test.ts`
- `packages/shared/src/creator-skills/__tests__/metadata.test.ts`

## 自测命令与结果

| 命令 | 结果 |
| --- | --- |
| `bun install --frozen-lockfile` | 通过 |
| `bun run typecheck:shared` | 通过 |
| `bun test packages/shared/src/creator-skills/__tests__` | 81 passed, 0 failed |
| `bun run --cwd packages/shared test:creator-skills-package-failures` | 通过（3 个 lifecycle regression） |
| `bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts --allow-dirty-snapshot --output-dir /tmp/poo-37-shared-proof-v3` | 通过；tarball clean consumer、冻结安装、CJS/ESM/root import、浏览器 metadata import、TypeScript、Next production build/route/lifecycle 全部通过 |

## 打包与 clean-install 证据

本地候选包已由上述 lifecycle proof 生成并验证：

- tarball: `/tmp/poo-37-shared-proof-v3/z-h-ai-shared-0.13.2.tgz`
- SHA-256: `1832b1302f73e1c7657ab88ee034f283e8273e08c2f4d87daa42f2dc6d3251c2`
- npm integrity: `sha512-gRAjluY90OYS6x5SoBXSapSo9GO3+MoFH1+cHkQ5uiZnqiRTMhBvHBngSLMTZdNqMabSQdDJqw9hkg8AqPilww==`
- npm shasum: `5b3e05ac178fdaab279a62e7027731d5edb67fdf`
- frozen consumer lock integrity 与上述 integrity 一致；proof 中 Node 24.14.0、TypeScript 6.0.3、Next 16.2.7 Turbopack 均通过。

## 发布与 registry 证据

未创建/推送 `shared-v0.13.2` tag，未发布 registry：任务纪律明确要求不 push，现有 GitHub Actions 仅在 tag push 后发布。因此不能把本地 tarball 误报为 registry 证据。

已尝试只读查询：

```sh
NODE_AUTH_TOKEN="$(gh auth token)" npm view '@z-h-ai/shared@0.13.2' name version dist.tarball dist.integrity dist.shasum --json --registry https://npm.pkg.github.com
```

结果为 `E401 Unauthorized`（当前 CLI token 未向 npm 提供 GitHub Packages 认证）。因此 registry 版本、tarball URL、registry integrity、registry-backed frozen clean install 均尚无客观证据。

## 遗留问题

1. 需要 Orchestrator 在允许 push 的最终收尾阶段，将实现 commit 打 `shared-v0.13.2` tag 并推送，以触发 `.github/workflows/publish-shared-package.yml`。
2. workflow 成功后，必须下载其 `published-package.json` 并执行 registry mode 的 `verify-creator-skills-package-lifecycle.ts --registry-version 0.13.2 ...`；在该步骤完成前，POL-70 不应声称 registry 依赖已可用。
