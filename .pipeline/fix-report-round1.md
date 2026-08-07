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
