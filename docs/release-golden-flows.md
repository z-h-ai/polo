# 发布黄金流与发布后探针(Release Golden Flows & Post-Release Probes)

背景:2026-10-26 计费准入事故(v1.5.0 admin 准入 SQL 要求网关 `reserve_quote` 端点,生产网关镜像过旧 404 → 全量 AI 请求 502)暴露的覆盖空白:单元/集成测试把跨服务缝 mock 掉,发布验收只做了「版本指针 + 路由活性」,没有跑过一条真实业务流。本文件定义每次发布后的强制探针,按序执行,全绿才算发布完成。

## 三方版本核对(发布前)
契约变更涉及以下任一方时,三方必须在同一发布批次内就位,缺一即暂停发布:
- polo 客户端(请求形状,如 `requestBounds`)
- polo-admin(准入/计费 SQL 与 API)
- 网关 new-api 镜像(自定义端点,如 `reserve_quote`)

网关镜像现在是一等发布组件:一律走 fork 分支合并 → 正式镜像 → Coolify 定义同步,**禁止手工 swap compose 镜像行**(会被下次重部署静默回退)。

## 发布后探针(按序,全部通过才算 done)

### P0 · 版本指针(1 分钟)
```bash
curl -s --resolve updates.polo.z-h-ai.com:443:111.230.240.195 \
  https://updates.polo.z-h-ai.com/electron/latest/latest-mac.yml | head -1   # 期望新版本号
curl -s -o /dev/null -w '%{http_code}\n' https://polo-admin.z-h-ai.com/      # 期望 200
```

### P1 · 产物完整性(约 5 分钟,~1.4GB 下载)
```bash
bun scripts/verify-updates-feed.ts --version <X.Y.Z> \
  --resolve updates.polo.z-h-ai.com:443:111.230.240.195
```
逐产物核对 size+sha512 与 manifest 一致,拦截「同 tag 重复构建哈希漂移」。任何 MISMATCH 即发布失败,禁止手动改服务器文件(应定位构建/发布管线后重发)。

### P2 · SIM-E2E:一条真实计费 AI 请求(约 2 分钟)⭐ 核心探针
```bash
PHONE_HMAC_SECRET=<…> SIM_SPACE_ID=<uuid> SIM_PHONE=+86<test-tenant> \
  bun scripts/release-sim-e2e.mjs
```
全链:种验证码登录 → `/api/llm-connections`(受管连接+密钥解密)→ `/api/billing/runs` + admit(准入 SQL/网关 reserve_quote 契约/`requestBounds` 校验全在此)→ **真实网关 chat 200** → usage 结算 confirmed → finish。任何一段失败即发布失败。
涉及三方契约变更时,**staging 通过不算数**,必须对生产跑(SIM 走专用测试租户,消费几百 micros)。

### P3 · 生产路由探针(1 分钟)
```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://polo-admin.z-h-ai.com/api/browser-policy?productSpaceId=00000000-0000-0000-0000-000000000000"   # 401=在位
curl -s -o /dev/null -w '%{http_code}\n' https://polo-admin.z-h-ai.com/api/llm-connections                 # 401=在位
```
注意:Coolify 部署 job 结束 ≠ 容器已重建(异步,数分钟);探针 404 时先查容器时间戳再判定。

### P4 · 真实客户端黄金流(发布后 24h 内,人工或 tester)
1. 登录 → 切换企业空间 → 发送一条消息(AI 配置自动同步 + 计费正常,余额不足时横幅语义正确)。
2. 知识库:创建集合 → 上传 .md → 提审,全程行级即时反馈。
3. 右栏:画布+浏览器共栏 → 弹出/收回 → 网页元素加入聊天并发送。
由 tester 用真实账号执行并回帖 notma;P0-P3 全绿但 P4 发现问题时,按事故流程回滚/热修,不阻塞 P0-P3 的发布完成判定。

## 2026-10-26 事故对照(为什么有本文件)
- 事故:`pol21_admit_request` 调网关 `reserve_quote`(polo fork 自定义端点),生产网关旧镜像 404 → AI 请求 502;UAT 客户端 v0.20.0 缺 `requestBounds` 加重。
- 本文件针对性堵截:P2 直击该缝;P1 拦截同 tag 重复构建的 dmg 哈希漂移;错误码映射(`quota_exhausted`/`budget_exhausted` → `POLO_INSUFFICIENT_CREDIT`/chat quota 横幅)已随 v0.21.2 补齐并有单测。
- 排查备忘:`credit_batch_holds/consumptions.runId` 是内部 id,查账先 join `billing_runs`;`tokens.key_fingerprint_sha256` 是 GetToken 实时 SHA256 非表列。
