# POO-26 Reviewer Round 1 修复报告

## 修复映射

### 1. complete-upload generation fail closed

- `packages/server-core/src/handlers/rpc/admin.ts`
  - 在 checksum、size 核对和 validation 触发之前，强制比较
    `completed.uploadGeneration === input.data.uploadGeneration`。
  - generation 不一致返回 `version_conflict`，不会触发 validation，也不会失效 catalog cache。
- `packages/server-core/src/handlers/rpc/admin.test.ts`
  - 新增负向测试：请求 generation 为 `1`、Admin completion 返回 `2` 时 RPC 拒绝；调用记录中只有 complete，没有 `triggerCreatorSkillValidation`。

### 2. Member detail 完全脱敏 uploadGeneration

- `packages/shared/src/creator-skills/{types,schemas}.ts`
  - 将 detail/public `CreatorArtifactVersion` 与 manager-only
    `CreatorArtifactManagerVersion` 拆分。
  - `CreatorArtifactDetailSchema` 使用不含 `uploadGeneration` 的 detail version schema；完全脱敏的 Member 响应可解析，Admin 意外携带该字段时 Zod 会在对外结果中剥离。
  - manager mutation schema 继续强制 `uploadGeneration`，未放松 strict v2 complete 边界。
- `packages/shared/src/admin/client.ts`、`packages/server-core/src/handlers/rpc/admin.ts`
  - manager mutation 使用 manager version；detail 在 AdminClient 和 RPC 边界均执行脱敏 schema。
- `packages/shared/src/creator-skills/__tests__/schemas.test.ts`
  - 证明不含 generation 的 Member detail 可解析、携带 generation 时结果被剥离，以及 manager mutation 缺 generation 时仍拒绝。
- `packages/shared/src/admin/__tests__/client.test.ts`
  - 证明 AdminClient 对 Member detail 的公开结果不携带 generation。
- `packages/server-core/src/handlers/rpc/admin.test.ts`
  - 证明 RPC 再次收紧响应边界，不向 Electron 返回 generation。
- `apps/electron/e2e/creator-skill/main.ts`
  - 将 `uploadGeneration` 加入 Member detail 递归 forbidden field 集合。

## 测试命令与结果

- `NO_COLOR=1 bun test packages/shared/src/creator-skills/__tests__/schemas.test.ts packages/shared/src/admin/__tests__/client.test.ts packages/server-core/src/handlers/rpc/admin.test.ts apps/electron/src/renderer/lib/__tests__/creator-skill-upload.test.ts`
  - 通过：88 pass，0 fail，333 expect。
- `NO_COLOR=1 bun run typecheck:all`
  - 通过：core、shared、server-core、server、session-tools-core、pi-agent-server、Electron、UI 全部退出 0。
- `NO_COLOR=1 bun x tsc --noEmit -p apps/electron/e2e/creator-skill/tsconfig.json`
  - 通过；更新后的递归脱敏断言与 E2E harness 类型正确。
- `NO_COLOR=1 bun run --cwd packages/shared prepack`
  - 通过；重新生成 Creator Skill 公开运行时与声明制品。
- `NO_COLOR=1 bun run packages/shared/scripts/verify-creator-skills-package-lifecycle.ts --allow-dirty-snapshot --output-dir .pipeline/artifacts/shared-0.12.0-round1-candidate`
  - 通过：仓库外 frozen clean install、CJS/ESM、TypeScript 6.0.3、Next.js 16.2.7/Turbopack production build、真实 route、fixtures、strict upload v2、负向 tarball 边界与进程生命周期全部通过。
- `git diff --check`
  - 通过。

## Round 1 候选 package 证据

- tarball：`.pipeline/artifacts/shared-0.12.0-round1-candidate/z-h-ai-shared-0.12.0.tgz`
- SHA-256：`385609a812223c7dc3c947689bd915e68c69c7ff970247e0ea303059c3c98711`
- npm integrity：`sha512-vWHogrXE3i7MqP3V6XgHv6ucCtwYzwnzarCUPAmwAUP76XX7OFykox5DpddRz3m1xYKOymYM+Hm7coxev7yj1w==`
- npm shasum：`b5985703912ebfa02c171adbdee2c167d5408a0e`
- fixture digest：`f9999556728593a5f0f5f3e22f89b1e86793ae5232f7e11e68324ef82927136c`
- proof：`.pipeline/artifacts/shared-0.12.0-round1-candidate/proof.json`、`lifecycle-proof.json`、`clean-consumer-package-lock.json`
- proof 明确记录基线 commit `1257d83cd10a4bd6a370500bf7fe60b044d375ca`、`gitSnapshotClean: false`、无 tag；这是 reviewer fix 提交前的本地候选，未冒充 registry 发布证据。

## 剩余外部门禁

- 本任务 frontmatter 为 `e2e: false`，未运行依赖本机 Admin、隔离 PostgreSQL、真实腾讯 COS 的完整 Electron E2E，也未伪造 smoke 结果；该门禁属于 POL-59 后续验收，不是本轮代码失败。
- 未 push、未创建 `shared-v0.12.0` tag、未发布 GitHub Packages，未运行 registry-backed frozen proof 或 polo-admin 自身 `GITHUB_TOKEN` package access proof。
- 既有 strict v2、两个公开 package exports、renderer browser-only SHA-256 和候选发布边界保持不变；本轮未扩大到 POL-59/POO-21 业务实现。
