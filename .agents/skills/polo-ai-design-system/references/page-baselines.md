# Polo 页面/区域基线索引

版本：`native-materials-r4-dev-aligned-20261023`。本文是 Skill 的维护源（登记于 `references/design-system.json` sources）；目标模板层引用的每个场景 ID 由 `docs/mvp-complete-flow-hifi/tools/check_design_system.py` 校验存在于消费 manifest。

## 分层：当前实现基线 vs 目标设计模板

两层素材性质不同，不可混用，也不可用同一长页同时声称组件库与完整产品原型：

| 层 | 载体 | 内容 | 证据性质 |
|---|---|---|---|
| **当前实现基线**（组件/区域/整页） | `assets/source-baseline/`（统一入口 `index.html`，场景目录 `entries/baseline.html`） | 场景集合由 `baseline-manifest.json` 从真实注册表求值得到（组件画廊、登录、工作台整页、首页、圈子、助手、设置子页与未登录态），由当前分支 renderer 源码真实渲染；fixture 只替换后端数据 | 实现事实（当前代码怎么渲染就是什么样），随分支演进由 `tools/source-baseline/build.py` 再生 |
| **目标设计模板**（已评审目标稿） | `docs/mvp-complete-flow-hifi/prototype.html`（场景地址 `#scene=P-*`） | M01 登录/M03 首页/M07 圈子的目标整页呈现，含系统态与旅程 | 产品已确认的目标设计，与当前实现可能存在差异；对齐属产品验收，不因实现演进自动再生 |

原生编辑、预览与任务候选方式见 [native-reuse.md](native-reuse.md)。本索引只导航现有素材，不维护第二份完整场景目录。

## 当前实现基线（打开方式与范围）

- 打开：`assets/source-baseline/index.html`（三层统一入口，file:// 可直接打开）→ `entries/baseline.html` 场景目录；地址支持 `?scene=ID` / `#scene=ID`，`&pure=1` 为不含说明栏的纯页面模式，可直接作新需求起点。
- **第二层组件画廊**（`?scene=components-gallery`）：Settings/聊天业务/Onboarding 三组生产组件卡与变体（数量以运行画廊分组过滤为准），每卡标注生产落点；页面/区域组合属页面场景目录，不在画廊重复。
- 区域→场景→生产文件的覆盖矩阵见 component-usage.md「按产品区域的覆盖矩阵」。
- **工作台整页**（`workspace-home` / `workspace-circle-detail`）复用当前 `TabShell`/`TopBar`/`ClientPageProvider`/`ClientHomeRouter`，首页→我的圈子→详情为产品自身 navigate/back 路由、同一 fixture 数据上下文——可直接作工作台新需求起点；Polo 助手标签页在整页场景中为占位（助手区域素材见 `chat-*` 场景），这是已声明的范围边界。
- fixture 范围（已注明模拟/真实边界）：后端 IPC 由 playground mock + baseline fixture 提供（正常目录、月度订阅与续费预览为正常态数据；离线/失败态不在默认场景内；账号安全未登录是明确独立态 `settings-account-security-signed-out`）；设置页开关与账号安全表单为受控写接口（内存完成，不持久化，不代表真实后端行为）。历史验证仅适用于 r2 导出：曾记录全场景 pageerror/console.error 清零及 0 外部网络请求；不代表本版本已验证。当前验证以对应提交的独立证据为准。材质作用域按真实组件判断，设置/助手不因此获得工作台设计授权。
- 再生：`python3 .agents/skills/polo-ai-design-system/tools/source-baseline/build.py`（repo root 执行；tsc 真实类型检查 → vite 场景提取与单文件打包 → 落位 Skill assets；`--check` 校验真实输入指纹与输出逐字节再生，由 check_design_system.py 强制）。

## 目标设计模板（打开方式）

