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

## C. e2e 发现并已修复（本轮闭环）

| # | 问题 | 修复 | 回归 |
|---|---|---|---|
| C1 | ProjectHomePanel 无限重渲染崩溃（useSyncExternalStore 快照每次新建对象），进组织即崩 | projects-bus 快照缓存（5fe0c4a3） | HomePage.projects 10/10 |

## D. 待用户手测（环境已保留；按序执行）

| # | 场景 | 步骤 | 预期 | 备注 |
|---|---|---|---|---|
| D1 | 会话头发起消息 | 配置 LLM 连接后（设置→模型），项目会话发送消息 | 回复携带项目上下文；指令生效 | 本地未配模型，须先配 |
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

## 已知问题（本轮发现，未阻塞其余验收）

1. **D2 成员名册失败**（见 D2 备注）——修复后需补 B/C 级验证。
2. 会话创建时 projectContext 快照不含 instructions（指令按设计随发送实时刷新；若期望创建快照即含指令需产品确认）。
3. workspaces 根目录不随 POLO_AI_CONFIG_DIR 隔离（仍为 ~/.polo-ai/workspaces）——多实例配置隔离的既有缺口，物理分存本身不受影响。
