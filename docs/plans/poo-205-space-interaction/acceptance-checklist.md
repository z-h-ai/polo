# POO-205 验收 Checklist（本地全栈环境）

环境基线：客户端 `POO-205/refactor/space-interaction@5fe0c4a3` · polo-admin `POO-205/integration@75014650` · 本地库 `polo_admin_poo205`（全量迁移含 POO-205 两条 + reauth 钥匙已播种）
测试账号：`13100000001`（验收负责人，组织 owner）/ `13100000002`（验收成员，组织 member），密码均为 `poo205-pass-2026`。
种子数据：组织「POO-205 验收组织」+ 项目「交付项目 A」「调研项目 B」。

## A. 已由自动化验证（CI 级证据，无需重测）

| # | 项 | 证据 |
|---|---|---|
| A1 | 全仓 typecheck:all 0 错误 | 收敛提交后复验 |
| A2 | 全量测试 8890 pass / 39 fail（38 唯一全部经基线 7b723fbc 逐名对照相同，零回归） | /tmp/poo205-fulltest.log |
| A3 | 定向套件：space 48 / projects+context 65 / tab 87 / sessions 62 / pm 43 / Catalog v2 62 / i18n parity 70 | 逐套件隔离运行 |
| A4 | polo-admin 两阶段：40+92+36+28+30 测试过、typecheck/policy 绿 | 8bd3bf32 / 75014650 |
| A5 | canvas 数据链路 4 件套 3 pass + 1 基线同 fail；poo161 e2e 基线同 fail（本机 webview 环境限制） | 基线 worktree 复跑对照 |

## B. 已由本轮真实应用 e2e 驱动验证（截图在 /tmp/poo205-e2e-evidence/）

| # | 场景 | 结果 | 截图 |
|---|---|---|---|
| B1 | 密码登录（本地 admin，种子账号） | 通过，token 入安全存储 | 04/11 |
| B2 | 多空间闸：个人+组织双列表、账号身份行 | 通过 | 21 |
| B3 | 进入组织（空间切换事务） | 通过 | 22 |
| B4 | 组织首页：项目区=真实 Project 列表（2 个种子项目，角色徽标/成员数/用途）；我的应用空态（新文案）；共享应用空态；**无内置助手卡/知识库卡** | 通过 | 30 |
| B5 | 创建项目：**无付款责任勾选**、秒级完成、自动轻量进入 | 通过 | 31/32 |
| B6 | 项目工作台：消息/文件/置顶三 Tab、项目头（成员 1/介绍）、输入区优雅降级（未配置 AI 服务提示） | 通过 | 32/40 |
| B7 | 项目设置：项目指令保存 → DB 持久化验证 | 通过 | 33/34 |
| B8 | 项目内新建会话 → **磁盘记录验证**：projectId/spaceId/accountId/projectContext 四项绑定 + 物理分存 `project-sessions/{projectId}/` | 通过（记录直读） | 40 |
| B9 | PC 文件区未开通时的设计内门控文案 | 通过 | 60 |
| B10 | **候选菜单位置（enhance-prompt 已知样例）**：composer 输入 `@` 触发候选菜单——常规位置锚定光标（菜单左缘=光标x-10，底缘在光标线上方 8px）；长文本把光标推到右端再触发，菜单被钳制在视口内（右缘=innerWidth-8，恰好贴边不溢出）。4 个光标锚定候选面（AssetMentionPopover/InlineMentionMenu/slash/label）全部 body-portal+视口钳制，历史「菜单钉在 panel 右缘」bug 类在当前构建不复现 | 通过（几何实测+截图 150/151） | 150/151 |

## C. e2e 发现并已修复（本轮闭环）

| # | 问题 | 修复 | 回归 |
|---|---|---|---|
| C1 | ProjectHomePanel 无限重渲染崩溃（useSyncExternalStore 快照每次新建对象），进组织即崩 | projects-bus 快照缓存（5fe0c4a3） | HomePage.projects 10/10 |

## D. 待用户手测（环境已保留；按序执行）

