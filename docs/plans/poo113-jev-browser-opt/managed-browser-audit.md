# POO-113 托管浏览器复核（2026-10-23）

## 结论与权威范围

推荐暂缓 P2 auto-accept，保留 P1 只读建议。客户端修复和两份服务端候选均未提交、未合入；仅部署到用户授权的隔离预发。真实模型多步 gate 未通过；真实扣账已验证，迟到结算存在既有金融契约边界，不能宣布全链路验收通过。

- 客户端 Before：`253781a3d2712f2a17f47bf91c1ac2fb73f2a71c`。当前未提交树与逐文件 SHA-256 清单见报告。
- Admin 候选基线：部署中的 `3888339e7b815a7e4ae3059a65b39d666d430127`；独立 worktree `polo-admin-dir/fix/poo113-provider-credential-fingerprint`。
- NewAPI 候选基线：部署分支 `685f111c711bfaa99ebd7bb4ebf431ae42cbfdca`；独立 worktree `/Users/wow/project/new-api-dir/fix/poo113-token-fingerprint`。不是上游 main 的旧副本。
- 共享网关是 `https://newapi.z-h-ai.com/v1`；隔离验证网关为 `https://poo113-stage-gateway.z-h-ai.com/v1`，Admin 为 `https://poo113-stage-admin.z-h-ai.com`。两路均由该 Admin 当前空间下发，A=`deepseek-flash`，B=`glm-5.3-flash`。
- ZCode 只读参考 HEAD：`0a1fc56d279fd1001f78387bd81aec1c26767411`；仅用于比较动作工具、设备权限和测试 Skill，不能替代 Polo 产品规则。
- 长期报告：`/Users/wow/reports/2026-10-23-poo113-managed-browser/index.html`，含真实前后截图、逐文件红绿 diff、三仓库基线、日志、账单与恢复 journal；私密凭据不入库、不进入报告。

## 当前是否需要确认、P2 是否必要

Polo `mode-manager.ts` 将 `browser_tool` 列入 ALWAYS_ALLOWED_TOOLS；safe、ask、allow-all 三种模式实测均放行 `click @e1`，不会读取该 ref 对应的“Delete account”语义。`suggest` 的 dangerous 字段只是提示，P1 自身不执行动作。

ZCode 的 browser interaction handlers 直接执行动作；embedded browser permission policy 主要处理相机、剪贴板等网页权限。其 web-gui-tester Skill 要求真实下单、支付、删除前询问，但不构成每个动作统一的运行时黑名单确认。

建议保持“主模型规划 → suggest → 主模型验证 → 单步执行 → 再观察”。本次真实轨迹成功率不足以支持 P2。若后续实现，确认必须绑定实际页面、目标、参数与提交动作，例如 `key Enter` 也能提交付款，单靠 click 目标文字黑名单会漏判。后台可配危险类目和强制执行授权本次未实现。

## 已修复的行为

1. 原工厂默认 paths 为空，或依赖用户本地独立连接。现在从当前会话 Admin 托管连接解析两路固定模型，复用主 Pi 的 invocation credential proxy、AssistantBillingCoordinator、当前产品空间与原始请求因果关联；每次 HTTP 尝试独立准入/收据。旧 paths 不再控制模型或密钥；拒绝、撤销和缺失托管权限均不发供应商请求。已验证的桌面 CLI 代理自行拥有计费，避免重复准入。
2. 两路 `scroll up/down`、`key Enter/Escape`、大小写不同填充值不再仅按动词视为一致。两条合法命令分歧时返回无建议；只有另一条确实无效或失败时，保留单路只读建议。
3. 用户停止、轮次切换会取消辅助请求和重试；总建议时限覆盖连接解析、准入和等待结果。超时及时返回无建议，原始账单清理仍由 factory 和 SessionManager 持有，后台刷新、会话删除与应用/Server 退出均正确等待原清理，不能丢弃恢复记录。
4. 原生下拉框优先精确 value，其次唯一可见名称。例如传“第二类”、实际 value=`two`，旧实现清空选项后报错；现在正确选中。未知、禁用、歧义选项写入前拒绝，保持原值。
5. Admin 每次准入不再调用敏感 `POST /api/token/:id/key`，避免先触发密钥揭示限流。NewAPI 既有 owner-authorized token detail 返回完整原始 key 字节的 SHA-256，响应 no-store；列表/搜索仍脱敏。Admin 每次新鲜读取并核对指纹、令牌名、所有者、状态、有效期与模型范围；不缓存授权、不回退读取明文、不更改共享限流或账单因果验证。

指纹是原始 GetTokenKey/GetFullKey 返回字节的 SHA-256，不擅自加 `sk-` 前缀。两仓库共享 48 字符 fixture 与固定期望 digest。部署必须先 NewAPI、后 Admin；回滚先 Admin。旧网关不提供指纹时 Admin 候选会拒绝准入，不能单独上线后台。

## 验证结果

