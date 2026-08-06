# POO-26 实现报告

## 变更摘要

本轮在最新 `dev` 派生的 `POO-26/feat/shared-v0.12.0-contract` 上完成 `@z-h-ai/shared@0.12.0` 候选实现，未合并或 cherry-pick 旧 POO-26 大提交，也未 push、tag 或发布 registry package。

1. Creator Skill upload v2 契约强制 grant 提交 `sizeBytes + archiveChecksum`，grant 响应绑定 expected size/checksum、generation、过期时间和 COS 签名 headers；complete 强制提交同一 generation、size 和 checksum。
2. AdminClient Safety 查询改为直接调用权威 `/api/installed-artifacts/status`，按 `artifactId + version + archiveChecksum` 精确匹配；删除通过 Member Artifact detail 推导 Safety 状态的 fallback。
3. Electron renderer 使用纯浏览器、分块、可取消、恒定内存的增量 SHA-256，正式上传 helper 将同一文件身份贯穿 grant、COS PUT 和 complete；产品 UI 与 Creator Skill E2E 共用该 helper，renderer 不注入隐藏账号 Token。
4. Member detail E2E 改为递归断言不得泄漏 `validationPolicy`、`storageKey`、内部 manifest、validator/checksum/time/issues 等管理和校验元数据。
5. 选择性移植并更新 package publish manifest、staging、clean-consumer、Next/Turbopack route、进程生命周期与 registry proof 基础设施；开发 monorepo 包名保持不变，发布身份由 `packages/shared/package.publish.json` 独立固定为 `@z-h-ai/shared@0.12.0`。

## 关键文件

- `packages/shared/src/creator-skills/{types,schemas}.ts`、`packages/shared/src/admin/client.ts`
  - strict v2 DTO/Zod/AdminClient 与权威 Safety endpoint。
- `packages/server-core/src/handlers/rpc/admin.ts`
  - complete 后对实际 size/checksum fail closed，再触发验证。
- `apps/electron/src/renderer/lib/creator-skill-upload.ts`
  - 纯 renderer 增量 SHA-256、取消、预检与严格上传 helper。
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
  - 正式 UI 的 prepare → grant → PUT → complete 流程。
- `apps/electron/e2e/creator-skill/{main,renderer}.ts`、`scripts/electron-creator-skill-e2e.ts`
  - E2E 共用正式 helper，并更新 Member 脱敏断言。
- `packages/shared/package.publish.json`、`.github/workflows/publish-shared-package.yml`
  - 固定 0.12.0/GitHub Packages 发布身份和同一候选 tarball 的 proof/publish 流程。
- `packages/shared/scripts/{stage-creator-skills-package,verify-creator-skills-package,verify-creator-skills-package-lifecycle,verify-proof-failure-lifecycle}.ts`
  - staging、无 sibling frozen consumer、CJS/ESM、TypeScript、Next 16/Turbopack、真实 route、fixtures、strict v2、负向制品边界及失败生命周期证明。
- `docs/shared-package-publishing.md`
  - 0.12.0 候选、正式发布门禁、registry-backed proof 与 POL-59 下游交接说明。

## 测试命令与结果

- `bun install --frozen-lockfile`
  - 通过；frozen workspace 依赖安装完成。
- `NO_COLOR=1 bun test packages/shared/src/creator-skills/__tests__ packages/shared/src/admin/__tests__/client.test.ts packages/server-core/src/handlers/rpc/admin.test.ts apps/electron/src/renderer/lib/__tests__/creator-skill-upload.test.ts`
  - 通过：147 pass，0 fail，715 expect。
- `NO_COLOR=1 bun test --isolate ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
  - 通过：15 pass，0 fail；有一条既有 React `act(...)` warning，不影响退出码。
- `NO_COLOR=1 bun run typecheck:all`
  - 通过。
- `NO_COLOR=1 bun x tsc --noEmit -p apps/electron/e2e/creator-skill/tsconfig.json`
  - 通过。
- `NO_COLOR=1 bun run electron:build`
  - 通过；main、preload、renderer、resources 与 CLI production build 均成功。
- Electron Creator Skill renderer E2E harness 单独以 `esbuild --platform=browser` 构建，并扫描禁止 `node:crypto`、`node:fs`、`require("crypto")`。
  - 通过；新增实现未把 Node-only API 或依赖带入 renderer。
- `bun run --cwd packages/shared prepack`
  - 通过；生成可发布 staging 产物。
- `bun run --cwd packages/shared test:creator-skills-package-failures`
  - 通过；early-exit、spawn-error 与 wrapper cleanup 均完成，无遗留进程。
- `NO_COLOR=1 bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts --allow-dirty-snapshot --output-dir .pipeline/artifacts/shared-0.12.0-candidate`
  - 通过；CI-style proof 自行退出，SIGTERM 后无强杀、无存活 descendant。
- `git diff --check`
  - 通过。

## 候选 package 证据

- 候选 tarball：`.pipeline/artifacts/shared-0.12.0-candidate/z-h-ai-shared-0.12.0.tgz`
- package：`@z-h-ai/shared@0.12.0`
- registry 配置：`https://npm.pkg.github.com`
- SHA-256：`714f5977adfcf8bfdbff55113fdea402f7281df394f7c7018ec7599bd5c15376`
- npm integrity：`sha512-qF4w7S7Wvud1qclnDxOrBu8nvMa8KIvOd6nYODWpl2yyak5MKmVDmvY30RbMyZqR9tjtxw2B5n4BWTQFXSIvuw==`
- npm shasum：`c622a89cda8d0b25ede51f573ea588f00d54394b`
- fixture canonical digest：`f9999556728593a5f0f5f3e22f89b1e86793ae5232f7e11e68324ef82927136c`
- clean consumer：仓库外临时目录、tarball frozen `npm ci`；CJS、ESM、TypeScript 6.0.3、Next.js 16.2.7/Turbopack production build、真实 route、fixtures、strict upload v2 和负向 tarball 边界全部通过。
- proof 文件：`.pipeline/artifacts/shared-0.12.0-candidate/proof.json`、`lifecycle-proof.json`、`clean-consumer-package-lock.json`。
- 该候选在提交前以 `--allow-dirty-snapshot` 验证，因此 proof 明确记录起始 HEAD `d32b8782562d70fc48bafc86d0253c8df2976e96` 和 `gitSnapshotClean: false`；它是本地候选证据，不冒充 tag、release commit 或 registry 证据。

## 遗留问题与停止边界

- 按 coder 边界未 push、未创建 `shared-v0.12.0` tag、未发布 GitHub Packages，也未执行/伪造 registry-backed proof 或 polo-admin 自身 `GITHUB_TOKEN` package access proof。这些必须在 Ultra-Coding pass 后对正式发布的同一不可变制品执行。
- 本机 `127.0.0.1:3000` Admin 服务不可用，因而未运行依赖隔离 Admin、真实腾讯 COS 和 Electron 的完整 Creator Skill E2E；本轮只完成 production Electron build、renderer helper/E2E harness 编译及相关单测。真实 COS smoke 仍是最终跨仓验收门禁。
- POL-59 仍需在正式 0.12.0 发布后固定 dependency/lockfile、恢复 release gate 并执行其独立业务验收；POO-21 仍需复验 Electron 安装、更新、卸载与 Ledger/journal 闭环。
