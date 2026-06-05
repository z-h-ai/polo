# Technical Decisions

## Architecture
- Admin 是独立仓库（不在 monorepo 内），Polo AI 通过 REST API 调用
- 接口契约见 .task/shared-contract.md

## Testing & CI Decisions (User Confirmed 2026-06-05)

### Test Strategy
- **Approach**: Mixed — unit tests mock Admin API (fetch); integration tests use real endpoints where possible; LLM calls always mocked
- **Admin API mocking**: Mock fetch responses for Admin API calls in unit tests

### Test DB Isolation
- N/A（Polo AI 不直连 PostgreSQL，Admin API 是外部服务）

### Visual Testing
- **Tool**: Playwright screenshots for WebUI login page and quota display

### CI/CD Constraints
- **Environment**: CI can run Docker; no external API calls in tests
- **Admin API**: Mocked in all test environments
