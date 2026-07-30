# POO-21 Reviewer Round 4 修复报告

## 逐项处理结果

### 1. 下载与校验窗口内新增的本地修改会被静默覆盖

已修复。

- 安装开始时保存目标 Skill 的完整目录身份，身份由规范化文件集合、大小和逐文件 SHA-256 计算出的 `contentDigest` 表示，并区分目录缺失、扫描成功和不可安全扫描三种状态。
- 下载、解压和最终 Safety Status 复查完成后，在同一个 `workspace + slug` 独占锁内重新扫描目标目录并与初始身份比较。
- 如果目录在准备期间变化且请求没有确认 `backupLocalChanges`，安装以 `creator_skill_conflict + local_changes` 停止，保留旧目录和旧 Ledger。
- 如果用户已确认备份，则根据最新扫描到的旧目录创建永久 `skill-backups` 备份，不再使用早期的 `localModified` 快照。
- 为关闭最终扫描与 rename 之间的窗口，旧目录 rename 到 transaction backup 后会再次扫描已捕获目录；如果该身份再次变化，未确认操作回滚，已确认操作将该最新目录保存为永久备份。
- 新增确定性回归测试，覆盖下载期间修改、`assertCommitAllowed` 期间修改、写 prepared journal 前修改，以及 journal 已落盘后至 rename 前修改。未确认路径均保留修改并返回冲突；确认路径的永久备份包含最后一刻新增文件。

关键文件：

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`

### 2. Artifact A/B 详情请求逆序会覆盖当前选择

已修复。

- Creator Artifact 详情请求增加独立的单调 generation，并同时绑定请求发起时的 `organizationId` 和 `artifactId`。
- 响应只有在 generation、当前 organization、当前 selectedId、响应 artifactId 和响应 organizationId 全部匹配时才能更新 detail、loading、version、issues、reference 或 error 状态。
- 选择变化、组织变化、非 Skill 选择和 effect cleanup 都会使旧请求失效；加载新作品时先清除不属于当前选择的旧详情，避免旧详情上的管理动作短暂可用。
- 额外阻止已失去当前选择身份的业务回调发起详情刷新，避免旧操作取消新作品请求或留下错误 loading 状态。
- 新增交互测试，覆盖 A 请求先发、B 请求后发但先完成的逆序场景，以及 organization 切换后旧组织详情晚到的场景。

关键文件：

- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`

### 3. `icon.png` 仅检查 PNG signature

已修复。

- 服务端与 workspace 安装端继续复用共享 `validateCreatorSkillArchive()`，其中 `icon.png` 改为受限的完整 PNG 解析与解码校验。
- 校验 PNG signature、chunk 完整边界、chunk 类型、每个 chunk 的 CRC-32、唯一且首位的 IHDR、连续 IDAT、最终 IEND、禁止尾随数据、色彩类型与 bit depth、palette 约束、压缩/过滤/interlace 参数。
- IDAT 使用带最大输出长度的 zlib 解压，验证预期 scanline 大小和每行 filter byte。
- 增加 4096 单边尺寸、16,777,216 像素、64 MiB 解码数据和 1,024 chunks 的绝对资源上限，防止图片维度或解码数据耗尽资源。
- 新增有效 PNG 正向测试，并覆盖 signature 后垃圾、截断 chunk、缺 IEND、错误 CRC 和超大尺寸五类恶意图标。

关键文件：

- `packages/shared/src/creator-skills/archive.ts`
- `packages/shared/src/creator-skills/__tests__/archive.test.ts`

### 4. 白名单噪音错误计入平台文件与展开大小策略

已修复。

- ZIP 中央目录的绝对 Entry 硬上限继续统计所有文件、目录和噪音条目，在累计 Entry 内存前拒绝超限。
- 经过路径和条目类型安全检查后，固定白名单噪音会在平台策略计数前被忽略；`maxFileCount`、`maxFileBytes` 和 `maxExpandedBytes` 只统计清理后的业务文件。
- 噪音仍返回 `packaging_noise_removed` warning，且不进入解压、manifest 或 `contentDigest`。
- 新增 200 个零字节 `__MACOSX/**/.DS_Store` 和单个超过业务单文件/展开限制的白名单噪音测试；两者均只产生 warning，合法 Skill 业务文件正常通过。

关键文件：

- `packages/shared/src/creator-skills/archive.ts`
- `packages/shared/src/creator-skills/__tests__/archive.test.ts`

### 5. Skill slug placeholder 为硬编码英文

已修复。

- 新增 `creatorSkills.artifact.slugPlaceholder`，补齐 `en/de/es/hu/ja/pl/zh-Hans` 全部 locale。
- `CreatorArtifactsPanel` 使用 `t('creatorSkills.artifact.slugPlaceholder')` 渲染 placeholder。
- 新增西班牙语交互断言，验证实际输入框显示 locale 对应的 `mi-skill`。
- 同时将作品类型 Select 保持为全生命周期受控组件，消除切换到 Skill 表单时的 React controlled/uncontrolled warning。

关键文件：

- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
- `packages/shared/src/i18n/locales/en.json`
- `packages/shared/src/i18n/locales/de.json`
- `packages/shared/src/i18n/locales/es.json`
- `packages/shared/src/i18n/locales/hu.json`
- `packages/shared/src/i18n/locales/ja.json`
- `packages/shared/src/i18n/locales/pl.json`
- `packages/shared/src/i18n/locales/zh-Hans.json`

## 自测命令与结果

- Creator Skill 定向测试：
  - `bun test packages/shared/src/creator-skills`
  - 39 pass、0 fail；覆盖安装竞态、PNG 完整校验、噪音策略及既有 schema/安装恢复行为。
- Artifact renderer 隔离交互测试：
  - `bun test ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`
  - 9 pass、0 fail；覆盖 A/B 逆序、组织切换晚到和非英语 slug placeholder。
- 仓库全量测试：
  - `bun run test`
  - 主测试套件 4821 pass、19 skip、0 fail（4840 tests / 368 files）；随后仓库全部 `*.isolated.ts` 逐文件执行通过。
- 全工程类型检查：
  - `bun run typecheck:all`
  - core、shared、server-core、server、session-tools-core、pi-agent-server、electron、ui 全部通过。
- Electron production build：
  - `bun run electron:build`
  - main、preload、renderer、resources 和 assets 构建与校验通过；仅有既有 Vite outDir 和大 chunk warning。
- Electron ESLint：
  - `cd apps/electron && bun run lint`
  - 0 error；111 个仓库既有 warning。
- i18n：
  - `bun run lint:i18n:sorted`
  - `bun run lint:i18n:parity`
  - `bun run lint:i18n:coverage`
  - 全部通过；6 个非英语 locale 各 1725 keys。
- 补充静态检查：
  - `git diff --check`
  - 通过。

## 遗留问题

- Reviewer Round 4 列出的 5 个问题均已修复，无已知任务范围内遗留。
- Electron production build 仍有仓库既有的 Vite outDir 和大 chunk warning；Electron ESLint 仍有 111 个既有 warning，本轮未新增 error。
