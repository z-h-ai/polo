# User Intent Record

## Source
- Extracted from: spec file `docs/prd-and-spec/docs/spec-user-auth-and-admin-llm-config.md`
- Timestamp: 2026-06-06

## Original Request
> 基于 spec-user-auth-and-admin-llm-config.md 实现用户账号登录 + Admin 下发 LLM 配置功能

## Scope
> - Polo AI 客户端（Electron + Web UI）改造
> - Admin API 是独立项目（Polo Admin / Academy），本次只做客户端侧实现
> - Admin API 契约在 spec 中定义，双方按此实现

## Key Goals (from spec §1)
1. **引入用户账号体系**：Web UI 和 Electron 都使用「用户名 + 密码」登录，账号由 Polo Admin 后端统一管理
2. **Admin 集中管理 LLM 配置**：管理员在 Polo Admin 后台为用户/用户组配置 LLM 供应商、API Key 和可用模型列表，用户无需手动配置
3. **移除用户自助配置能力**：移除 Onboarding 向导、AI Settings 页面、客户端 OAuth 流程、本地模型支持

## Key Constraints
> - 必须在线：应用启动时必须连接 Admin API 完成认证和配置拉取
> - JWT 无过期时间（产品决策），使用 jti 撤销机制补偿
> - API Key 从 Admin 加密传输（AES-256-GCM，HKDF 从 JWT 派生密钥）
> - Electron 使用 safeStorage，Web 使用 HttpOnly Cookie
> - 实现分 4 个 Phase：基础认证 → LLM 配置对接 → 清理旧代码 → Electron 适配

## Relationship to Previous Session
> 前一个 hermes-coding session（MVP-1）实现了 platform mode 下的配额检查和使用报告
> 本次 spec 覆盖更广：完整的用户认证、Admin 下发 LLM 配置、加密传输、旧代码清理、Electron 适配
> 本次实现可复用前一个 session 已建立的 AdminApiClient 和 PendingUsageStore 基础
