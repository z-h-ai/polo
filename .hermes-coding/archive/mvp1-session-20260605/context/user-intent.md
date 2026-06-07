# User Intent Record

## Original Request
> 基于 spec-polo-ai.md 对 Polo AI 现有代码进行多用户改造

## Scope
> 仅 Polo AI 仓库的改动，Admin 管理后台是独立仓库，不在本次范围内。
> Admin API 视为外部服务，按 shared-contract.md 的契约调用。

## Key Constraints
> - MVP-1 入口范围：仅 WebUI（CLI/Electron 推到 MVP-1.5）
> - Admin 是独立仓库，本项目只做 client 端调用
> - 两个项目通过 shared-contract.md 对齐 JWT 格式和 API 契约
