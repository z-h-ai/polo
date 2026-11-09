# POO-205 端到端体验验收报告（对照 enhance-prompt.md 12 项输出要求）

基线：客户端 `POO-205/refactor/space-interaction@1e85b2bc` · polo-admin `POO-205/integration@75014650` · 本地全栈环境（DB `polo_admin_poo205` / admin :3000 / AI 节点 :9780 / 客户端隔离实例 CDP :9444）。
测试账号：`13100000001`（验收负责人，组织 owner）/ `13100000002`（成员）。证据截图：`/tmp/poo205-e2e-evidence/`（04-163 号）。

---

## 1. 功能范围盘点结果

盘点依据：本仓路由/组件树（app-shell、tab-browser、projects、project-context、product-spaces、apisetup）、POO-205 spec.md（Q1-Q13 裁决）、acceptance-checklist.md、polo-admin REST 面（projects/catalog/my-apps/billing/llm-connections）、既有 e2e 用例（space-select、preview-scope-seal、POO-202 三件套、poo196/poo161）。

| 域 | 功能 | 入口 | 角色/权限 | 状态 |
|---|---|---|---|---|
| 登录/身份 | 密码登录、多空间闸、空间切换事务 | 启动页→空间闸 | business 账号 | ✅ 已实现（B1-B3 实测） |
| 组织首页 | 项目区（列表/创建/角色徽标/用途）、我的应用、共享应用 | 首页 Tab | owner/member 可见差异 | ✅ 已实现（B4/B5 实测）；本期个人空间无项目区（设计内） |
| 项目工作台 | §10 项目 Tab 化：进项目=开独立 Tab（TopBar=首页\|项目名）、三栏会话、消息/文件/置顶、项目设置（用途/指令/成员） | 项目卡/Tab | myRole 载荷随 Tab | ✅ 已实现（B6-B8 + §10 专项实测） |
| 会话 | 创建（带 projectId+projectContext 物理分存）、发送/流式回复、历史过滤 | 项目 Tab 三栏 | 项目成员 | ✅ 已实现；D1 全链路 2026-11-09 修复后实测通过（4 连发） |
| @候选菜单 | 项目资产 @（含技能/来源 extra rows）、通用 @（技能/来源/文件）、slash、label | composer 输入触发 | 项目作用域 | ✅ 已实现；定位类 bug 已验证闭环（见 §3/§4） |
| 我的应用/目录 v2 | 保存到我的应用→空间内发布/撤回；Catalog visibility/ownerAccountId | 首页应用区 | member 发布需空间可见性 | ⚠️ 部分验证（UI 入口/契约测试绿；全旅程 D4 需 LLM 生成应用，可手测） |
| PC 文件区 | 项目共享文件、@ 引用 | 项目 Tab 文件 Tab | 项目成员 | ⚠️ 门控路径已验证（B9）；上传需 admin 开通 COS（D3） |
| 成员面板 | 项目成员名册/邀请桥接 | 工作台右上「成员」 | 项目成员 | ❌ 已知缺陷：会话头入口「操作失败」（无 HTTP 请求，scope 接线缺陷，D2 阻塞中） |
| KB 退役/迁移 | 旧知识库→项目共享区升级脚本 | staging 升级脚本 | 运维 | ⚠️ 本地无 KB 数据（D6/D8 需 staging） |
| 管理后台 | 组织/成员/运营台 | :3000 控制台 | staff | ⚠️ 本地无 staff 账号（D7）；运营台 rates 面经 saveRates 契约测试覆盖 |
| 计费/算力 | 空间算力交付链、准入、计量、结算 | 发送消息即触发 | 空间成员 | ✅ 全链路实测通过（§6） |

假设与待确认项：个人空间本期不做项目区（owner 裁决）；存量企业平移走升级脚本（D8，staging）；客户端创建企业空间入口本期不做（owner 裁决 2026-11-07）。

## 2. 端到端功能测试清单与覆盖情况

见 acceptance-checklist.md：A 组自动化证据（typecheck 0 错、全量 8890 pass/39 fail 全部基线同名零回归、i18n parity 70）；B 组真实应用 e2e 11 项（B1-B10，截图 04-151）；D 组用户手测 8 项（D1 已由本轮完成并闭环，D2-D8 保留环境待手测）。覆盖主流程（登录→进组织→建项目→发消息→回复）、异常流程（AI 未配置降级文案、门控空态、错误卡片+Retry）、边界（长文本右缘钳制、IME 组合键 R-AT、多 Tab 切换重绑）。

## 3. 问题列表（本轮新发现并闭环）

