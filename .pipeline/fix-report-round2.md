# POO-21 Reviewer Round 2 修复报告

## 逐项处理结果

### 1. `SKILLS_DELETE` 路径穿越可删除 workspace

已修复。

- 将 DELETE RPC 改为单对象入参，并使用 `.strict()` 的 `DeleteSkillRpcInputSchema`；`skillSlug` 复用共享 `SkillSlugSchema`，在进入 workspace 文件操作前拒绝路径穿越、绝对路径、分隔符和未知字段。
- `deleteSkill()` 增加纵深防御：规范化并 `realpath` workspace、skills 根目录和目标目录，逐层验证严格子目录边界，并拒绝符号链接目标后才允许递归删除。
- Electron API 和两个 renderer 调用点同步迁移到严格对象契约。
- 新增 schema、RPC 与底层存储回归测试，覆盖 `..`、`../x`、绝对路径、正反斜杠混合路径、未知字段和符号链接越界；每次攻击后均断言 workspace 根及外部 sentinel 仍存在。

关键文件：

- `packages/shared/src/creator-skills/schemas.ts`
- `packages/server-core/src/handlers/rpc/skills.ts`
- `packages/shared/src/skills/storage.ts`
- `apps/electron/src/shared/types.ts`
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- `apps/electron/src/renderer/pages/SkillInfoPage.tsx`
- `packages/shared/src/creator-skills/__tests__/schemas.test.ts`
- `packages/shared/src/skills/__tests__/storage.test.ts`
- `packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`

### 2. 目录 fsync 不支持时过早删除 transaction backup

已修复。

- journal 仍先执行临时文件写入、文件 `fsync` 和原子 rename；随后把父目录 `fsync` 是否可确认作为显式耐久性结果。
- `EINVAL`、`ENOTSUP`、`EISDIR` 不再等价于 durable success。若 committed journal 的目录项无法确认持久化，安装/更新和卸载均保留 operation journal 与可恢复 transaction backup，交由启动恢复完成清理或按仍可见的旧 checkpoint 回滚。
- 只有 committed journal 的父目录同步成功后才删除 transaction backup 和 operation 目录。
- 新增确定性故障注入：模拟 `ENOTSUP` 后验证 backup 保留，并模拟掉电后只恢复出 `ledger_committed` checkpoint，确认旧 Skill 与旧 Ledger 均可恢复；另覆盖 committed 落盘后、backup 删除后和 operation 目录删除后的各清理崩溃点。

关键文件：

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`

### 3. 跨 workspace 同 slug 的安全版本候选串用

已修复。

- 安全版本候选现在携带 `workspaceId`、`artifactId`、`slug`，并以三者组成的完整安装身份索引。
- hook 每次返回前同步按当前 workspace 和当前安装的 artifact 精确选择候选，因此 workspace 切换的首次 render 也不会暴露旧候选；异步旧请求也无法覆盖另一 artifact 的候选槽位。
- 新增两个 workspace 使用相同 slug、不同 artifactId 的切换回归测试，同时验证同 workspace 的 artifact 不匹配也不会展示候选。

关键文件：

- `apps/electron/src/renderer/hooks/useCreatorSkillSafetyMonitor.ts`
- `apps/electron/src/renderer/hooks/__tests__/useCreatorSkillSafetyMonitor.test.ts`

### 4. 五个非英语 locale 的默认 changelog 仍为英文

已修复。

- 补齐德语、西班牙语、匈牙利语、日语和波兰语翻译。
- 新增西班牙语 renderer 交互断言，验证创建首个 Skill 版本时实际显示 `Lanzamiento inicial`。

关键文件：

- `packages/shared/src/i18n/locales/de.json`
- `packages/shared/src/i18n/locales/es.json`
- `packages/shared/src/i18n/locales/hu.json`
- `packages/shared/src/i18n/locales/ja.json`
- `packages/shared/src/i18n/locales/pl.json`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`

## 自测命令与结果

- Creator Skill 定向测试：
  - `bun test packages/shared/src/creator-skills/__tests__/installer.test.ts packages/shared/src/creator-skills/__tests__/schemas.test.ts packages/shared/src/skills/__tests__/storage.test.ts apps/electron/src/renderer/hooks/__tests__/useCreatorSkillSafetyMonitor.test.ts`
  - 55 pass，0 fail；覆盖删除路径攻击、目录 fsync 不支持、清理故障恢复及跨 workspace/artifact 候选隔离。
- RPC 隔离测试：
  - `bun test ./packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`
  - 4 pass，0 fail。
- Renderer 交互隔离测试：
  - `bun test ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
  - 4 pass，0 fail；包含西班牙语默认 changelog 断言。
- Renderer 普通测试：
  - `bun test apps/electron/src/renderer`
  - 464 pass，0 fail。
- 仓库全量测试：
  - `bun run test`
  - 主测试套件 4802 pass、19 skip、0 fail（4821 tests / 365 files）；随后仓库全部 `*.isolated.ts` 均执行通过。
- 全工程类型检查：
  - `bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过。
- Electron production build：
  - `bun run electron:build`
  - main、preload、renderer、resources、assets 构建与校验通过；仅有既有 Vite outDir/chunk-size warning。
- i18n：
  - `bun run lint:i18n:sorted`
  - `bun run lint:i18n:parity`
  - `bun run lint:i18n:coverage`
  - 全部通过；6 个翻译 locale 各 1676 keys。
- 本次 Electron/shared 变更文件 ESLint：0 error。
- `git diff --check`：通过。

## 遗留问题

- Reviewer Round 2 列出的 4 个问题均已修复，无已知功能遗留。
- Electron production build 仍报告仓库既有的 Vite outDir 和大 chunk warning，本次变更未新增构建 warning。