| # | 场景 | 步骤 | 预期 | 备注 |
|---|---|---|---|---|
| D1 | 会话头发起消息 | **已修复并实测通过（2026-11-09）**：发送新消息 → 计费准入（run 201 + admit + reserve_quote）→ 凭据代理 → AI 节点 → SSE 流式回复 → usage 上报 → 原生日志核验 → **request confirmed + run completed + receipt 落库 + 配额扣减**。e2e 连发 4 条全成功（截图 159-163） | mock 回复「【本地 mock 模型…】已收到你的消息：…」出现在对话区 | 根因链与修复见「AI 服务本地配置（终态）」节；**注意：完全相同的消息内容重复发送会因请求去重走对账路径（对旧 run 404）**，换文案即可 |
| D2 | 成员面板名册 | 项目工作台右上「成员 1」→ 面板 | 名册显示验收负责人 | ⚠️ **e2e 发现「操作失败，请重试」且无 HTTP 请求**——疑似会话头入口的 scope 接线缺陷，修复前此项无法验收（项目页抽屉入口未复测失败） |
| D3 | 文件上传 | admin 侧为空间开通项目文件库（需 COS/staging 凭据）→ 客户端文件 Tab 上传 | 文件出现、可 @ 引用 | 本地无 COS，门控文案已验证（B9） |
| D4 | 我的应用全旅程 | 会话生成画布应用 →「保存到我的应用」→ 首页发布 → 成员账号可见 → 撤回 | 发布后成员首页可见；撤回后回到我的应用 | 需 LLM 配置以生成应用；UI 入口已验证 |
| D5 | 个人空间切换 | 切换器 → 我的空间 | 默认聊天首页、无项目区?（个人空间本期无项目）、我的应用（无发布按钮） | e2e 未走完，界面入口已见 |
| D6 | KB 迁移与退役面 | staging 部署 admin POO-205 分支 → 跑 pol89/pol205 升级脚本 | 旧 KB 内容出现在迁移项目 | 本地无 KB 数据 |
| D7 | 管理后台旅程 | http://localhost:3000 管理控制台登录（staff 账号需自建）→ 组织/成员管理 | 与客户端联动 | 本地无 staff 账号 |
| D8 | 旧项目企业升级 | staging 跑 `scripts/poo205-upgrade-project-enterprises.ts`（dry-run → --apply） | 组织+同名项目+资产回填+mapping 可查 | 内测数据在 staging |

## 环境说明（保留运行中）

- **客户端**：POO-205 隔离实例（POLO_AI_CONFIG_DIR=~/.polo-ai-2，vite 6173，CDP 9444）。停止：`lsof -ti:9444 | xargs kill` + 关窗口。
- **polo-admin**：http://localhost:3000 （poo-205 worktree，`npm run dev`）。停止：`lsof -ti:3000 | xargs kill`。
- **数据库**：本地 PG `polo_admin_poo205`（独立库，未动用户的 `polo_admin_local`）。销毁：`psql -U wow -d postgres -c "DROP DATABASE polo_admin_poo205"`。
- 登录凭据见顶部测试账号；adminUrl 已写入 `~/.polo-ai-2/config.json`。

## AI 服务本地配置（2026-11-09 终态：全链路已通，4 处缺口修复）

此前「billing admission 201」只覆盖 run 创建；provider 请求准入（POST /runs/{id}/requests）实际一直 409→代理包装 502→Service Error。经插桩定位为 4 处独立缺口，全部修复：

1. **rates 修订从未创建**：`operations_rate_revisions` 为空 → `pol115_active_rate_snapshot()` effective=false → 绑定即 409。修复：直接播种 effective 修订（modelRatios: polo-local-test-model=1，quotaPerUnit=1000000）+ `operations_rate_state` active 指向。
2. **AI 节点缺 polo_request_correlation 能力**：`/api/status` 无能力声明 → fail-closed 409。已补（version 1 / X-Polo-Request-Id / client_request_id）。
3. **AI 节点缺 rc.16 契约面**：`/api/option/model_pricing/reserve_quote`（有界报价）、tokenGet 的 `user_id`+`key_fingerprint_sha256`、消费日志记录与 `/api/log/?client_request_id=` 查询面、SSE usage 终块——已全部补齐。
4. **节点 token key 与 DB 材料漂移**：首轮播种的 key 带 tokenCreate id 后缀（`sk-poo205-…-1000`），重启预置用的是无后缀常量 → 指纹核验 fail-closed。修复：启动时从 `new_api_space_provisions.keyTokenEncrypted` 解密对齐。

终态证据：连发 4 条全部流式回复；`billing_provider_requests.state=confirmed`、run completed、usage receipt 落库、quota usedTokens 累计 60（2 条×30）；结算核验读取 `/api/log/` 恰好一条同 nonce 日志（request_id 与 SSE 响应 id 同源）。

说明：admin 侧日志可能持续出现 `GET /requests 404 + PATCH run 404` 对账噪声——这是客户端 outbox 恢复循环在轮询坏档期滞留的 journal 条目（provider_not_ready 409 按设计不属「确定性拒绝」不可丢弃），每 30 秒最多 32 条、有界、无副作用；新发送不受影响。

## 已知问题（本轮发现，未阻塞其余验收）

1. **D2 成员名册失败**（见 D2 备注）——修复后需补 B/C 级验证。
2. 会话创建时 projectContext 快照不含 instructions（指令按设计随发送实时刷新；若期望创建快照即含指令需产品确认）。
3. workspaces 根目录不随 POLO_AI_CONFIG_DIR 隔离（仍为 ~/.polo-ai/workspaces）——多实例配置隔离的既有缺口，物理分存本身不受影响。