| # | 级别 | 问题 | 复现 | 根因 | 修复与验证 |
|---|---|---|---|---|---|
| P1 | 高 | 发送消息 Service Error（AI 服务不可用） | 任意项目会话发送 | 五层链：① rates 修订从未播种→绑定 409；② 节点 /api/status 缺关联能力→fail-closed；③ 节点缺 reserve_quote/token 身份字段/消费日志/api/log/SSE usage 终块；④ 节点 token key 与 DB 材料漂移→指纹核验失败；⑤ 每层 409 被凭据代理包装为无差异 502，掩盖真因 | 逐层修复（seed rates 修订；节点补 4 个契约面+key 对齐 DB）；插桩定位→修复→连发 4 条全流式回复，request confirmed/run completed/receipt 落库/配额扣减 60（截图 159-163） |
| P2 | 高 | ProjectHomePanel 无限重渲染崩溃（进组织即崩） | 进入组织首页 | useSyncExternalStore 快照每次新建对象（非 Object.is 稳定） | projects-bus 快照缓存（5fe0c4a3）；HomePage.projects 10/10 回归绿 |
| P3 | 中 | §10 项目 Tab 重启后丢失 | 持久化快照恢复 | restoreTabs 未保留 type='project' | 恢复过滤补 project 分支（1e85b2bc，标题陈旧无害、重进刷新） |
| P4 | 中 | §10 Tab 写入落到错误的 jotai store | e2e 抓出：Tab 打不开 | 模块函数用 getDefaultStore，而应用运行在 JotaiProvider 内 | 调用方 useStore() 透传（b4acafbc） |
| P5 | 低 | 成员面板名册「操作失败，请重试」 | 项目工作台→成员 | 会话头入口 scope 接线缺陷（无 HTTP 请求即失败） | **未修复**（D2 阻塞中）；项目页抽屉入口未复现失败，待定位 |
| P6 | 信息 | admin 日志持续 404 对账噪声 | 观察 admin 日志 | 客户端 outbox 恢复循环轮询坏档期滞留的 journal（provider_not_ready 409 按设计不算确定性拒绝、不可丢弃），每 30s≤32 条、有界、无副作用 | 记录为已知噪声，不修复（设计语义如此） |

## 4. 已知样例的根因分析和修复说明

样例：「对话框输入触发候选菜单时，选项位置完全错误，出现在整个输入框的右侧」。

- **复现验证**：真实应用 e2e 几何实测（drive59 脚本，截图 150/151）。常规位置：菜单左缘 684 ≈ 光标 x-10（683.7）、底缘 698 在光标线（706.25）上方 8px——锚定正确；右缘用例：70 字符把光标推至 x=1104，菜单被钳制在 left=1072（=innerWidth-320-8），右缘 1392=innerWidth-8，不溢出视口。
- **根因（历史 bug 为什么发生过）**：聚焦面板祖先携带 `client-material-reading`（backdrop-filter），使 panel 成为所有 position:fixed 后代的包含块——composer 浮层用视口坐标定位却被按 panel 盒解释，于是「钉在 panel 右缘」。这属于**设计/实现环节**缺失：交互规范未约定浮层坐标系契约，实现采用了 portal 前的 fixed 定位。
- **修复（已在库，本轮验证）**：POO-196 R-AT 裁决建立 ViewportPortal（mount 到 body）+ clampFloatLeft/Bottom 视口钳制 + useCloseOnViewportResize（浮层不随陈旧锚点残留）。本轮横向核查 4 个光标锚定候选面（mention/slash/label/skill-mention）+ AssetMentionPopover + ApiKeyInput 下拉全部合规；其余 fixed 元素均为全屏遮罩类（inset-0），无锚定问题。
- **为什么没被提前发现**：隔离组件测试无法暴露「fixed 包含块」这类依赖真实祖先样式的布局 bug；本轮以真实应用几何断言（菜单 rect vs 光标 rect vs 视口 rect）补上了这类验收手段。

## 5. 同类交互问题排查结果

- 静态扫描全部 `fixed`/`absolute` 浮层：viewport-portal 化 6 处（4 候选菜单+AssetMentionPopover+ApiKeyInput）全部 body-portal+钳制；全屏遮罩类（SplashScreen、dialog、WindowWidthGuard、ProjectMembersPanel、ProjectAssetPreviewOverlay、RightSidebarPane/CanvasPane 拖拽热区、AdminLoginStep）不依赖锚定坐标，无同类风险。
- IME 组合输入：候选菜单键盘导航带 `e.isComposing` 守卫（R-AT），Enter/方向键不会在组词中误选行。
- 浮层生命周期：viewport resize 即关闭（不残留陈旧锚点）；点击外部关闭。
- 键盘可达性：候选菜单 ↑↓/Enter/Tab/Esc 全键盘可达，底部有「↑↓ 选择 · Enter 确认 · Esc 关闭」提示（截图 151 可见）。

## 6. 计费/算力链路实测证据（P1 闭环）

发送 → `POST /billing/runs 201`（POL-102 准入+预留）→ `POST /runs/{id}/requests 201`（绑定核验→关联能力→token 身份/指纹→reserve_quote 有界报价→POL-21 admit 落库）→ 凭据代理注入 `X-Polo-Request-Id` → AI 节点 SSE 回复（含 usage 终块）→ `POST /billing/usage 200`（原生日志按 nonce 核验：恰好一条、token/用户/模型/token 数全对齐）→ **request `confirmed`、run `completed`、receipt 1 条、quota usedTokens 累计 60**。连续 4 条新消息全部成功（159-163 截图），插桩移除后复测仍绿。

## 7. 苹果 HIG 对照结论

