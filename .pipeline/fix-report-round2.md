# POO-29 第 2 轮修复报告

## 逐条处理结果

1. 发布入口不再以 URL 交接。`CreatorArtifactsPanel` 通过认证的本地 RPC 提交网站名称、HTTPS URL 和 `all_members` 可见范围；上传 ZIP 的原始字节会 base64 传输，选择文件夹时客户端先保留相对路径重建 ZIP 后再传输。交互测试断言两条路径的实际 RPC 输入及上传内容，不再断言 `openUrl`。
2. 新增 `admin:publishCreatorApp` 认证 RPC 和 Admin Client 发布契约。RPC 先用已登录会话获取可访问组织、由 Admin 创建草稿取得服务端 App/Release/版本，再对真实 ZIP 解包、分析、生成并验证最终 Bundle，最后将不可变最终 ZIP、checksum、size 提交给 Admin 发布端点。网站路径同样创建草稿并发布，返回实际 publication 结果。
3. Bundle 链路改为真实 ZIP 字节，不再使用 NUL 分隔字符串。入口必须来自分析候选集；ZIP central-directory 会拒绝 traversal、重复路径和 Unix symlink；依赖锁需要符合最低锁文件结构，Python/JS 入口必须具备 `/health`。最终 Bundle 再以安装器所需 Manifest 契约校验 `appId`、版本、runtime、存在的 entry 和 `permissions: []`。测试覆盖二进制保真、旧 Manifest 身份重写、恶意 traversal、伪锁文件、无健康端点、缺失/越界/runtime 不匹配入口。
4. 来源组织 resolver 已接入生产 RPC 接收端。该端从认证的 `listOrganizations` 结果解析请求组织，不提供未授权或已删除组织的 fallback。服务端 RPC 测试验证有效组织发布、无权限/已删除/空来源被拒绝且不会创建草稿。

## 关键文件

- `apps/electron/src/renderer/components/organization/CreatorArtifactsPanel.tsx`
- `apps/electron/src/preload/admin-api.ts`
- `apps/electron/src/transport/channel-map.ts`
- `packages/server-core/src/handlers/rpc/admin.ts`
- `packages/shared/src/admin/creator-app-publishing.ts`
- `packages/shared/src/admin/client.ts`
- `packages/shared/src/admin/types.ts`
- `packages/shared/src/protocol/channels.ts`

## 自测结果

- `bun test packages/shared/src/admin/__tests__/creator-app-publishing.test.ts`：9 pass。
- `bun test packages/server-core/src/handlers/rpc/admin.test.ts`：27 pass。
- `bun test --isolate ./apps/electron/src/renderer/components/organization/__tests__/CreatorArtifactsPanel.interaction.isolated.ts`：17 pass。
- `bun test --isolate ./apps/electron/src/main/handlers/__tests__/admin-local-app-session-ending.isolated.ts`：23 pass。
- `bun run typecheck:all`：通过。
- `NO_COLOR=1 bun run test`：通过；其中 `scripts/build-cli-artifacts.test.ts` 的 redirected production build 回归测试本轮稳定通过。

## 遗留问题

Polo Admin 服务本体不在本 worktree；本仓库已提供并实测认证客户端契约：`POST /api/organizations/:organizationId/creator-app-publications` 创建 draft，`POST /api/organizations/:organizationId/creator-app-publications/:appId` 接收最终平台 Bundle 并发布。部署时 Admin 需按该契约持久化最终 Bundle、清理临时原始上传并保留审计记录。
