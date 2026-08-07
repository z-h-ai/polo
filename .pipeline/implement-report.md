# POO-29 实现报告

## 变更摘要

- Creator Space 中选择 **Web App** 后，入口先展示两种面向结果的发布方式：
  - **已上线网站（推荐）**：填写 HTTPS 地址，Polo 直接创建并发布。
  - **上传应用**：拖入可运行 ZIP 或文件夹，Polo 自动分析入口并准备平台发布包；仅在无法唯一确定入口时追加询问。
- 发布入口不再要求或展示 `polo-app.json`、`appId`、checksum、平台或架构等平台内部交付物。
- 进入 Organization Console 时保持传入 `organizationId`：`/organization-apps?organizationId=<来源组织>`，使已登录发布页可默认选中来源组织。
- 所有支持语言补齐相同的 Creator 文案，避免不同语言重新暴露旧的 Manifest/ZIP 根目录约束。

## 关键文件列表

- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
  - Web App 发布入口改为双路径说明，并保留携带来源组织 ID 的跳转。
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
  - 回归验证 Creator 不见平台 Bundle 字段，且跳转 URL 携带 `organizationId`。
- `packages/shared/src/i18n/locales/{de,en,es,hu,ja,pl,zh-Hans}.json`
  - 新增并对齐 Web App 发布入口文案。

## 自测结果

- `NO_COLOR=1 bun test --isolate ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
  - 通过：16 pass，0 fail，75 expect；测试运行时输出了一条既有异步轮询的 React `act(...)` 警告，不影响结果。
- `NO_COLOR=1 bun run lint:i18n:parity`
  - 通过：6 个非英语 locale、每个 1933 keys。
- `NO_COLOR=1 bun run lint:i18n:coverage`
  - 通过：所有静态翻译键均可解析。
- `NO_COLOR=1 bun scripts/sort-locales.ts --check`
  - 通过。
- `NO_COLOR=1 bun run typecheck:shared`
  - 通过。
- `NO_COLOR=1 bun run typecheck:electron`
  - 通过。
- `NO_COLOR=1 bun x eslint src/renderer/components/organization/CreatorArtifactsPanel.tsx src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
  - 通过。
- `NO_COLOR=1 bun run test`
  - 通过（普通测试及隔离测试脚本均以退出码 0 结束）。
- `git diff --check`
  - 通过。

## 遗留问题

- 本 worktree 只包含 Polo Creator/Electron 入口；Polo Admin 内的自动草稿、Bundle 重打包和最终发布服务由既有 Organization Console 路径承接，本轮未越过仓库边界修改该服务。
- 本轮没有已知的 Creator 入口实现遗留问题；仍需独立 reviewer 按完整跨仓库发布流程验收。
