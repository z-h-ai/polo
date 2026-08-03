# POO-26 Implement Report

## 变更摘要

- 将 shared package 与 Polo 仓库内所有消费点从 `@polo-ai/shared` 统一迁移到 `@z-h-ai/shared`，版本提升到 `0.11.0`，同步更新 workspace dependencies、TypeScript paths、测试 mock、构建引用和 `bun.lock`。
- 固定 GitHub Packages 私有发布边界：`publishConfig.registry=https://npm.pkg.github.com`、`access=restricted`，Creator Skill 两个公开入口同时提供生成后的 CommonJS runtime 与 `.d.ts`，不让跨仓消费者编译 `src/creator-skills/**`。
- 删除旧的手工 public declaration shadow files；新增 npm pack 负向过滤，制品不包含 Creator Skill 私有源码、测试、开发者绝对路径、未追踪手工文件或 `workspace:*` 依赖。
- 重写 clean-consumer proof：在系统临时目录创建无 Polo/Admin sibling 的最小消费者，生成 lockfile 后删除 install tree，再执行 frozen `npm ci`；验证 CommonJS、ESM、TypeScript 6、Next.js 16/Turbopack production build、真实 `next start` API route，以及 POO-21 fixture metadata/manifest/contentDigest 基线。
- 新增 `shared-v*` GitHub Actions 发布工作流：tag/version gate 后只 pack 一次，验证同一 tarball，再对同一文件执行 GitHub build-provenance attestation 和 `npm publish`，并保留 SHA、npm integrity、frozen lock 与 registry metadata 证据。
- 新增 POL-59 交接文档，明确版本/registry、公开 exports、验证命令、token 注入规则、迁移步骤、独立验收边界和回滚方式。

## 关键文件列表

- `packages/shared/package.json`
- `packages/shared/scripts/verify-creator-skills-package.ts`
- `packages/shared/scripts/build-creator-skills.ts`
- `packages/shared/src/.npmignore`
- `packages/shared/dist/creator-skills/**`
- `.github/workflows/publish-shared-package.yml`
- `docs/shared-package-publishing.md`
- `bun.lock`
- Polo 内所有原 `@polo-ai/shared` workspace dependency、import、TypeScript path 与测试 mock 消费点

## 自测结果

- `bun install --frozen-lockfile`：通过；新的 workspace package 名称与 `0.11.0` lock metadata 可 frozen 安装。
- `bun run typecheck:all`：通过。
- `bun test packages/shared/src/creator-skills`：通过，73 pass / 0 fail。
- `bun run test`：通过；仓库全量普通测试及逐文件 `*.isolated.ts` 测试全部退出 0。
- `bun run electron:build`：通过；main、preload、renderer、resources、assets 全部构建成功，证明仓库内 namespace 迁移未破坏 Electron bundling。
- `bun run packages/shared/scripts/verify-creator-skills-package.ts --output-dir /tmp/poo26-final-proof.DrxbEv`：通过。
  - tarball：`z-h-ai-shared-0.11.0.tgz`
  - SHA-256：`84639408006e419ecf947d1611ac98704080f702293c1caf9ed9370a0621fb23`
  - npm/frozen-lock integrity：`sha512-GbBN74488syTh4HQtWPQJZhOmEBrFCqSpoyA5USeMvUGR5A+UHuFI3QXGEYNgG49tcxJLJmfZRnkpHpRenbE2Q==`
  - Node `v24.14.0` CommonJS require 与 ESM import：通过。
  - TypeScript `6.0.3` `tsc --noEmit`：通过。
  - Next.js `16.2.7` Turbopack production build + `next start` + 真实 API 请求：通过。
  - fixture slug/frontmatter/metadata/canonical manifest/contentDigest：通过，digest 保持 `f9999556728593a5f0f5f3e22f89b1e86793ae5232f7e11e68324ef82927136c`。
  - Creator Skill 私有源码/测试、所有 package 测试、开发者路径、untracked 手工产物、`workspace:*` 发布依赖负向检查：通过。
- `git diff --check`：通过。
- `bun run lint:shared`：未通过；命中 5 个与本任务无关且本分支未修改的既有 `craft-shared/no-inline-source-auth-check` 错误（`resource-bundle.test.ts`、`token-refresh-manager.test.ts`、`token-refresh-manager.ts`）及 9 个既有 unused-disable warning。本任务修改文件未产生 lint 报错。

## 遗留问题

- 按任务纪律未执行 push，因此尚未创建/推送 `shared-v0.11.0`，也尚未实际向 GitHub Packages 发布；当前本机 tarball 只作为验证制品，不能作为 POL-59 最终依赖来源。
- 发布后仍必须在 GitHub package settings 向 `z-h-ai/polo-admin` 授予 Actions read access，并由 tagged workflow 产出实际 `published-package.json` 和 GitHub artifact attestation。该外部发布/授权门禁完成前，POO-26 的“已发布且 POL-59 可从 registry 安装”验收项应保持 blocker/escalation，不能宣称端到端完成。
- POL-59 仍需独立迁移 dependency/lockfile 并完成 clean `npm ci`、Next production `/api/capabilities`、数据库/对象存储角色边界及 Electron ledger/journal 闭环；shared package proof 不替代 POL-59 验收。
