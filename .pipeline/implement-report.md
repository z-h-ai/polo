# POO-26 修复实现报告

## 变更摘要

- 将 Polo monorepo 内部使用的开发 manifest 与跨仓发布 manifest 分离：开发
  `package.json` 标记为 `private` 并继续保留现有源码 exports，
  `package.publish.json` 只公开
  `@z-h-ai/shared/creator-skills` 和
  `@z-h-ai/shared/creator-skills/fixtures`。
- `prepack` 先构建 Creator Skill CJS 与声明文件，再在 `dist/publish` 生成隔离、
  可重复的 publish staging directory；流程不改写开发 manifest，失败时不会留下
  manifest 备份或半恢复状态。
- 发布制品仅携带 publish manifest、自包含 CJS bundle 和完整声明文件集合；运行时
  依赖已内联，publish manifest 显式声明声明文件所需的 `zod` 类型依赖。
- clean-consumer proof 改为只打包 staging directory，并新增 publish exports 精确集合、
  禁止 `src/*.ts` runtime target、tarball 文件 allowlist，以及 package root、
  `/protocol`、`/package.json` 在 CJS/ESM 下均返回
  `ERR_PACKAGE_PATH_NOT_EXPORTED` 的负向验证。
- 恢复 `0.7.0` 历史 release note 中当时的 `@polo-ai/shared/protocol` 包名。
- 更新 POL-59 交接文档，明确当前只有候选制品，tag、GitHub Packages package、
  access grant、attestation 和 registry-backed proof 尚未产生；补充破坏性边界、
  回滚和发布后 registry 验证步骤。

## 关键文件列表

- `packages/shared/package.json`
- `packages/shared/package.publish.json`
- `packages/shared/scripts/stage-creator-skills-package.ts`
- `packages/shared/scripts/verify-creator-skills-package.ts`
- `docs/shared-package-publishing.md`
- `apps/electron/resources/release-notes/0.7.0.md`
- `.pipeline/implement-report.md`

## 自测结果

### Shared package 全量测试

```sh
bun run --cwd packages/shared test
```

结果：通过，`3021 pass / 18 skip / 0 fail`，共 3039 tests、6914 assertions。

### 独立 clean-consumer package proof

```sh
bun run packages/shared/scripts/verify-creator-skills-package.ts \
  --output-dir "$(mktemp -d /tmp/z-h-ai-shared-proof.XXXXXX)"
```

结果：通过。已实际完成：

- staging publish manifest 与 tarball allowlist 检查；
- 无 sibling checkout 的临时消费者 lockfile 生成、删除安装树后 `npm ci`；
- Node CJS require 与 ESM import；
- package root 和未支持 subpaths 的 CJS/ESM 负向解析；
- TypeScript 6.0.3 `tsc --noEmit`；
- Next.js 16.2.7 Turbopack production build；
- `next start` 后真实请求 `/api/shared-skill-proof`；
- fixture slug、metadata 与 canonical contentDigest
  `f9999556728593a5f0f5f3e22f89b1e86793ae5232f7e11e68324ef82927136c`；
- tarball 不含源码、测试、开发者绝对路径、额外手工文件或 `workspace:*` 依赖。

本轮候选 tarball SHA-256：
`25fd5d8d61013b6ce01692117f8b75d7220f8390ce31e7a7c04994268ff9d067`。

### 基础一致性

```sh
git diff --check
```

结果：通过。

## 遗留问题

- 按本轮 coder 职责未执行 push、tag 或 publish；`shared-v0.11.0`、
  `@z-h-ai/shared@0.11.0`、GitHub artifact attestation 和 package access grant
  仍不存在，不能宣称 registry 发布完成。
- 发布授权方和独立 reviewer 通过后，仍需由 tagged GitHub Actions 发布同一已验证
  tarball，并从 GitHub Packages 精确版本执行 authenticated frozen clean install，
  对齐 registry integrity 后重跑 Node/TypeScript/Next/route/fixture/负向边界验证。
- POL-59 的版本依赖迁移、lockfile、真实 `/api/capabilities`、数据库、对象存储、角色
  和 Electron ledger/journal 验收仍属于下游独立工作。
