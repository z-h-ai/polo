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

---

# POO-36 Review Round 2 修复报告

## 处理结果

1. Caddy 内部发布状态隔离
   - Caddy 使用有序 `route`，先拒绝 `.incoming`、隐藏 release staging 目录、publisher lock、rollback/confirmed marker 与 latest 下隐藏路径；避免后续 immutable wildcard 覆盖 deny 规则。
   - 真实 Caddy 容器测试覆盖这些路径的 GET/HEAD 均非成功，同时保留 POST 405、manifest/contract/installer `no-cache` 和二进制 immutable。

2. 回滚目标保留到确认后
   - `publish` 不再做 retention 清理。`confirm` 将 rollback marker 原子转为 durable confirmed marker 后才清理，并保护 current latest、前三个版本和所有未完成/已确认 marker 指向的回滚目标。
   - 新增回归：latest 手动回到最旧保留版本后，下一版本未确认发布失败仍精确回滚；confirmed 状态支持幂等确认和补偿回滚。

3. 工作流最终化 fail closed
   - public verify 失败、confirm Service Exec 失败或 confirmed pointer 校验失败都会三次重试 Service Exec `rollback-failed`，并调用 `assert-not-latest` 确认 failed version 已不再是 latest。
   - confirm 成功后必须 `assert-confirmed`；任一最终化失败都使 production job 失败，因此 Draft Release 保持 draft。

4. post-publish incoming 清理
   - 当前调用创建的 incoming 在发布成功后改为 best-effort 清理；清理异常只给出稳定诊断，不会把已原子切换的 latest 伪装为失败或跳过后续回滚链路。
   - 测试注入 cleanup failure，验证 pull 仍成功且 latest 保持新版本。

5. existing incoming 逐字节匹配
   - Draft Release 提供可信 `sha256:` digest 时，existing incoming 必须逐文件匹配；没有 digest 时先下载全部白名单资产到临时目录，再逐字节比较，拒绝同尺寸但 contract、manifest 或二进制内容不同的目录。
   - existing incoming 的比较过程和发布前都执行容量预检；不匹配的既有目录不会被当前调用删除。

6. 全量门禁稳定性
   - Caddy 真实容器测试超时上限提升到 60 秒，覆盖冷镜像/冷启动情形；本地单独与完整门禁均已重跑。

## 关键文件

- `infra/updates-static/PoloCaddyfile`
- `infra/updates-static/PoloCaddyfile.test.ts`
- `scripts/publish-electron-release.ts`
- `scripts/publish-electron-release.test.ts`
- `scripts/polo-release-pull.ts`
- `scripts/polo-release-pull.test.ts`
- `.github/workflows/electron-release.yml`
- `scripts/electron-release-workflow.test.ts`

## 实际测试

- `NO_COLOR=1 bun test scripts/electron-release-contract.test.ts scripts/electron-release-bundle.test.ts scripts/publish-electron-release.test.ts scripts/polo-release-pull.test.ts scripts/electron-release-workflow.test.ts scripts/__tests__/electron-artifact-pipeline.test.ts infra/updates-static/PoloCaddyfile.test.ts`
  - 通过：49 pass、443 expects、0 fail。
- `docker run --rm ... caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
  - 通过：Caddyfile 配置有效。
- `NO_COLOR=1 bun run test`
  - 已重新执行并通过仓库标准完整门禁；Caddy 容器测试使用 60 秒冷启动预算，不再使用此前的 5 秒默认上限。
- `git diff --check`
  - 通过。

## 遗留项

- Service Exec 或 Zeabur 平台完全不可达时，工作流只能 fail closed 并保留 Draft；本轮已对可达服务的 rollback/指针确认加三次补偿重试，未绕过任何生产权限或使用真实 token/PVC。