- 打开：浏览器直接打开 `docs/mvp-complete-flow-hifi/prototype.html#scene=<ID>`；评审壳 `docs/mvp-complete-flow-hifi/review.html` 提供旅程导航。场景→组件映射见 `assets/prototypes/client-entry/prototype-manifest.json`（只索引本 Skill 范围场景）。这些是**已评审的目标页面**：忠实复现当前实现属实现事实，无需产品再确认；把目标模板当当前实现基线、或反之，都不成立。
- POO-105 材质固定参考快照：`assets/prototypes/poo105-materials/approved-r5.html`（home/chat/login 三景，绑定见同目录 `source-binding.json`；只读参考，不持续手改）。
- **复用顺序**：新需求优先复用当前实现基线（同层整页/区域），只改需求涉及部分 → 回退到组件（见 component-usage）→ 最后才到设计变量。若需求是落地目标模板层的已确认设计，则对照 `P-*` 场景。未变化区域优先复用；仅对未变化且确实无法复现的区域标 `Placeholder` 并给出真实源码与缺口；需求区、入口/返回与结果态不得占位，不能以粗略重画冒充高保真。
- 场景数量不等于还原证明：每场景仅代表该状态下的呈现；组合布局与未列出状态仍需按 foundations 的待复看边界处理。

## M01 登录与空间承接

| 场景 | 覆盖 | 生产落点 |
|---|---|---|
| `P-M01-LOGIN-PASSWORD` | 密码登录整页（品牌分栏 + 表单） | `components/onboarding/AdminLoginStep.tsx` |
| `P-M01-LOGIN-PHONE` | 验证码登录切换 | `components/onboarding/PhoneAuthStep.tsx` |
| `P-M01-LOGIN-CODE` | 验证码已发送态 | 同上 |
| `P-M01-LOGIN-CANCEL` | 用户取消 | — |
| `P-M01-PERSONAL-PREP` / `P-M01-PERSONAL-PREP-FAIL` | 我的空间准备中/失败 | `product-space/ProductSpacePreparationScreen` |
| `P-M01-REOPEN` / `P-M01-COLD-START` | 重开恢复 / 冷启动重验 | `product-space/*` |

## M03 首页与应用目录

| 场景 | 覆盖 | 生产落点 |
|---|---|---|
| `P-M03-HOME-PERSONAL` | 个人首页整页（顶栏 + 我的应用 + 圈子入口 + 助手卡） | `components/tab-browser/HomePage.tsx` + `app-shell/TopBar.tsx` |
| `P-M03-HOME-ENT` | 企业空间首页 | 同上 |
| `P-M03-HOME-ZERO` / `P-M03-HOME-EMPTY-DIR` | 首次使用 / 真空目录 | HomePage 系统态分区 |
| `P-M03-HOME-LOAD-FAIL` / `P-M03-HOME-OFFLINE` | 加载失败 / 离线缓存 | 同上 |
| `P-M03-ALL-APPS` | 全部 Apps（去重与授权来源） | AllApps 目录（退役组件注意见 component-inventory §9） |
| `P-M03-MANAGE-HOME` | 我的应用 · 本机隐藏项 | HomePage 管理入口 |

## M07 我的圈子与详情

