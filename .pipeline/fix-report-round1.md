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
---

# POO-29 Review 第 1 轮修复报告

## 问题处理结果

1. 发布方式卡片不可交互
   - 已将“已上线网站”和“上传应用”改为可选择的按钮；选择后只展示该模式必要的输入。
   - 网站路径收集应用名称和 HTTPS URL；上传路径收集应用名称和可运行 ZIP 文件。两条路径分别跳转到明确的 Console 路由：`/organization-apps/publish?organizationId=...&mode=website|upload`。
   - 交互测试分别验证网站和上传路径的模式、来源组织、默认可见范围及 Creator 提供字段。

2. payload 发布契约与 Bundle 安全边界
   - 新增 `@polo-ai/shared/admin` 的可执行、纯函数发布契约：安全路径/重复路径/符号链接/嵌套归档拒绝，static、带锁文件的 Python、JS/Next standalone 识别，歧义入口最少追问，以及结果导向的 POL-65 错误。
   - 平台拥有的 Manifest 固定写入服务端 `appId`、版本、运行时、入口、健康检查、webPath 和 `permissions: []`；旧 `polo-app.json` 仅作入口提示且在最终 canonical bundle 中被重写。最终 canonical 输入会稳定排序并计算 SHA-256/size。
   - 当前 worktree 不包含 Polo Admin HTTP 服务实现；共享契约是该服务的可导入、可测试边界，Electron 只传 Creator 字段和发布模式，不传 `appId`、Manifest、checksum、平台或架构。

3. 来源组织选择
   - 发布 URL 将 `organizationId` 和 `mode` 作为固定查询契约传递给 Console。
   - 共享 resolver 仅在请求组织属于当前可用组织列表时采纳；无权限或失效组织会回退到合法默认组织（无默认时为 `null`）。已覆盖正常与失效来源组织。

4. `build-cli-artifacts` 全量测试超时
   - 已复现：生产 `electron:build` 在 CLI 构建阶段才发现测试专用输出变量，导致 5 秒测试超时。
   - 在 `electron:build` 和 `electron:dist` 的首步骤加入 fail-closed 环境检查；带 `POLO_AI_CLI_ARTIFACT_OUTPUT_DIR` 的生产命令现在在构建前立即失败，不会生成或验证陈旧默认产物。

## 关键文件

- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
- `packages/shared/src/admin/creator-app-publishing.ts`
- `packages/shared/src/admin/__tests__/creator-app-publishing.test.ts`
- `apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts`
- `scripts/assert-production-electron-output.ts`
- `package.json`

## 实际测试

- `NO_COLOR=1 bun test packages/shared/src/admin/__tests__/creator-app-publishing.test.ts`：6 pass，0 fail。
- `NO_COLOR=1 bun test --isolate ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`：17 pass，0 fail。
- `NO_COLOR=1 bun test apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts --test-name-pattern 'platform-generated Creator App manifest'`：1 pass，0 fail。
- `NO_COLOR=1 bun test scripts/build-cli-artifacts.test.ts`：2 pass，0 fail；此前超时场景已在 45ms 内 fail closed。
- `NO_COLOR=1 bun run test`：通过，退出码 0。
- `NO_COLOR=1 bash scripts/run-isolated-tests.sh`：通过，退出码 0。
- `NO_COLOR=1 bun run typecheck:all`：通过。
- `NO_COLOR=1 bun run lint:i18n:parity`、`NO_COLOR=1 bun run lint:i18n:coverage`、`NO_COLOR=1 bun scripts/sort-locales.ts --check`：通过。
- `git diff --check`：通过。

## 遗留问题

- Polo Admin 的 HTTP 路由及生产归档存储不在本 worktree；该服务应直接调用本轮新增的共享发布契约完成真实上传、重打包和发布。当前 Electron/Console 交接已使用固定、测试覆盖的 mode + organizationId 查询契约。

---

# POO-36 Review Round 1 修复报告

## 处理结果

1. 缓存契约统一
   - `install-app.sh` 继续由 `updates-static` Caddy 按 `no-cache` 提供；发布验证器不再将其误判为 immutable。
   - 新增真实 Caddy 容器回归测试，覆盖 installer、manifest、contract 的 `no-cache` 与二进制的 immutable 缓存头，以及 POST 405。

2. 公网验收后的确认与失败回滚
   - 公网验证改为可观测的 `public-verify` 步骤。失败时同一 `updates-static-v4` Service Exec 调用 `publish-electron-release.ts rollback-failed`，之后 job 明确失败，Draft Release 不会发布。
   - 成功时 Service Exec 调用 `confirm` 清除 rollback marker；确认完成后才进入 `publish-release`。

3. signed object-store URL 脱敏
   - GitHub API 重定向后的 object-store fetch、响应和流式写入都被稳定错误边界包裹；异常不保留 cause、签名 URL、query 或 header。
   - 回归测试使用含模拟 `X-Amz-Signature` 的本地重定向，断言错误消息不泄露签名并且 token 不会转发到 object store。

4. 下载前峰值容量与 incoming 重试安全
   - 首次下载前按 Draft Release 资产总量的两倍（incoming + 原子发布复制）计算 70% 峰值容量，未通过时不会创建 incoming 目录或下载任何资产。
   - 当前调用创建的 `.incoming/<version>` 在 publish 失败时清理；已有 incoming 仅在完整 release contract/manifest 校验和所有资产大小与 Draft Release 一致时复用，不会重下或绕过发布器容量门槛。

5. Windows 工作流断言更新
   - `electron-artifact-pipeline` 现在要求 `windows-latest`、Windows x64 NSIS `.exe`、明确 `NotSigned` Authenticode 检查与 artifact 上传，同时断言 `updater: false`/`matrix.updater` 边界存在。

## 关键文件

- `.github/workflows/electron-release.yml`
- `scripts/electron-release-bundle.ts`
- `scripts/polo-release-pull.ts`
- `scripts/polo-release-pull.test.ts`
- `infra/updates-static/PoloCaddyfile.test.ts`
- `scripts/electron-release-workflow.test.ts`
- `scripts/__tests__/electron-artifact-pipeline.test.ts`

## 实际测试

- `NO_COLOR=1 bun test scripts/polo-release-pull.test.ts scripts/electron-release-bundle.test.ts infra/updates-static/PoloCaddyfile.test.ts scripts/electron-release-workflow.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts`
  - 通过：25 pass、365 expects、0 fail。
- `NO_COLOR=1 bun run test`
  - 通过；包含仓库标准 `bun test --isolate` 与 `scripts/run-isolated-tests.sh`。
- `git diff --check`
  - 通过。

## 遗留问题

- 真实 tag 联调仍依赖生产 Environment 的 Zeabur token/service/environment 配置，以及 `updates-static-v4` 服务上的最小只读 `GH_TOKEN`；本轮未使用真实 token、生产 PVC 或执行 push。
