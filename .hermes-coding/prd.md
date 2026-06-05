# PRD: Polo AI 多用户改造 (MVP-1)

> **Version**: 1.0 | **Date**: 2026-06-05
> **Spec**: `.task/spec-polo-ai.md` | **Contract**: `.task/shared-contract.md`
> **Scope**: 仅 Polo AI 仓库改动，Admin 是独立仓库

---

## Context Index

| File | Contains |
|------|----------|
| `context/user-intent.md` | Scope and constraints |
| `context/decisions.md` | Testing and architecture decisions |
| `context/files-referenced.md` | All file paths |
| `.task/spec-polo-ai.md` | Full technical spec |
| `.task/shared-contract.md` | JWT + API contract with Admin |

---

## 1. Problem
Polo AI 当前是单用户模式，需要改造为多用户，配合独立部署的 Admin 管理后台。

## 2. Scope (16 tasks from spec-polo-ai.md §11)

1. GET /api/config 端点
2. POST /auth/session 端点
3. WebSocket upgrade 认证改造
4. 扩展 RequestContext
5. 文件存储路径隔离
6. Workspace 归属校验+自动创建
7. WebUI 登录页
8. resolveAuthEnvVars 平台 Key
9. Onboarding 跳过 API Key
10. Admin API Client
11. pending_usage store
12. sendMessage 配额检查+归属校验
13. Agent turn 回调捕获 usage
14. 异步用量上报+pending 重试
15. 隐藏 LLM 连接配置 UI
16. WebUI 配额显示组件

## 3. Technical Decisions
- Test strategy: Mixed (unit mock Admin API, LLM always mocked)
- Visual testing: Playwright screenshots for login page + quota display
- CI: Docker OK, no external API calls
- Admin API: external service, mocked in tests

## 4. Acceptance Criteria
```
用户在 WebUI 登录 → 发消息 → 配额检查 → Claude 回复 → 用量上报
配额不足 → 拒绝 → 友好提示
Admin API 不可用 → 拒绝发消息 → pending 保存用量
```