| 场景 | 覆盖 | 生产落点 |
|---|---|---|
| `P-M07-LIST` / `P-M07-EMPTY` / `P-M07-LIST-RENEWED` | 圈子列表整页 / 空态 / 续费后 | `circles/MyCirclesPage.tsx` + `MemberCircleRow.tsx` |
| `P-M07-DETAIL-FOCUS`（+ `-UPDATES`/`-SUBSCRIPTION`） | 免费圈详情三分区 | `circles/CircleDetailPage.tsx` |
| `P-M07-DETAIL-PAID`（+ `-UPDATES`/`-SUBSCRIPTION`/`-AFTER-LEAVE`） | 付费圈详情与退出后 | 同上 |
| `P-M07-DETAIL-DATA` / `P-M07-DETAIL-DATA-SUBSCRIPTION` | 数据工坊圈内容/订阅 | 同上 |
| `P-M07-YEAR-RESULT` | 年度圈订阅权益 | 同上 |
| `P-M07-LEAVE` / `P-M07-LEAVE-PAID` / `P-M07-LEAVE-DATA` / `P-M07-LEAVE-YEAR` | 退出确认对话框各形态 | `circles/LeaveCircleDialog.tsx` |
| `P-M07-EXPIRED` / `P-M07-RENEW` / `P-M07-RENEW-EXPIRED` / `P-M07-RENEW-YEAR` / `P-M07-RENEW-LIMIT` / `P-M07-RENEW-RETURN` | 到期与续费 | 圈子详情 + 浏览器交接 |
| `P-M07-PAY-RETURN` / `P-M07-PAY-RETURN-FAIL` / `P-M07-RETURN` / `P-M07-RETURN-FAIL` / `P-M07-YEAR-RETURN` | 返回核对原订单/资格 | CircleReturnPanel |
| `P-M07-ACCOUNT-MISMATCH` / `P-M07-LOGIN` / `P-M07-LOGIN-PHONE` | 账号不一致 / 切回账号 | 交接收敛页 |
| `P-M07-SUPPORT` / `P-M07-SUPPORT-LOAD-FAIL` | 联系客服 | SupportPanel |
| `P-M07-SOURCE-FALLBACK` | 授权来源更新 · 仍可使用 | `MemberAppCard` 详情展开 |
| `P-M07-REJOIN-BROWSER` | 重新加入（浏览器交接） | `tab-browser/WebAppView.tsx` |

本轮对齐固定 dev `6e97b314`，当前 Spec 的 D-PC-15 已纳入登录后的多空间确认。基线 fixture 仍是单个个人空间；`login-*` 是登录表单场景，未建立多空间确认页独立场景。当前实现素材由合入后的真实组件再生，旧 `P-*` 目标模板仍限于其已确认版本；来源再绑定不代表新流程或新整页已通过视觉验收。

## 覆盖缺口（明确未建立基线，不要假借其他素材冒充）

- **设置页整页（目标模板层）**：`pages/settings/*` 注册表子页（当前集合以源码和生成 manifest 为准）在 `P-*` 目标模板中无场景；当前实现基线已覆盖（`settings-*`，包含注册表子页 + 未登录独立态，真实页面组件 + 受控 fixture），新增设置项按 component-usage 消费组件，当前实现基线自动跟随注册表再生。
- **管理技能页**：Spec 暂缓（D-ASSISTANT-REUSE）；`product-space/ProductSpaceSkillsDialog.tsx` 已存在但无基线场景，改动需产品确认。
- **Polo 助手内部（会话流/附件/会话导航）**：当前实现基线已覆盖输入区与任务卡（`chat-*` 3 场景，复用 playground 注册协议）；完整会话流与历史导航无基线，原型转译助手（`design-demos/polo-client-source-baseline/prototype.html` 的 A-* 场景）只是行为衔接示意，不是视觉基线。
- **工作台整页 Polo 助手标签页**：整页场景中为占位（见上），助手标签页的完整装配（NavigationProvider + 会话数据）未进入基线。
- **第三方 App 内部**、浏览器内网页：不属本 Skill。
- **dark 主题**：令牌存在未验收，无基线场景。
- **800×600 窄窗**：原型声明额外回归，无逐场景基线；按 foundations 断点规则处理。
- **异常/系统态**：当前实现基线默认场景为正常态数据；离线、加载失败、回退等态未列为独立场景（目标模板层的 `P-M03-HOME-OFFLINE` 等覆盖目标态）。
- **新组合页面布局**：已有区域可复用，新组合的具体布局待复看（foundations「已确认/待复看」边界）。

## 维护

- 目标模板层：场景集由 `tools/build_review.py` 从主 manifest 再生；本文引用 ID 与消费 manifest 的一致性由 check_design_system.py 校验。新增/更名场景时：改主 manifest 权威源 → 按 usage-playbook 第 7 步完整命令重跑 build_review → 更新本文表格 → 重跑检查。
- 当前实现基线层：改 `tools/source-baseline/entries/*` 源 → `build.py` 再生落位（manifest 记录真实输入指纹与生成时的 HEAD/dirty 快照）→ check_design_system.py 强制输入指纹与逐字节再生；检查器对历史 evidence 只读，不回写。
