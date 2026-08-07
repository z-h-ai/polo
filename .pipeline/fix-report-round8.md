# POO-29 第 8 轮修复报告

## 处理结果

1. AdminClient publication orchestration 调整为 `/api/admin/organizations/:organizationId/apps` 严格管理路径；website body 使用 `visibilityPolicy`/`status`，Release create 提交 draft metadata，signed PUT 添加 `Content-Type: application/zip`，upload-complete 不再发送 body。
2. upload 路径使用平台 appId（若提供）和远端 Release list 计算版本后创建 Release、上传、complete、publish。
3. legacy Bundle 仅接受省略 permissions 或 `permissions: []`；对象和非空数组返回稳定 `invalid_legacy_permissions`。

## 测试

- `bun test packages/shared/src/admin/__tests__/creator-app-publishing.test.ts`：11 pass。
- `bun run typecheck:all`：通过。

## 剩余风险

- Admin API 的最终 metadata 字段与 409 retry 需要与外部 Admin 部署契约再做 HTTP 集成验证。
- shared validator 抽取和 Static/Python/JS 真实 LocalAppRuntimeManager.install 闭环尚未完成。