- 客户端：`bun test apps/electron/src/main/__tests__/browser-cdp.test.ts packages/shared/src/agent/__tests__/browser-fast-decider.test.ts packages/shared/src/agent/__tests__/browser-fast-decider-managed.test.ts packages/shared/src/agent/__tests__/browser-tools.test.ts packages/server-core/src/runtime/__tests__/assistant-billing.test.ts packages/shared/src/credentials/__tests__/desktop-managed-proxy.test.ts packages/server-core/src/sessions/__tests__/browser-fast-turn-lifetime.test.ts packages/server-core/src/sessions/import-reservation.test.ts`：156 pass / 0 fail，506 assertions。
- `bun run typecheck:all` 最终源码检查通过（终态 exit 0，见 typecheck-final-receipt.json；原共享日志夹有已停止旧轮次的 SIGTERM 片段，旧轮次不计通过）；`git diff --check` 通过。`bun run lint` 既有入口缺少 `scripts/check-raw-sends.sh`；按改动范围另跑 ESLint，忽略目录不冒充通过。
- Admin：通过固定 TRL 1.0.5 运行 `XDG_STATE_HOME=/tmp/poo113-trl-state npm test -- tests/provider-credential-fingerprint.test.ts tests/canonical-app-billing.provider-evidence.test.ts tests/assistant-admission-retry.test.ts`：31 pass / 0 fail，独立测试数据库正常创建/清理。初次默认 TRL 历史回收阶段未启动测试，停止的是本任务无资源 launcher；不计通过。类型检查和 `npm run policy:check -- --committed` 通过。
- NewAPI：`GOTOOLCHAIN=local /tmp/poo113-toolchain/go/bin/go test ./controller -run 'Test(GetToken|GetAllTokensMasks|SearchTokensMasks|UpdateTokenMasks)' -count=1 -json`：12 个测试/子测试通过，0 fail；候选 Linux 二进制 SHA-256 见预发清单。
- 独立 Standards / Spec 复核已修复所有列出的代码问题，当前各 0 未解决发现。复核、测试、运行和产品 Acceptance 分开；没有正式 Acceptance。
- 受控模式最终实跑：真实 Electron BrowserPaneManager/CDP，12 条 × 5 步，60 次建议、120 次准入/收据、0 failure；前后同视口/同状态/同数据截图含真实工具输出。模型和账单响应受控。
- 最后一次真实模式：`POO113_MANAGED_INPUT=<600权限文件> POO113_EVIDENCE_DIR=<证据目录> bun scripts/electron-browser-managed-e2e.ts`，默认总时限 3000ms，12 条尝试中 6 条完整完成；40 次建议，33 次双路一致、1 次单路、6 次无建议。80 次准入尝试，73 通过、7 被拒；73 份收据。建议最长 3015ms。此前同样 12 条仅 5 条完整，旧工厂等待账单可达约 7.5 秒；最终总时限修复有效。

轨迹是同构本地表单 fixture，使用真实 Polo BrowserPaneManager/CDP、正式 decider/proxy/账单代码及真实供应商模型；保存动作只验证危险提示，不执行。它不是 12 类开放网站任务，也不是完整聊天主模型规划/SessionManager UI E2E。SessionManager 生命周期另由实际方法回归覆盖；源码摘要不替代执行覆盖。

## 真实账单与未决边界

隔离预发累计确认 134 笔：DeepSeek 67 笔 / 24,380 微积分，GLM 67 笔 / 22,098 微积分，总计 46,478 微积分 = 4.6478 Polo 积分。每笔保留原始 NewAPI 请求、服务端 nonce、实际模型与账本关联。

隔离预发仍有 13 笔 pending、合计 832 微积分占用：7 笔可用输出，6 笔输出未知。可用输出的原始供应商日志、token/owner/nonce、输入输出数量均匹配；现有客户端在初次 pending 后通知执行结束，数据库随后禁止扩张已冻结的 64 微积分初始容量，而实际费用超过预留。该结论来自原始记录和 `pol21_ensure_billing_run_capacity` 规则；未通过改库、伪造收据或放宽金融规则强制结算。

建议将迟到结算的预留容量/执行结束语义单列金融契约任务，本次保留原账与恢复 journal。是否纳入当前范围已询问用户，尚未裁决。未知输出也不擅自改成可用、免单或扣款。

原共享预发另确认 18 笔 / 6,332 微积分 = 0.6332 积分，留 1 笔未知输出、64 微积分占用；不与隔离预发混为同一次账本。17 个隔离预发失败准入 run 已通过正常接口结束，不重放 AI 请求。

## 预发与清理

coolify-main 上新增 `poo113-stage-admin`、`poo113-stage-gateway`、`poo113-stage-redis`，使用独立 `poo113_admin_preview` / `poo113_newapi_preview` 数据库和域名。Admin 是原预发快照，网关只复制必要配置/渠道/root 管理身份并更换独立管理凭据；测试账号通过正常 API 创建与供应下发。Admin 以基线镜像挂载两份候选源码运行 Next dev webpack，不能当作生产构建验收。

原共享预发和生产容器未替换，生产配置未更改。仅早期修复原预发应用角色对 quota_periods 缺少的 INSERT/UPDATE 权限。共享网关和新预发网关限流均未放宽；新预发高速调用仍触发普通管理 API 默认 360 次/180 秒，后段准入拒绝是容量边界，不能宣布生产并发可用。

1 Polo 积分 = 10,000 微积分。原测试误发 10,000,000 微积分（1,000 积分，早期文字误写 10），已通过运营 revoke API 回收未消费、未占用的 9,993,604 微积分；保留消费 6,332 和占用 64。新隔离测试准确发放 100,000 微积分（10 积分），已回收未用 52,690；保留消费 46,478 和占用 832，两次守恒均成立。

回收 receipt 的 provider sync 为 queued；存在原待结算消费时不能声称供应商余额同步完成。预发容器/数据库和审计账本暂留复核，复测前需重新补充测试预算；凭据留私密文件，不公开到报告。未 merge、push、部署客户端或修改 Notma Done；合入由用户决定。推荐暂不合入 P2；金融边界和管理 API 容量尚未闭环。
