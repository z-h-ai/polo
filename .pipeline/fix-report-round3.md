# POO-29 第 3 轮修复报告

## 处理结果

1. 移除了不存在的 Admin HTTP publication URL。嵌入式 server-core 现在提供持久化的 `CreatorAppPublicationService`：最终 Bundle 以一次性原子写入保存，index 与 audit JSONL 持久化，原始上传只在内存中分析后丢弃。服务集成测试覆盖实际 ZIP 文件、审计与多入口选择。
2. `admin:publishCreatorApp` 已加入 `LOCAL_ONLY_CHANNELS`；增加显式分类快照和远程 workspace 下本地 client 路由测试。
3. ZIP 与目录现在为独立 file inputs；目录输入启用 `webkitdirectory`，服务端会安全剥离唯一共同外层根并拒绝冲突路径。
4. 多入口返回结构化 `needs_entry_selection/candidates`，前端显示唯一的启动文件选择并回传 `selectedEntry`；服务端只接受分析候选。
5. 最终 Bundle 校验补充非空 appId、版本格式、entry、权限、healthcheck 与 webPath 校验。
6. ZIP central directory 在解压前限制条目数、单项/总未压缩尺寸和压缩比；覆盖 traversal、symlink、伪锁、无健康端点与高压缩比归档。
7. 授权解析只接受 active organization + active membership；无权限、删除或空来源不会进入发布。
8. website 改为直接单次持久化发布，不再创建 draft/release 或 Bundle。

## 关键文件

- `packages/server-core/src/services/creator-app-publications.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/shared/src/admin/creator-app-publishing.ts`
- `packages/shared/src/protocol/routing.ts`
- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`

## 自测

- `bun test packages/shared/src/admin/__tests__/creator-app-publishing.test.ts`：9 pass。
- `bun test packages/server-core/src/handlers/rpc/admin.test.ts packages/server-core/src/services/creator-app-publications.test.ts`：29 pass。
- `bun test packages/shared/src/protocol/__tests__/routing.test.ts apps/electron/src/transport/__tests__/routed-client.test.ts`：通过。
- `bun test --isolate ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`：17 pass。
- `bun run typecheck:all`：通过。
- `NO_COLOR=1 bun run test`：通过；`scripts/build-cli-artifacts.test.ts` 的 production build 重定向回归也通过。

## 遗留问题

远端 Polo Admin 服务不在本 worktree。本轮不再调用未部署的 HTTP URL；发布由本机受认证 server-core 边界完成并持久化最终 Bundle。若未来需要跨设备组织共享，应由 Admin 服务接收该最终 Bundle/audit 契约，而不是客户端上传原始 payload。
