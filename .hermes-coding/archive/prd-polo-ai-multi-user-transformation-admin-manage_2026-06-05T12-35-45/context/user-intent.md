# User Intent

## Core Requirement
"用户不需要懂 API Key，注册登录就能用"
(Users should not need to understand API Keys -- they register, log in, and use the platform.)

## MVP-1 Acceptance Criteria (End-to-End Flow)

```
Admin creates account (username + password + monthly quota)
    -> User logs in on Polo AI WebUI (username + password)
    -> User sends message
    -> System checks user quota (Polo AI Server calls Admin API, deducts local pending)
    -> Quota sufficient -> Use platform Key to call Claude -> Stream response
    -> Agent turn completes -> Capture usage from callback -> Report usage to Admin
    -> Report fails -> Write to local pending, background retry, pending participates in subsequent quota checks
    -> Quota insufficient -> Reject with user-friendly message
    -> Admin console can view per-user usage
```

## MVP-1 Entry Scope
- **WebUI only** (CLI/Electron deferred to MVP-1.5)

## Key Deliverables
1. **User system**: Admin-created accounts with username/password login
2. **Admin management console**: Independent Next.js project for user management, quota management, usage viewing
3. **Platform-managed LLM calls**: Platform holds API Key, users are unaware
4. **User isolation**: Multi-user data strictly isolated by userId
5. **MVP priority**: Run through basic flow, no over-engineering
