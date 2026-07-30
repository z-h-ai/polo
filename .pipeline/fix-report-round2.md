# POO-21 Review Round 2 修复报告

## 逐项处理结果

### 1. 全量测试中的 session watcher 不稳定

已修复。

- watcher 测试改用每个用例独立的 client ID，避免与并行测试共享
  `client-a/client-b` 而互相清理 watcher。
- `afterEach` 无条件清理本用例创建的两个 watcher，再移除临时目录。
- 正向事件断言改为有上限的条件轮询，保留负向断言的观察窗口。
- 全量测试另外暴露出依赖安装进程树测试的 2 秒启动等待在高负载下偶发超时，
  将该测试的有界等待扩为 5 秒；定向与最终全量均通过。

### 2. 首个 journal 前退出遗留无 journal operation 目录

已修复。

- operation 目录原子保留后立即耐久写入 `preparing` journal，再创建 stage、
  下载、解压和校验。
- `preparing` 恢复只清理尚未进入目录交换的 operation 私有内容，不接触正式
  Skill 目录或 Ledger。
- 为旧实现留下的无 journal operation 增加保守恢复：仅允许清理顶层
  `stage/`、普通 `archive.zip` 和 journal 临时文件；出现 backup 或未知内容时
  拒绝恢复，避免误删恢复材料。
- recovery Promise 失败后不再永久缓存，安全修复现场后可重新恢复。
- 新增下载中、解压中、校验中退出的启动恢复覆盖。

### 3. operationId 重放、跨 slug 碰撞和取消串扰

已修复。

- `.creator-skill-ops/<operationId>` 使用非递归原子 `mkdir` 独占保留；已存在
  UUID 返回 `creator_skill_operation_id_conflict`，不再递归删除旧目录。
- operationId 在 workspace 范围内唯一，两个不同 slug 使用相同 UUID 时只有
  首个操作持有目录，后续操作被拒绝。
- 取消控制器 key 改为 canonical workspace + RPC client + operationId，其他
  client 无法取消该操作。
- 新增 UUID 重放保留遗留 backup、不同 slug 碰撞和跨 client 取消测试。

### 4. INSTALL 未绑定当前 RPC client/window 的 active session

已修复。

- server-core 新增 client 到 `workspaceId + activeSessionId` 的权威映射。
- 映射只在经过 server-core 校验的 `setActiveViewing` session RPC 中更新；
  client 断开时清理。
- INSTALL RPC schema 移除 renderer 提交的 `sessionId`，server-core 只从当前
  client 的 active session 派生项目目录，并再次校验 session/workspace 归属。
- renderer 即使额外提交同 workspace 的其他 sessionId，也会被 strict schema
  拒绝，不能绕过当前项目级同名 Skill 检查。
- 新增同 workspace 两个 session 的边界测试：当前 session 有项目级冲突时阻止
  安装；伪造无冲突 session 被拒；通过正常 active-session 切换后才按新 session
  重新判定。

### 5. Ledger 缺少 fsync 耐久协议

已修复。

- Ledger 改为独占创建临时文件、写入、临时文件 fsync、关闭、rename、父目录
  fsync 的协议。
- 文件或目录耐久确认失败会抛错，安装事务不会继续推进 journal。
- 新增临时文件 fsync、rename 后 checkpoint、父目录 fsync 故障注入，并验证
  安装目录和旧 Ledger 回滚。

### 6. 普通 workspace Skill 被 Creator slug 规则误伤

已修复。

- 普通 Skill 删除 RPC 与 storage 只要求安全 basename，并继续执行路径边界、
  symlink 和目录类型校验。
- Creator Artifact、Creator 安装/更新/卸载 RPC 仍使用严格 kebab-case slug。
- 新增 `foo--bar` 普通 Skill 的加载和删除兼容测试。

### 7. Safety Status 并发乱序可将 revoked 回退为 active

已修复。

- 详情页与 AppShell monitor 统一调用按
  `workspace + artifactId + version + archiveChecksum` 建 key 的共享刷新服务。
- 相同精确版本的并发请求共享 single-flight；代次变化后旧响应不再写 Ledger。
- server-core Ledger 更新增加第二道终态保护：同一精确版本已为 `revoked` 时，
  延迟到达的 `active/archived` 只可刷新检查时间，不能回退安全状态。
- 新增旧 active 响应晚于新 revoked 响应，以及共享单飞的确定性测试。

### 8. 版本默认选择使用字符串排序

已修复。

- `CreatorArtifactsPanel` 改用现有稳定 SemVer 数值比较函数。
- 覆盖 `10.0.0 > 2.0.0`、`2.0.12 > 2.0.9`，并验证缺少
  `latestPublishedVersion` 时默认选择 `10.0.0`。

### 9. 通用 @ 候选的 revoked 标记不是红色

已修复。

- revoked 候选改用 `bg-destructive/10 text-destructive`，其他类型徽标保持原样。
- 新增服务端渲染断言，验证撤销文案和 destructive 语义 class。

## 关键文件

- `packages/shared/src/creator-skills/installer.ts`
- `packages/shared/src/creator-skills/ledger.ts`
- `packages/shared/src/creator-skills/schemas.ts`
- `packages/shared/src/skills/storage.ts`
- `packages/shared/src/creator-skills/__tests__/installer.test.ts`
- `packages/shared/src/creator-skills/__tests__/ledger.test.ts`
- `packages/server-core/src/handlers/rpc/client-active-session.ts`
- `packages/server-core/src/handlers/rpc/sessions.ts`
- `packages/server-core/src/handlers/rpc/skills.ts`
- `packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`
- `apps/electron/src/main/handlers/__tests__/session-watcher.test.ts`
- `apps/electron/src/renderer/lib/creator-skill-safety-refresh.ts`
- `apps/electron/src/renderer/hooks/useCreatorSkillSafetyMonitor.ts`
- `apps/electron/src/renderer/pages/SkillInfoPage.tsx`
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/renderer/components/ui/mention-menu.tsx`

## 实际运行的测试与结果

- `bun run test`
  - exit 0；根测试 4850 pass、19 skip、0 fail，随后仓库全部
    `*.isolated.ts` 均通过。
- `bun run typecheck:all`
  - exit 0；全部 package TypeScript 检查通过。
- Creator Skill installer、Ledger、普通 Skill storage 定向测试
  - 77 pass、0 fail。
- `bun test packages/shared/src/creator-skills/__tests__/schemas.test.ts apps/electron/src/main/local-app-runtime/__tests__/manager.test.ts`
  - 35 pass、0 fail、200 assertions。
- `bun test packages/server-core/src/handlers/rpc/skills.creator-boundary.isolated.ts`
  - 9 pass、0 fail、54 assertions。
- Safety single-flight、SemVer、mention menu、session watcher 定向测试
  - 28 pass、0 fail。
- `CreatorArtifactsPanel.interaction.isolated.ts`
  - 14 pass、0 fail、62 assertions。
- `SkillInfoPage.creator-skill.interaction.isolated.ts`
  - 3 pass、0 fail、13 assertions。
- `bun run lint:electron`
  - 0 error；存在仓库既有 111 warnings。
- shared 本次变更文件的定向 ESLint
  - 0 error、0 warning。
- `git diff --check`
  - 通过。

## 遗留问题

- Review Round 2 的 9 项 issue 均已处理，无已知功能遗留。
- 仓库级 `bun run lint:shared` 仍会命中 5 个与本任务无关的既有
  `craft-shared/no-inline-source-auth-check` 错误，位于 resource/source token
  refresh 代码与测试；本任务未修改这些文件。所有本次 shared 变更文件已通过
  定向 ESLint。