符合项：可发现性（新建会话/项目卡/设置入口随位置就近）；直接操作（候选菜单锚定光标、菜单/弹窗不跳意外位置）；反馈（发送中流式、错误卡片含 Retry+技术详情、门控空态文案明确下一步）；防错容错（危险操作确认、错误可重试、菜单 Esc 可退）；低认知负荷（中文文案通俗、角色徽标/成员数直观）；动效克制（FadingText/过渡均为功能性）。
偏差项：P5 成员面板失败仅给「操作失败，请重试」未说明原因（等 P5 修复时一并补错误语义）；重复内容消息的去重对账对零基础用户表现为无响应（设计内的 requestId 对账语义，文案可后续优化）。

## 8. 流程回溯结论

1. **本地验收环境曾经没有「真」端到端**：rates 修订从未播种，但验收记录只验证到「run 201」就认为链路通——验收标准不清（把准入的第一步当成了全链路）。
2. **mock 节点契约面不全**：建环境时按「能回消息」搭建，未对照 admin 侧 fail-closed 检查清单（能力声明/报价/日志核验/token 指纹）逐项验收——测试用例遗漏。
3. **错误包装丢语义**：凭据代理把所有上游异常包成同一个 502 文案，导致表层现象（Service Error）与真因（provider_not_ready 等 5 种）断裂——可观测性不足。
4. **浮层定位类 bug 依赖真实祖先样式**，隔离测试天然测不到——需要几何断言式的真实布局回归（本轮已补）。

## 9. 流程优化方案（防呆）

1. 端到端验收标准绑定「最后一个可观测产物」（UI 回复/DB 终态），不接受中间层 2xx 作为通过证据。
2. 本地 AI 节点建立契约清单 checklist（status 能力/quote/token 身份/日志/usage 终块），启动时自检并打印。
3. 代理 502 附带上游错误码透传（排查期插桩已证明可行，生产化时把 `provider_not_ready` 等码透传到技术详情）。
4. 浮层组件一律走 ViewportPortal+clamp 组合，新增浮层在 code review 时按 viewport-portal.tsx 头注释的防呆规范核对（portal-free 例外需显式坐标契约+真实布局回归）。
5. 真实应用几何断言脚本（drive59）沉淀为验收资产，覆盖每个新浮层的锚定/钳制两用例。

## 10. 裁决记录（GLM-5.3）

| 事项 | 裁决 | 依据 |
|---|---|---|
| rates 缺失的修复方式 | 直接 DB 播种 effective 修订，不走运营台 saveRates | saveRates 需 staff+密码重认证会话，本地环境无 staff；等价产物、不动生产路径 |
| 节点契约缺口修复方式 | 扩展本地 mock 节点（不碰 admin 生产代码） | 缺口全部在本地工具侧；admin fail-closed 行为是正确设计，不应放宽 |
| P6 404 噪声 | 不修复，记录说明 | 恢复循环语义按设计（409 不可静默丢弃），有界无副作用 |
| 重复消息 409 对账语义 | 保持，文档提示换文案 | 去重是计费正确性要求，UI 优化留待后续 |
| 候选菜单「修复」范围 | 无需改码，验证闭环 | 该 bug 类已在库内修复（ViewportPortal R-AT），本轮补真实几何验收证据 |

## 11. 修复与回归结果汇总

- 客户端：1e85b2bc（§10 Tab 恢复）；5fe0c4a3/b4acafbc/f68a4bfd（§10 链）。定向回归：mention-menu 19 pass、AssetMentionPopover 0 fail、AssetMentionExtraPick 0 fail、HomePage.projects 0 fail、ClientPageContext 0 fail。
- polo-admin： tracked 文件零改动（插桩已还原，git status 干净）；本地工具 `scripts/poo205-local-ai-node.mts` 扩展 4 个契约面（untracked 本地工具）。
- 本地环境：rates 修订播种 + AI 节点重启对齐。全链路 4 连发回归绿。
- 零基础用户视角：登录→进组织→进项目→发消息→收到回复，全程无文档可完成（本轮 drive 脚本即为该最小路径）；错误场景有 Retry 与可展开的技术详情。

## 12. 最终验收结论

| 域 | 结论 |
|---|---|
| 登录/空间闸/切换 | ✅ 可用且易用 |
| 组织首页/项目区/创建 | ✅ 可用且易用 |
| §10 项目 Tab 三栏 | ✅ 可用（多 Tab/切换重绑/重启恢复均实测） |
| 会话发送/流式回复 | ✅ 全链路修复后可用（P1 闭环） |
| 候选菜单（@/slash/label） | ✅ 可用，定位类 bug 验证闭环 |
| 我的应用/目录 v2 | ⚠️ 入口与契约就绪；全旅程待 D4 手测 |
| PC 文件区 | ⚠️ 门控正确；上传待 D3（需 COS） |
| 成员面板名册 | ❌ P5 缺陷未修复（D2 阻塞）——当前唯一未通过的可触达功能 |
| KB 迁移/管理后台/存量升级 | ⚠️ 需 staging/staff（D6/D7/D8），本地不可达 |
