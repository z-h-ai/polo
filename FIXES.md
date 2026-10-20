# POO-77/78/79 R2 产品失败修复

修复范围：P-R2-01..05。基线：`7ece647ad50045bc12cd4e9ff22ce03284407c28`，分支 `fix/poo77-79-r2-failures-20261018`。

## 来源与边界

- 任务要求：本目录 `FIX-BRIEF.md`。
- 本轮失败事实：`/Users/wow/project/z-h-ai/polo-dir/dev/.pipeline/poo77-79-reacceptance-20261018-154141Z/supervisor/accept-batch-r2-codex/product-findings.json`；P-R2-04 另核对其引用的 `supplemental/b-bootstrap-diagnosis.json`。这些是固定 R2 的失败证据，未改写。
- 产品规则：`docs/client-journey-review/spec.md` §13.9、§13.13、PC-F01、C-R01；当前文件 SHA-256 为 `269f75b0a820098c1896463540b78e460a83ab1bd89051184add007f6a533fe7`，与仓库设计系统绑定一致。生产 TS/TSX 是本次修改的实现源；未改设计源、生成协议、原型或历史报告。
- 本次完成代码与受控回归验证；未启动或停止现有 Polo 服务、Electron、报告服务或 tmux，未执行新的真实账号/支付/视觉验收，未 push。

## P-R2-01：返回首页落回圈子详情

**代码根因**：`CircleDetailPage.handleBack` 定向 navigate 到 circles，形成 `[home, circles, detail, circles]`。`MyCirclesPage.handleBack` 却调用历史 back，因此“返回首页”实际上弹回 detail；原 reducer 把 navigate(home) 也追加到栈，其他首页入口仍会留下旧详情。

**修复文件**：

- `apps/electron/src/renderer/components/circles/MyCirclesPage.tsx`：明确 navigate(home)。
- `apps/electron/src/renderer/context/ClientPageContext.tsx`：home 转移统一折叠成单个根路由，覆盖全部外层首页入口，之后 back 不会复活详情。

**回归**：`ClientPageContext.test.ts` 验证完整路由栈；`CircleDetailPage.interaction.isolated.ts` 在真实 Router/Provider 组合中点击详情→圈子→首页，再执行 back；`MyCirclesPage.interaction.isolated.ts` 将旧的“返回首页先回 circles”断言改为当前明确合同，并检查 canGoBack=false。搜索/筛选恢复和账号隔离用例继续通过。

## P-R2-02：取消未来续费误撤销当前权益

**代码根因**：`member-circle-view.ts:isMembershipCurrentlyPaidEntitled` 从新到旧扫描支付投影，仅跳过 pending；未来订单变为 cancelled/failed 后直接返回 false，尚未读取较旧的 paid 来源。首页失权集合、圈子列表和详情页头共用此函数，因而同时误判；订阅详情依据当前 membership，产生页面间不一致。

**修复文件**：`apps/electron/src/renderer/lib/member-circle-view.ts`。跳过未产生权益的 pending/cancelled/failed 尝试，继续查当前 paid 或保留部分权益的修正来源。仍先要求 membership active、付费期结束时间晚于当前时刻；退款/争议修正仍优先拒绝，不能被更旧 paid 掩盖；原有 unknown 投影处理合同不变。

**回归**：`member-circle-view.test.ts` 参数化 pending/cancelled/failed + 当前 paid，对照真实到期及只有未付款订单；原有全额退款、争议、部分退款、暂停、多圈来源用例继续通过。未更改原生/服务端启动授权规则。

## P-R2-03：订阅有效期重复

**代码根因**：`CircleDetailPage` 不分 section 渲染 termText，`CircleSubscriptionPanel` 已在详情行渲染同一有效期。

**修复文件**：`apps/electron/src/renderer/components/circles/CircleDetailPage.tsx`。subscription 分区隐藏页头 termText，保留圈子身份和状态；详情继续独占价格、周期与有效期。内容/更新分区原有期限提示保留。

**回归**：`CircleDetailPage.interaction.isolated.ts` 分别验证免费长期有效、付费有效期只出现一次且位于订阅详情，页头状态仍存在；`CircleSubscriptionPanel.interaction.isolated.ts` 既有免费/月度/年度、续费、上限及跨圈状态隔离测试通过。

## P-R2-04：切换到无企业账号后 bootstrap 持续失败

**已证实的代码根因**：

1. `registerLocalAppHandlers` 注册的 legacy cleaner 把 `listAllCatalogScopes()` 的所有磁盘 scope 都当作 legacy。ProductSpace 安装也映射成同一种 catalog tuple（`organizationId=productSpaceId`、`catalogAppId=artifactInstanceId`），因此枚举结果本身不证明 legacy 归属。
2. A 注销后 `ScopedLocalAppRuntimeRegistry.fenceAccount/stopAccount` 保持账号围栏关闭；普通 `stop/uninstall` 经 `runTrackedScopeOperation` 及 `assertAccountSessionActive` 拒绝 A 的 scope。
3. cleaner 捕获该异常并返回 ok=false；`product-space.ts:CLEANUP_LEGACY_STATE` 将其写为 `legacyInstallationStateRemoved=false`，bootstrap 无法形成全成功清理回执。此路径与 R2 的“B 已认证、个人空间 API 正常、唯独安装清理失败”相符；不是把“B 无企业”推断为服务端无空间。

**修复文件**：

- `apps/electron/src/main/handlers/local-apps.ts`：必须由账号/空间完全匹配的旧 Catalog 缓存明确识别 `local_bundle` 且无 ProductSpace artifact identity，才选择清理。ProductSpace 与归属不明的安装不再因 B 登录被误当 legacy 卸载。
- `apps/electron/src/main/local-app-runtime/scoped-registry.ts`：新增 Main 内部 `removeLegacyInstallationState`。读取既有 manager 的原生证据；已有 admission 或证据不可判定则保留。可确认的 legacy 通过 stopApps 围栏及等待在途操作，再卸载代码/安装状态、保留用户数据。该通道不对 renderer 暴露，不解除注销围栏，也不授予启动权。

**回归**：`local-apps.isolated.ts` 验证 B bootstrap 遇到 A ProductSpace、已识别 legacy、未知安装时只选 legacy，且不调用普通 stop/uninstall；真实清理失败仍返回失败与 failedRefs。`scoped-registry.test.ts` 使用真实 registry 验证注销后的受信清理成功、preserveData=true、A 仍不能 start/uninstall、B 状态读取正常，以及 native-admitted 安装绝不被迁移卸载。`product-space.isolated.ts` 的 bootstrap/清理/切换围栏回归也通过。

**待决项/保留材料**：没有阻塞本轮修复的产品裁决。历史 scope.json 没有独立的 legacy/ProductSpace 来源字段；缺失旧 Catalog 绑定或原生证据不足的安装保留在原账号隔离目录，不凭缺少 admission 推断为 legacy。将来若要自动回收这些历史安装，需补可靠的迁移归属/对账依据；不纳入本次自动删除。

## P-R2-05：撤权墓碑被后续 Catalog 轮询清空

**代码根因**：`recordProductSpaceCatalogAuthoritativeEntries` 仅 carry `previous.entries`，没有 carry `previous.tombstones`。首个空响应从 live entries 生成墓碑，后一个空响应的 previous.entries 已空，导致持久 tombstones 也变空。`admin.ts` 直接回传这批结果，renderer 重新打开后只能收到空 withdrawnEntries；不是 renderer 合并时获得了新授权。

**修复文件**：`packages/server-core/src/runtime/product-space-catalog-authority-internal.ts`。合并上一批 live entries 与已撤权 tombstones，按 catalogEntryId+artifactInstanceId 去重。持久保留原来源、版本与首次 withdrawnAt，不每次轮询续写撤权时间；fresh catalog 出现同一稳定身份时删除旧墓碑并使用新版本/来源/可用态。撤权投影始终处于 tombstones，绝不回填 live entries，也不能提供下载/启动授权。原有 schema、容量上限、原子写、deny、账号/空间隔离和冷启动默认不信任规则继续生效。

**消费者核对**：`handlers/rpc/admin.ts` 已逐次把 authority 返回值映射为 stripped withdrawnEntries；`useAppCatalog.ts` 已消费该 DTO、查询受限安装状态，`HomePage` 已禁用 withdrawn 打开入口。修复权威源即可修正三个消费者，无需增加 renderer 私有副本或将空 DTO 当作撤权恢复。

**回归**：`product-space-catalog-authority.test.ts` 验证多轮空读取、原撤权时间/来源不变、磁盘重载、真实子进程冷启动先拒绝而 fresh revalidation 后恢复撤权投影，以及 fresh 新版本恢复后旧墓碑/旧版本 tuple 消失。旧“第二次空读取应删除墓碑”测试已按本次明确合同替换。`useAppCatalog.interaction.isolated.ts` 新增真实持久 authority→Catalog DTO→真实 hook 的多次 sync、卸载 renderer/remount、拒绝启动和新版本恢复回归；HomePage.complete-directory 继续验证 disabled withdrawn 行。

## 验证记录

依赖用 `bun install --frozen-lockfile --ignore-scripts` 安装到本 worktree；未修改 lockfile，未运行 Electron 安装/启动脚本。测试使用仓库 Bun runner；`.isolated.ts` 均单文件单进程执行。一次性原始日志位于忽略目录 `.pipeline/r2-fixes/`，可按以下命令复跑。

| 检查 | 命令/文件（`bun test --isolate`） | 结果 |
| --- | --- | --- |
| 受影响单元/组件 | member-circle-view.test.ts、ClientPageContext.test.ts、product-space-catalog-authority.test.ts、scoped-registry.test.ts、useAppCatalog.test.ts、HomePage.complete-directory.test.ts | 143 pass，0 fail |
| 详情 Router 组合交互 | CircleDetailPage.interaction.isolated.ts | 25 pass，0 fail |
| 订阅交互 | CircleSubscriptionPanel.interaction.isolated.ts | 27 pass，0 fail |
| 圈子列表交互 | MyCirclesPage.interaction.isolated.ts | 15 pass，0 fail |
| Catalog 交互 | useAppCatalog.interaction.isolated.ts | 29 pass，0 fail |
| Main 本地应用 RPC | local-apps.isolated.ts | 88 pass，0 fail |
| 页面 Provider | ClientPageContext.isolated.ts | 4 pass，0 fail |
| ProductSpace RPC | product-space.isolated.ts | 59 pass，0 fail |
| Electron 类型检查 | `bun run typecheck:electron` | 通过，退出 0 |
| Server Core 类型检查 | `cd packages/server-core && bun run tsc --noEmit` | 通过，退出 0 |
| 修改的生产 Electron 文件 lint | `eslint` 六个修改的生产文件，使用 apps/electron 配置 | 通过，退出 0 |

受影响回归共 **390 pass，0 fail**。修复前新增回归已分别失败：P-R2-01 的栈与真实按钮、P-R2-02 的 cancelled/failed、P-R2-03 的免费/付费重复、P-R2-04 的 cleaner 与 registry fence、P-R2-05 的 authority 与真实 hook 轮询。新测试初次还发现测试辅助函数只模拟同进程 cache reload，已改为真实子进程验证冷启动边界；未放宽冷启动拒绝断言。

### 全量对照

两轮均执行仓库原命令 `bun run test`，使用同一本 worktree、依赖和环境。修复前一轮包含已加入的失败回归（不是纯净 HEAD 测试快照）；两轮首阶段失败后，脚本的 `&& bash scripts/run-isolated-tests.sh` 均未执行，因此上表的受影响 isolated 用例另外逐文件运行。

| 全量 | pass | skip | fail | errors | tests / files | 退出码 |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| 修复前，含新增失败回归 | 6975 | 19 | 44 | 4 | 7038 / 573 | 1 |
| 修复后 | 6981 | 19 | 39 | 4 | 7039 / 573 | 1 |

按去耗时后的失败用例名称逐项比对：**新增失败 0，消除 5 个本轮回归失败，剩余失败名称全部在修复前出现**；isolated 的 UI/清理回归另见上表。Bun 原始计数按输出保留，不把全量标成通过。

剩余问题包括：协议/通道路由与处理器快照未同步、语言包缺键/排序、Docker daemon 不可用、Pi CLI 运行环境缺少 piServerPath、Creator 示例构建/版本约束、macOS frontmost probe。两轮还有相同四处套件加载错误：缺 Renderer build manifest，admin.test.ts 导入不到 SKILL_TURN_CONTRACT_VERSION，以及 circle-return-deep-link/deep-link-routing 缺 Electron 二进制。未为处理这些范围外问题启动 Docker/Electron 或修改服务配置。

剩余失败名称（修复前后共同存在）：

- `RPC handler profile registration > registerCoreRpcHandlers registers only core channels`
- `RPC handler profile registration > registerGuiRpcHandlers registers only gui channels`
- `RPC handler registration > keeps onboarding channels in registration coverage`
- `RPC handler registration > registers all declared handled channels exactly once`
- `RPC_CHANNELS wire-format stability > contains exactly 406 channel strings`
- `RPC_CHANNELS wire-format stability > preserves exact wire-format strings (sorted equality)`
- `a managed resume model override is invocation-only and leaves the original Thread selection intact`
- `an empty real provider stream fails without retry or fake success`
- `an owned Thread retains its source when the mutable global default later becomes managed`
- `channel routing exhaustiveness > every channel is classified exactly once`
- `channel routing exhaustiveness > total classified equals total channels`
- `controlled real CLI → desktop Broker/proxy → Admin/Provider: personal+enterprise tools, billing, owner isolation and revoke`
- `copied example builds a Creator-uploadable payload without reserving an app identity`
- `example versions follow the receiving Admin SemVer contract`
- `i18n locale parity > de has all EN keys`
- `i18n locale parity > en keys are sorted alphabetically`
- `i18n locale parity > es has all EN keys`
- `i18n locale parity > hu has all EN keys`
- `i18n locale parity > ja has all EN keys`
- `i18n locale parity > pl has all EN keys`
- `i18n locale parity > zh-Hans keys are sorted alphabetically`
- `macOS full-validation frontmost probe > reports the native frontmost NSRunningApplication`
- `managed CLI cancels its actual server/worker on cancel`
- `managed CLI cancels its actual server/worker on desktop-death`
- `managed CLI cancels its actual server/worker on owner-death`
- `managed CLI cancels its actual server/worker on quit`
- `managed yolo cannot execute detached Bash, proxy scripts or prefetch, or evaluate cwd Pi packages/extensions`
- `owned CLI preserves global Skills when execution directory differs from HOME`
- `owned CLI safe mode retains local Skill reads and blocks writes`
- `real Pi worker and server stop after SIGINT; persistent Thread remains`
- `real Pi worker and server stop after SIGKILL; persistent Thread remains`
- `real Pi worker and server stop after SIGTERM; persistent Thread remains`
- `real Pi worker and server stop after deadline; persistent Thread remains`
- `real Pi worker and server stop after lease; persistent Thread remains`
- `standalone owned CLI completes a real Pi read/write tool loop and resumes the same Thread`
- `updates-static Caddy cache contract > revalidates every latest resource, caches only published releases, and hides publisher state`

日志：`full-before.log`、`full-after.log`、`full-comparison.json`；均在本 worktree 的 `.pipeline/r2-fixes/`，没有回写外部 R2 证据。全量之后再次核对暂存范围，排除测试生成的 `packages/shared/src/agent/__tests__/__tmp_build_call_llm__/`。


## 提交范围

仅提交本次修复源码、回归测试、用户提供的 FIX-BRIEF.md 和本报告。测试产生的临时文件不入库；未修改既有验收证据、生成协议、语言包或其他工作树。代码回归通过不替代 POO-77/78/79 的后续独立真实产品重验收。

## R4FIX 摘要

R4FIX-01/02/03 的 Client 修复现已完成：第三轮消费 Admin currentEntitlement v1，六条未来取消订单复现已转绿；最终受影响回归 28 个独立进程、649 pass / 0 fail，类型检查、构建、定向 lint 和受控浏览器通过。第二轮的 DTO 阻塞及 458 pass / 1 fail 是 `74e21509` 的历史结果，原日志保留；当前结论与证据见下方「R4FIX-02 Client 闭环（R4C）」；不替代正式三卡 Acceptance。

## R3 Findings 修复（R3FIX）

### 来源与范围

本轮固定基线 `371f6c8e8f9be7182b2d92ec9d5b6e40c3153b82`，仅在 `fix/poo77-79-r3-findings-20261019` 修复 TASK-FIX-R3.md 指定的五项 Client 缺陷。需求权威仍为 `docs/client-journey-review/spec.md`（SHA-256 `269f75b0a820098c1896463540b78e460a83ab1bd89051184add007f6a533fe7`），按 PC-F01、PC-F09/10、§13.2/13.3/13.9/13.12 的登录意图、导航、空间隔离和失败恢复规则实现；P70-* 是开发计划中的需求映射，不另作第二份需求源。设计系统的 Spec 绑定与当前文件一致，复用现有控件与 `common.cancel` 翻译，不修改设计源或生成原型。

失败事实来自固定 R3（这些历史回执不作为修复后的验收）：

- POO-79：`/Users/wow/project/z-h-ai/polo-dir/dev/.pipeline/poo77-79-r3-acceptance-20261019-033017/runtime/client/.pipeline/runs/poo77-79-r3-acceptance-20261019-033017/accept-poo79-r3-codex/product-findings.json`，P79-NAV-01/02、P79-AUTH-01/02。
- 同一 runs 树的 `poo77-79-r3-acceptance-20261019-033017-poo78/accept-poo78-r3-a2-codex/product-findings.json`，P78-V4-01/02。
- 同一 runs 树的 `poo77-79-r3-acceptance-20261019-033017-poo77/accept-poo77-r3-a3-codex/product-findings.json`，P77-A3-01/02。

### R3FIX-01：顶栏首页与品牌真正返回首页

**根因**：TopBar 的两个入口只调用 TabShell 的 `activateHome()`。圈子详情本来就在 Home 标签中，因此重复激活标签不会改变 ClientPage 路由，旧详情仍显示。

**改动**：`components/app-shell/TopBar.tsx` 的两个入口共用 `goHome`：先通过现有 ClientPageContext 执行 `navigate({ kind: 'home' })`，再激活 Home 标签。复用 R2 的 home 根栈折叠，清除旧详情历史；详情局部返回仍沿原路径。

**回归**：`TabShell.scope-isolation.isolated.ts` 新用例挂载真实 TabShell、TabShellProvider、ClientPageProvider、Home Router 和 ModalProvider；进入详情后分别点击首页/品牌，验证 route=home、canGoBack=false，back 不会复活详情。已有 `CircleDetailPage.interaction.isolated.ts` 的局部返回断言保留。修复前真实入口断言失败，修复后通过。

### R3FIX-02：返回圈子列表保留搜索与筛选

**根因**：`MyCirclesPage` 用一个 effect 恢复偏好，另一个 effect 保存初始空值。生产入口使用 React.StrictMode；列表仅随路由卸载、外层 relations provider 仍存活时，effect 重放可先把空值写入缓存，再用空缓存覆盖刚恢复的值。旧测试卸载整个 provider，未覆盖该组合。

**改动**：`components/circles/MyCirclesPage.tsx` 在 state 初始化时读取偏好，scope 变化时于 render 阶段重新封装该 scope 的状态；单个 effect 只保存已绑定的 view。继续使用既有 accountId + personalProductSpaceId + epoch 键，不新增持久化副本。账号/空间/epoch 变化使用独立默认状态，旧 scope 的值不进入新 scope。

**回归**：`MyCirclesPage.interaction.isolated.ts` 新增保持真实 relations provider 的路由卸载/重挂，以及 StrictMode 下搜索 design + valid 后离开/返回的组合；StrictMode 用例修复前收到空搜索，修复后正确恢复。原账号 A→B→A 隔离断言和全部既有筛选断言继续通过，未降低 F2 断言。

### R3FIX-03：密码等待期可取消并拒绝晚到回执

**根因**：密码忙态只有禁用控件；统一认证意图 gate 只处理其他离开动作，密码页没有可调用的取消入口，且 renderer 单独丢弃回执不足以阻止原生凭据写入。

**改动**：`AdminLoginStep` 在密码忙态显示可操作的取消按钮并接收 Esc；复用 `common.cancel`。`App`→`OnboardingWizard`→`AdminLoginStep` 接通 `useOnboarding.handleAdminCancelLogin`。取消先作废 renderer auth gate，再调用已有受信 `adminLogout()`，使用 R3FIX-04 的原生 attempt 围栏。等待 Main 确认前继续占用单次请求槽，避免新登录先于取消围栏落地；取消成功留在登录入口，失败保留可解释的错误。旧成功回执不会触发认证完成。

**回归**：`AdminLoginStep.interaction.isolated.ts` 分别点击按钮和按 Esc，验证取消可用、密码字段仍锁定。`useOnboarding.test.ts` 延迟登录和注销响应，验证调用原生注销、确认前不允许第二次登录、取消后 idle、旧成功无完成回调、之后允许新意图。既有密码/手机单次请求及陈旧回执用例保留。

### R3FIX-04：注销作废原生在途登录

**根因**：登录开始时取得 loginAttempt，提交凭据前已在 coordinator 临界区核对 attempt；但两个注销入口都只捕获现有 session，从未递增 attempt。无 session 分支甚至直接返回成功，因此旧 HTTP 200 仍能通过提交核对。

**改动**：`packages/server-core/src/handlers/rpc/admin.ts` 在同一 coordinator 临界区内通过 `captureForLogout` 先递增 loginAttempt，再读取 session。原生 `admin.LOGOUT` 与通用 `auth.LOGOUT` 的 `endCurrentSession` 都消费此入口，覆盖有旧会话和无会话两条分支。继续复用既有临界区内的 latest-attempt 核对、会话 generation 和最终删除 CAS；登录提交与注销围栏串行化，账号切换仍通过新 attempt 使旧登录失效，不增加 RPC 或 renderer 授权能力。

**回归**：`admin.isolated.ts` 参数化两个注销入口 × 有/无旧 session（4 例）：延迟 A 登录→注销→确认无凭据→释放成功响应，必须返回 `SESSION_CHANGED`，凭据仍为空，也不能启动 A 会话。四例修复前全部复现 success=true，修复后通过。既有换账号、旧注销清理晚于新账号提交、refresh/validate CAS、执行停止围栏回归继续通过。

### R3FIX-05：无缓存目录失败显示失败与主动重试

**根因**：`useAppCatalog` 的失败 DTO 与 thrown error 两条分支均无条件设置 accessMode=offline。目录投影优先消费 accessMode，因此首次 503、catalog=null 也被归为离线缓存，绕过 HomePage 已有的加载失败/重试卡。

**改动**：`hooks/useAppCatalog.ts` 保留授权拒绝的独立分支；其他失败只有当前作用域确有 catalogRef 缓存才设置 offline，无缓存时保留 errorCode、accessMode=null，让既有 HomePage 失败卡提供 `sync(true)`。继续沿用上下文切换清空 ref 的隔离机制；保留有缓存的 offline 语义，不自动打开 App。

**回归**：`useAppCatalog.interaction.isolated.ts` 分别覆盖返回 503 和抛异常的无缓存失败、显式 force sync 恢复、无自动 start；既有缓存保留、offline、denied、账号/空间隔离继续通过。`HomePage.complete-directory.test.ts` 经真实 MemberCatalogProvider + useAppCatalog 验证失败卡、无 offline banner、可用重试按钮、重试不带 knownRevision、恢复后不自动 open。新 UI 回归也在替换为基线 hook 时确认失败，随后恢复修复源码并复跑通过。

### R3FIX 验证记录

依赖安装命令 `bun install`，lockfile 未改变。所有测试均逐文件独立进程运行，路径有 `./` 前缀；完整输出先写文件，保留退出码，未通过管道截断测试结果。运行器为每个子进程创建临时 HOME 和 POLO_AI_CONFIG_DIR，先在同一环境断言 `os.homedir()` 等于临时目录且不是 `/Users/wow`，再执行测试。通用注销用例会触达 homedir 下 config 路径，故它们仅在该隔离证明通过后执行；未读写用户配置。

最终定向回归：**19 个独立套件，444 pass，0 fail，19 个退出码均为 0**。完整原始输出为根目录 `verify.log`（未跟踪，匹配既有 `*.log` 忽略规则）。本轮一次性运行器及辅助证据留在忽略目录 `.pipeline/r3fix/`；本机可用 `python3 .pipeline/r3fix/run-tests.py verify.log` 重跑相同 19 套件，各原始命令也逐条记录于 verify.log。

| 验证 | 文件/命令 | 结果 |
| --- | --- | --- |
| 顶栏、路由、scope | TabShell.scope-isolation、ClientPageContext.test、ClientPageContext.isolated、TopBar.registry-poller、TopBar.product-space-menu | 全绿 |
| 圈子相邻交互 | MyCirclesPage、CircleDetailPage、CircleSubscriptionPanel 的 interaction.isolated | 全绿 |
| 认证 | AdminLoginStep.interaction.isolated、useOnboarding.test、preload admin-api.test、原生 admin.isolated | 全绿 |
| 目录与权益 | useAppCatalog.interaction.isolated、useAppCatalog.test、useMemberCircles.test、home-app-directory.test、member-circle-view.test、HomePage.complete-directory、HomePage.offline-start.interaction.isolated | 全绿 |
| Electron 类型 | `bun run typecheck:electron` | 退出 0 |
| Server Core 类型 | `cd packages/server-core && bun run tsc --noEmit` | 退出 0 |
| Renderer 构建 | `bun run --cwd packages/shared build` 后 `bun run electron:build:renderer` | 退出 0；初次缺 shared 派生产物，按既有生成命令生成后通过 |
| Main 构建 | `bun run electron:build:main` | 退出 0，Build complete and verified |
| 定向 lint 对照 | 对 7 个修改的 renderer 生产文件执行 ESLint，并用 stdin 输入固定基线源码逐项对照 | 新增诊断 0；基线与当前均有 2 error / 20 warning，未伪称全量 lint 通过 |

**受控浏览器与视觉**：本轮临时 Vite 页面消费真实 AdminLoginStep + useOnboarding，以及 HomePage + MemberCatalogProvider + useAppCatalog，RPC 为明确标注的 fixture。无头 Chromium 实际点击取消、按 Esc、释放晚到成功、执行目录错误后的重试；结果 PASS，页面异常 0、自动 open 0。已打开并检查 1440×900、1024×768 的登录忙态截图，以及目录失败/恢复截图，取消按钮可见且可用，失败卡明确显示重试。证据位于 `.pipeline/r3fix/browser-result.json`、`browser-check.log`、`login-busy-1440.png`、`login-busy-1024.png`、`login-cancelled-1440.png`、`home-load-failed-1024.png`、`home-recovered-1024.png`。这是受控 renderer 验证，不替代协调方在本分支 HEAD 上执行 POO-77/78/79 独立真实产品验收。

**扩大检查的基线问题**：额外运行 `HomePage.round2.interaction.isolated.ts` 和 `packages/server-core/src/handlers/rpc/admin.test.ts` 后，发现两条已有首页失败和一处套件加载错误。将本次所有修改的生产文件暂时逐字替换为 `371f6c8e` 源码，在同一隔离环境重复两套件后，再逐字恢复修复源码；结果与失败名称完全相同：

- `prepares a resolved bundle through the install dialog and publishes the re-resolved launch`：期望 resolveLaunch 两次，实际三次；该文件 mock 了 useAppCatalog，并不执行本轮改动的 hook。
- `keeps a withdrawn tombstone visible and non-launchable, with the uninstall entry while installed locally`：期待 toast，实际没有；首页撤权行的既有禁用行为与测试预期不一致。
- `admin.test.ts` 的 `@polo-ai/shared/admin` 模块 mock 缺 `SKILL_TURN_CONTRACT_VERSION`，在加载时失败；原生生命周期的独立 `admin.isolated.ts` 124 项全部通过。

扩大检查当前/基线日志分别为 `.pipeline/r3fix/expanded-current.log`、`expanded-baseline.log`。本轮未放宽这些断言，也未改范围外安装、撤权和 Skill 契约代码。登录页两处任意 shadow 类 lint 错误及 20 条 hook 警告同样属于基线，逐项对照证据为 `lint-comparison.json`；建议另行修复对应样式来源和旧测试契约。整个仓库全量测试及正式 POO-77/78/79 验收未在本轮执行。

### 待用户决策

无阻塞五项修复的产品裁决。保留上述范围外基线问题供后续单独处理。提交仅包含五项修复源码、隔离回归和本 FIXES.md 记录；TASK-FIX-R3.md、USER-AUTHORIZATION-R3FIX.md 保持 untracked，verify.log 和临时预览/浏览器脚本、截图不入库。不修改 dev、不 push、不编辑任务卡正文；是否合入 dev 仍由用户决定。


## R4 Findings 修复（R4FIX）

以下为第二轮 `74e21509` 的固定记录；其中 R4FIX-02 的阻塞已由第三轮契约交付和 Client 消费解除，见文末。

基线：`5eda44445ef39dda295ac7033faabd378ee4fba5`。范围为 TASK-FIX-R4.md 的三项 Client 问题。固定 R4 证据为 `.pipeline/poo77-79-r4-acceptance-20261019-022614/RESULT.md` 与该 run 的 POO-78/79 product-findings.json；不改历史失败回执。产品权威仍为 Spec（SHA-256 `269f75b0a820098c1896463540b78e460a83ab1bd89051184add007f6a533fe7`），沿用当前权益、到期拒绝、同账号/空间隔离和原导航规则。

### Admin DTO 需求 / 待转 Admin（R4FIX-02，74e21509 历史记录）

已只读核对 Admin 固定验收版本对应 worktree 的 `src/app/api/me/circle-memberships/route.ts`：paymentOrders 以 updatedAt 降序取五单，纠正投影也仅计算这五单。Client 的 `packages/shared/src/admin/member-circles.ts` 映射只包含 membership status/currentPeriodEnd 与这五单，未提供当前权益来源、当前期纠正结果或历史完整性标记。

例子：当前期付款 P 仍有效，之后创建六次未来取消尝试，DTO 只剩五条 cancelled，P 的身份和纠正事实均缺失。相同的 DTO 还可能隐藏已全退/争议的 P。单凭 active + 将来到期日放行会破坏已有 active + 全退/争议拒绝断言；以订单数量达到五条作为放行条件也没有权威依据。Client 不能从这份有损历史自洽判定当前期付款资格，且不得扩大最近五单推断、忽略纠正或伪造 paid。

推荐由 Admin 提供与 membershipId 绑定、独立于最近五单的 `currentEntitlement` 投影：明确 entitled/not_entitled/unknown、计算时间、有效期上界，以及当前期来源与退款/争议纠正事实。它应复用 Catalog/resolve-launch 所消费的同一权威，不以最近订单状态代替当前期授权。Client 收到已确认的字段名/类型/枚举与真实响应后，扩展 shared schema + 映射并统一消费；保留生命周期和本机时钟到期拒绝，对缺字段的旧响应继续保持原有保守行为，不静默升级为新授权。

Admin 侧需要确认并覆盖：六条未来 cancelled、五条以内未来 cancelled、含一条 pending、无未付尝试时仍 entitled；自然到期、全退及争议时 not_entitled；部分纠正以实际保留权益为准；原 paid 被最近五单挤出时结果仍完整。契约在本轮当前已读来源中尚未提供，Client 第 2 项保持“待 Admin 契约”，不得报告为已修复。未修改其他 Admin worktree 或任务文件。


### R4FIX-01：到期后的订阅状态

**根因**：CircleSubscriptionPanel 的 `resolveSubscriptionStatus` 直接返回存储的 membership.status，未消费列表/页头共用的 `isMembershipCurrentlyPaidEntitled`。自然时钟越过 currentPeriodEnd，原始 active 未更新，面板因此仍绿色有效。原列表/Home 的 memo 也不会仅因时间流逝主动重新计算。

**改动**：订阅面板复用当前权益投影及 provider 到期时间，已到期/纠正失权不再作为 active 显示；原始关系与历史订单不改写，已保留的旧 paid 不掩盖到期/全退/争议。无 membership 的 paid circle 回退也检查有效期。新增轻量 `hooks/useMemberCircleClock.ts`，按已读到期时间唤醒并刷新本地显示，供首页、列表、详情页头和订阅面板共同消费；不发起认证、订单或启动请求，不制造业务资格。计时器在关系绑定变化/组件卸载时清理，长周期按系统 timeout 上限分段重排。

**回归**：CircleSubscriptionPanel.interaction.isolated 新增真实短时钟越过到期点、无需重新读取/重挂载的断言；对照退款、争议、未来 pending/cancelled/failed + 当前 paid，另测缺 membership 的过期 paid circle。修复前自然到期、全退、争议、circle 回退共四项失败，修复后全部通过；既有部分退款/部分争议、到期、旧 paid 与未来续费对照保留。页面仍停留时也自动从绿色有效变为已到期，详情页头同时待恢复。

### R4FIX-03：同 scope 列表滚动恢复

**根因**：既有 accountId + personalProductSpaceId + epoch 的 view store 只有 query/filter，路由重挂后主容器 scrollTop 从 0 开始。

**改动**：在同一个 view authority 增加 scrollTop，不新建持久化/模块缓存。保存真实主容器滚动事件，在同 scope 圈子数据就绪后的 layout effect 恢复；加载中不把临时 0 写回，账号/空间/epoch 切换重绑默认值。沿用 R3FIX 的 render 阶段恢复，避免 StrictMode effect 重放覆盖保存值。

**回归**：MyCirclesPage.interaction.isolated 新增 StrictMode 下 query+valid+scrollTop=180 的路由卸载/返回，以及相同 scope loading→ready 后恢复、账号/空间/epoch 三轴隔离。两个独立新断言修复前均为 180→0，修复后 180→180，原有搜索/筛选/账号隔离断言未修改。DOM 交互测试以编程设置 scrollTop 并派发 scroll 事件模拟滚动，未把它声称为原生滚轮验证。

### R4FIX 验证与边界

- 完整输出：`verify-r4.log`（既有 `*.log` 忽略，不入库），前 19 个独立测试进程合计 **453 pass / 0 fail**。同一轮另执行 `.pipeline/r4fix/current-paid-repro.test.ts`：0/1/4 条未来取消、pending + paid、已到期拒绝共五项通过，六条取消挤出 paid 的期望仍失败；原始 5 pass / 1 fail 输出一并保留。整体记录 **458 pass / 1 fail**，不把 R4FIX-02 遗漏成绿色结果。
- 所有测试路径均有 `./`，逐文件隔离进程，完整写文件并保留退出码。沿用第一轮隔离运行器：每个进程先核对临时 HOME 对应 `os.homedir()`，再执行用例，不读写用户 homedir。命令为 `python3 .pipeline/r4fix/run-tests.py verify-r4.log`，第 2 项缺口复现另用该运行器指定 `./.pipeline/r4fix/current-paid-repro.test.ts`，完整命令均记录于日志。
- `bun run typecheck:electron` 与 `bun run electron:build:renderer` 均退出 0。六个修改/新增 renderer 生产模块 lint 退出 0（0 error；HomePage 两条既有 hiddenVersion 依赖 warning 保留）。本轮不涉及 Main 业务修改，不重复扩大已在 R3 明确的范围外全量检查。
- 受控 Chromium 实际运行生产 ClientHomeRouter/MyCirclesPage/CircleDetailPage/CircleSubscriptionPanel 与真实 context，注入明确的圈子 fixture；1024×768 长列表设置真实 DOM scrollTop=180，点击详情→订阅→等待真实时钟到期→返回，测得 before=180 / after=180。详情页头“待恢复”、面板“已到期”，无绿色有效；更换 scope 后滚动为 0、搜索为空。页面异常 0。已打开检查到期后与列表返回截图，证据为 `.pipeline/r4fix/browser-result.json`、`browser-check.log` 和同目录四张 PNG。这是受控页面与时钟验证，不等于真实 Main/支付或正式三卡 Acceptance。
- R4FIX-02 缺口复现和对应实际 R4 DTO 仍未解决；已将权威来源、不可自洽原因、推荐字段与回归矩阵交给协调方参考。按 TASK-FIX-R4 的明确分工等待 Admin 契约，未擅自改 Admin 分支，也未修改当前未知 DTO 为成功。
- Task 与授权文件保持 untracked；临时脚本、截图及运行器只在忽略目录。本轮仅在当前 baseline 分支提交，不 push、不合并 dev、不改任务卡正文。


## R4FIX-02 Client 闭环（R4C）

### 权威来源与适用版本

执行 TASK-FIX-R4B-CLIENT.md；Client 基线 `74e2150959643e4f00dbee977e57c85d9f03112c`。本轮只读参考 Admin `fix/poo79-admin-session-20261019@d7f28c3f0823d921d2de4ed0161237d167a75f65`：

- `shared-contract.md` 的 **Member Circle current entitlement contract (v1, 2026-10-19)**，SHA-256 `54545d696bef1a4a2815161c9c849a658c37c5fd3cc220a46619c88fdee2257d`。
- `src/lib/creator-circles/current-entitlement.ts` 的实际投影，SHA-256 `8e397b32dee959026e461217267246763dff1139444c570bf6baa01cbe22d925`。当前权益独立于最近五单，纠正事务保留的资格由 state 表达；corrections 用于解释，不按“出现退款/争议”猜测资格。

此前 F1 JSON 是固定历史接口快照，不覆盖本次已交付的增量 v1。Client 的 `packages/shared/src/admin/member-circles.ts` 是解析/映射维护源；类型由同一 Zod schema 推导，现有 admin index 的 export* 自动传播，无需手工维护另一份类型或改写历史快照。未跨仓库修改/提交 Admin。

### 根因与改动

**根因**：旧 Client 会剥离未登记的 currentEntitlement，仍从最近五单寻找 paid。六条未来 cancelled 挤掉当前 paid 后误判为无权益；若只改为 active + 将来到期日放行，又会丢失退款/争议限制。

**共享解析**：新增可选的 MemberCircleCurrentEntitlement v1 schema 和映射，保留 version、membershipId、state、computedAt、currentPeriodEnd、validUntil、完整 source 与 corrections。校验 v1 版本/枚举/结构/日期和父 membership 的 ID、billingKind、period 绑定；未知版本、未知 state、半个对象、null 或错绑作为 invalid_response 拒绝，不剥掉字段再退回旧授权。来源与账本 ID 按契约作为 opaque string，不误加 UUID 约束；nullable 引用原样保留。字段整体缺省时仍省略该属性并走原有旧响应分支。

**统一投影**：isMembershipCurrentlyPaidEntitled 在存在 v1 时只接受 entitled，同时要求原始关系仍 active、父子绑定一致、本机时间未超过 paid currentPeriodEnd 或 validUntil。not_entitled/unknown 不回退至历史 paid；部分退款/拒付按 state 的实际剩余资格处理，不从金额或历史 effectivePaymentStatus 再猜资格。缺字段时保留全部原有保守行为和断言。Home、列表、页头、订阅与返回核验复用这一投影；Main/Catalog 的实际启动核验保持原路径。

**详情内容入口**：补全 CircleDetailPage 的 v1 来源失权集合，并交给既有完整目录投影；CircleContentPanel 对 v1 的 blocked 行显示禁用打开按钮。只有本圈来源时 unknown/not_entitled 拒绝；另有有效来源的共享作品仍可用。只对已携带新契约的成员启用此内容投影，旧响应保留既有 Catalog/失败提示行为，未改旧的“点击受限行给解释且不启动”断言。

**时钟上界**：useMemberCircleClock 除 paid 期限外也调度 v1 validUntil，包括免费关系的过渡上界。原始 state 仍 entitled 时，本机越过边界也立即拒绝，不等待新回执。R4FIX-01 的自然到期、旧 paid、退款/争议与未来续费断言全部保留。

### 回归与验证

维护用例集中在 `lib/__tests__/member-circle-current-entitlement.test.ts`，使用同一 wire fixture 经真实 shared parser 后判断。原 `.pipeline/r4fix/current-paid-repro.test.ts` 已改为引用这份维护用例，保留原 0/1/4/6 条取消、pending + paid、到期拒绝六个场景，没有把“六条取消应继续可用”改为拒绝断言。历史红色输出仍在 `.pipeline/r4fix/current-paid-gap.log`，不覆盖。

- 新维护套件 **25 pass / 0 fail**；原复现入口独立执行同一 25 项也全绿（最终 649 是测试进程输出之和，包含这次重复入口执行，不声称 649 个唯一场景）。另覆盖 v1 完整映射、opaque lineage、unsupported/malformed/mismatched 拒绝、unknown/not_entitled、两类纠正的保留/失权、free validUntil、旧响应兼容。
- 新增真实 Home 按钮三态、真实详情内容按钮三态及多来源保留、订阅三态与免费上界计时器交互。详情新断言修复前 not_entitled/unknown 按钮仍可点，修复后禁用；原有断言未降低。
- 新增真实 loopback HTTP → AdminClient → shared parser 的 v1 完整传递与错误版本拒绝，以及原生 LIST_MEMBERSHIPS handler 保留字段的回归。只修改测试，原生 handler 既有直接 DTO 传递即可，不新增通道或授权能力。
- **最终受影响套件：28 个独立测试进程，649 pass / 0 fail，全部退出 0**。完整命令、输出、退出码在根目录 `verify-r4c.log`（忽略、不入库）；可用 `python3 .pipeline/r4cfix/run-tests.py verify-r4c.log` 复跑。每个用例路径均有 `./`，逐进程先证明临时 HOME 的 os.homedir 隔离，再执行测试；不直接访问用户 homedir。
- `bun run typecheck:electron`、`cd packages/shared && bun run tsc --noEmit`、`cd packages/server-core && bun run tsc --noEmit` 全部退出 0。
- `bun run --cwd packages/shared build`、`bun run electron:build:main`、`bun run electron:build:renderer` 全部退出 0。Renderer 仍有原有大 chunk 提示，没有构建失败。
- 修改的五个 Electron 生产模块与 shared 解析模块定向 ESLint 均退出 0，0 error / 0 warning。
- 受控 Chromium 使用原始 v1 wire fixture → 真实 parser → Home/list/subscription 组件：五条 cancelled 的 entitled 显示可用；即使最近历史为 paid，not_entitled 和 unknown 仍禁用；本地 validUntil 越界后自动禁用；自动打开 0、页面异常 0。已实际打开检查 1440×900 的可用/拒绝截图。回执和截图位于 `.pipeline/r4cfix/browser-result.json`、`browser-check.log`、`home-entitled-1440.png`、`home-not_entitled-1440.png`。详情内容的单源/多源在真实 Router/provider 组件测试验证，不冒充额外浏览器或真实支付/Main 启动验收。

### 契约疑问与交付边界

无阻塞本轮的契约疑问；第二轮的 Admin DTO 需求已由 v1 交付满足。新的未知版本/状态会拒绝，缺字段的旧响应保持既有行为；currentEntitlement 只约束显示/入口资格，不能代替分发、治理、激活、Catalog/Main 和离线执行门禁。

本轮完成 Client 闭环与受控回归，未执行正式 POO-77/78/79 Acceptance、真实支付/短信或跨仓库部署。不重跑之前已证明为范围外的全仓失败，不把既有全量检查声明为绿色。TASK/授权文件保持 untracked，verify-r4c.log 与一次性脚本/截图不入库，仅当前 baseline 分支提交，不 push、不合并 dev、不改任务卡。

## R5FIX（第四轮：5 项恢复缺陷）

### 来源、范围与完成状态

执行 `TASK-FIX-R5.md`，修复基线为 Client `93811a92f23b630c02ee99105b9c36bcd94f9630`。依据 `.pipeline/poo77-79-r5-acceptance-20261019-083030/RESULT.md` 与其 owned runtime 下三卡 `product-findings.json` 的五项已确认缺陷；历史验收结论未改写。R5FIX-01～05 均已实现并有回归覆盖。

两项已上交的 authority_conflict **不在本轮裁决范围**：legacy/migration unknown 权益的 Catalog/Main 启动资格，以及企业 UI 下账号级 member RPC 的边界。未改 `currentEntitlement` 解析、权益判定、Catalog/resolve-launch 资格规则或成员 RPC 读取规则。第 04 项仅修复已授权空间的可信上下文恢复与执行停止事务。

### R5FIX-01：凭据删除失败传播与显式重试

- **根因**：`CredentialManager.delete()` 是 best-effort API，会吞掉后端写失败并返回 false；`endAdminSession` 忽略删除结果而提交成功。删除抛错后若保留 endingSession，第二次退出又会因无可捕获 session 而假报成功；并发第二次退出也存在相同误判。
- **改动**：仅 Admin token 的专用删除改为传播写失败，并用后端 discriminative presence inspection 从磁盘确认不存在；不可读/无法解密不再当作不存在。session CAS 内确认凭据消失后才提交，失败返回 `LOCAL_CREDENTIAL_DELETE_FAILED`。若通用 reset 已先删除 token，只有再次确认 absent 才作为幂等成功。失败释放本次 ending 标记并推进 generation，保留 epoch、Catalog 拒绝和 runtime 围栏；重试不删除后来登录账号。无 session 分支也核验实际 presence，拒绝在另一退出尚未完成时声称成功。
- **消费者**：登录取消错误经现有 onboarding error 状态显示；错误条提供再次退出按钮。App 的退出/reset 路径显示本地化可重试错误，只有成功回执才清除 renderer 身份。七个 locale 同步新增错误文案。
- **验证**：真实临时 HOME + 临时配置目录内写入加密凭据，目录 0500 后删除拒绝、文件字节不变、身份仍在；恢复 0700 后重试清除。损坏密文拒绝假报删除成功；native handler 覆盖 false 回执、再次退出、并发退出，以及既有晚到认证、账号替换 CAS、epoch 回归；真实 hook/登录组件覆盖错误和重试。早期失败输出在 `.pipeline/r5fix/red.log`、`red-final-boundaries.log`，修复后全部转绿。

### R5FIX-02：缓存首页的离线恢复入口

- **根因**：R3 已把保留缓存的失败正确投影成 offline，但 Home 只在 error/stale 分支提供重试，offline 横条没有恢复动作。
- **改动**：离线横条提供可见重试，调用现有 `catalog.sync(true)`；同步期间禁用重复点击。不启动、安装或重放 App 操作，不改变缓存授权边界。
- **验证**：真实 ProductSpace/MemberCatalog/Home 组件链在缓存离线时显式重试，清除横条并恢复在线；`start` 和 `openApp` 调用均为 0。R3 无缓存 error、R4 本地到期与滚动恢复回归继续通过。受控浏览器按离线→服务恢复→点击重试复核，截图 `offline-1440.png`。

### R5FIX-03：个人圈子撤权文案

- **根因**：个人与企业首页共用 `homeApps.errors.unavailable`，其内容硬编码“你的组织”。
- **改动**：七个 locale 的同一维护源改为中性授权/分发说明，中文为“此 App 的授权已结束或已停止分发。”；继续复用同一 key，不新增手工派生副本。不改撤权、禁用按钮、墓碑保留或恢复算法。
- **验证**：中文/英文文案回归；原有目录/多来源/禁用入口及 Main `product-space-catalog-authority` 全套通过，包括重复空目录仍保留墓碑。浏览器实际展示个人来源撤权卡片，截图 `withdrawn-1440.png` 已打开检查。

### R5FIX-04：403→200 的 Renderer/Main 上下文恢复

- **根因**：Catalog403 会正确撤销 Main 的 committed fence，但 renderer 保留解释用空间；之后 Catalog200 仅更新数据，不重提交可信空间。空间菜单先读 execution list，遇到缺少 committed context 就失败，renderer 因此仍停留在原企业空间。
- **改动**：Catalog 记录当前 scope 的撤销标记，成功在线回执必须等待 `onRecoverActiveProductSpace`。恢复重新读取空间列表，复用可信 PREPARE→STOP→COMMIT 后才发布；包括没有缓存的首次403。恢复 promise 按撤销实例共享，晚到回执通过 scope/generation/operation 比较丢弃。失败保持拒绝或进入已有安全错误页，提供 bootstrap 重试；契约不支持仍走 contract-blocked。Home 拒绝横条同样提供显式重试。
- **停止屏障**：Main 无 origin fence 时，PREPARE、STOP、finalize、COMMIT 对当前可信账号的残留执行执行完整停止与重新核验；其他账号不受影响。有 origin 时维持原空间范围、一次性 token、取消、generation 与最终提交门禁。未增改任何 App/圈子资格规则。
- **验证**：真实 hook 覆盖撤销后重提交→正常切换、STOP 失败禁止提交并可 bootstrap 恢复；真实 Catalog hook 覆盖等待恢复确认才从 denied 发布 online、无缓存403、失败后再次重试。原生 RPC/registry 覆盖无 fence 时残留执行实际停止、他账号保留、可信上下文可查询，以及全部既有并发/取消/替代执行门禁。浏览器 fixture 状态机复核403清空 Main 模拟上下文、200恢复后 STOP/COMMIT，再成功企业→个人切换。此浏览器部分不是实际 Electron Main/真实 Admin 验收。

### R5FIX-05：圈子 partial 页重试

- **根因**：`MyCirclesPage` 已有 `resource.refresh()`，error/offline/stale 分支可调用；partial 横条仅显示说明。
- **改动**：partial 横条暴露同一 refresh，刷新期间禁用重复点击；保留成功一侧的真实回执，不合成关系或权益，不自动加入、付款或执行。
- **验证**：分别覆盖 circles 失败/memberships 成功及反向分支。使用真实 MemberCircleResourceProvider，在同一次挂载里恢复服务→点击重试→partial 消失并恢复五行，无 renderer reload。浏览器检查可见按钮与单次 refresh，截图 `partial-1440.png`；登录错误重试截图 `logout-error-1440.png`。四张图均已实际打开。

### 完整验证与基线限制

- **相关测试：34 个独立进程，873 pass / 0 fail，全部退出 0**。包括 R3/R4/R4C 的 28 个原有进程以及 Admin token 删除、secure-storage write-lock、ProductSpace renderer hook、原生 ProductSpace RPC、Catalog authority 和 execution registry 六组。原 R4 复现入口仍导入维护用例，其 25 个测试重复执行计入上述运行数，未冒充额外唯一场景。
- 完整测试命令、未经截断的输出和退出码保留在根目录 `verify-r5.log`。复跑：`python3 .pipeline/r5fix/run-tests.py verify-r5.log`。每个测试命令带 `./`，每个进程执行前证明 `os.homedir() === 临时HOME` 且不是 `/Users/wow`；临时凭据目录仅在自身 sandbox 内，权限故障均在 finally 恢复。日志/一次性运行器位于忽略范围，不入库。
- Electron、shared、server-core 类型检查通过；shared 权威构建方式、Electron main 与 renderer 构建通过。新增翻译调用点 coverage 通过。Renderer 的大 chunk 提示为既有构建提示。
- 受控 Chromium 5 个恢复场景通过、页面异常 0、自动 App 打开 0，`.pipeline/r5fix/browser-result.json` 明确 fixture 边界。没有把 controlled 浏览器、原生 handler 测试或文件系统故障测试声明为真实支付、真实 Admin 数据库、正式跨卡 Acceptance。
- **范围外基线问题**：相对 `93811a92`，i18n parity 前后均为五个非中英 locale 缺相同 16 个既有 `productSpaceSkills.*` key；sorted 前后均仅 en/zh-Hans 的相同既有乱序。本轮新 key 在七个 locale 位置正确且齐全；没有补范围外翻译。App/AdminLoginStep 全文件 lint 前后均为 2 个既有 no-shadow 错误，warnings 从 18 降到 17；其余修改的六个 renderer 模块定向 lint 为 0 error / 6 个既有 warning，凭据模块 lint 为 0 error。精确输出及比较在 `.pipeline/r5fix/baseline-comparison.json` 与 baseline/current 日志；不把这些额外全文件门禁报告为绿色。此前 R3 已隔离的全仓失败未重复修复。
- 红测试先提交（`5d334fbf`、`a19a1083`、`f70b6a6a`）；类型 fixture 的补全没有降低断言。只在当前分支提交；TASK/授权保持 untracked，未 push、未合并 dev、未修改任务卡或旧验收记录。

## R5FIX-A1A2(Client)

### 裁决、权威来源与范围

本轮执行 `TASK-FIX-R5A.md`，基线 `9198d0b6b64e8422993095d254e8b638c0822530`。用户于 2026-10-20 将两项 authority_conflict 均裁决为方案 A：产品未上线、没有需要兼容的 paid legacy 存量；Main 仅接受 entitled paid 来源；企业空间隔离成员 RPC。此前 R5 的“禁止改变资格规则”是该轮历史边界，本轮按新裁决实施。

Admin 同步交付的只读参考为 `fix/poo79-admin-session-20261019@eb8be26b06fb4adf343454d0e5d922c47cbf56a5`：

- `shared-contract.md` **v1.3 / rules revised 2026-10-20**，SHA-256 `5ad9fb22b27b73cd0e06cf3716c2396d8d81a99493cac3ae624d830006db6bbb`。契约规则修订，currentEntitlement 对象仍为 version 1。
- `src/lib/creator-circles/current-entitlement.ts` SHA-256 `8a1b2b706b6a7d5e3efdae83e397970dba51fd77aad97d75438a993032d644e8`。期间先观察到 Admin WIP，交付前已核对该提交中的同一来源与哈希；未修改 Admin。精确读取绑定和只读快照在 `.pipeline/r5afix/admin-contract-binding.json`。

### A1：Main paid 来源执行准入

**根因**：安装、START 和 direct resolve-launch 重新读取 Catalog/resolve，却没有独立消费成员 currentEntitlement。旧 Admin 规则下，paid unknown 可出现在 available Catalog，导致展示为“待恢复”而 Main 仍启动。旧 scope-only 生命周期和缓存远程 URL 入口也不能作为 ProductSpace artifact 的旁路。

**改动**：

- 新增 shared 权威判定 `admin/member-circle-admission.ts`。将 renderer 已有的 v1 绑定、active 状态、period end 与 validUntil 判定下移复用，展示分支语义不变。Main 的 paid 来源必须提供 v1 entitled，缺失/unknown/not_entitled 一律拒绝；不从最近 paymentOrders、未来期限或 legacy/migration 状态推导放行。免费来源保留契约既有语义。
- Main 使用自身认证 AdminClient 读取成员投影，只匹配本次新鲜 Catalog entry 的 circle 来源。逐来源形成并集，例如同作品 A 来源 unknown、B 来源 entitled，可由 B 放行；其他作品的 entitled 圈子不能授权本作品。
- `installProductSpaceBundle`、完整 identity 的 `localApps.start`/restart、trusted direct resolve-launch 共用此边界。拒绝发生在安装/能力签发/进程启动之前；安装下载和运行时的异步边界继续检查本地期限。START 在 gateway 等待、spawn 签名、health 返回及运行状态发布前重新核验，失败复用既有精确 generation 回滚。
- 已带 artifactInstanceId 的 ProductSpace App 禁止进入旧 scope-only START 或缓存 URL resolver，必须走新鲜准入；不改变普通旧命名空间管理/清理接口。
- 新错误码 `CIRCLE_ENTITLEMENT_REQUIRED` 带 `reason`（unknown/not_entitled/expired）与 `recovery=refresh_membership`。错误文案提供刷新成员关系、续订/恢复后重试的指引；Main 早期进程也通过已有 locale registry 得到完整文本，renderer 经既有 Home error formatter 展示，七 locale 均有维护源。单作品资格拒绝不撤销整个 ProductSpace。

**验证**：真实 Main handler 回归覆盖 unknown/not_entitled/缺投影/过期的 install 与 START，均无安装/能力/进程副作用；entitled 正常安装/启动、多来源保留、旧 URL/请求形状拒绝；gateway 等待期间实际跨过 validUntil 后拒绝且零 spawn。原生 direct-open 在未知来源时不发 resolve 请求、不回传 launch token，并保留空间。共享判定覆盖 0/1/4/6 次未来取消、paid-looking 历史不能掩盖拒绝、全退/争议拒绝与部分纠正 retained 权益、错误来源匹配、时间上界，以及真实 loopback HTTP → AdminClient/parser → 准入的 unknown→entitled 恢复。

### A2：成员 RPC 的 committed 个人空间边界

**根因**：原 RPC 由可信账号派生主体，并在回执前核对账号/围栏 generation，但没有校验当前 committed ProductSpace 的 kind，因此企业 UI 隐藏入口后仍可直接调用本人个人关系通道。

**改动**：Main 从已验证列表的 COMMIT/离线可信恢复一并提交空间 kind，revoke 清除；没有 renderer 可设置 kind 的通道。九个 `memberCircles.*` 入口（包括静态 G2/G3 能力状态）都要求当前账号绑定的 committed 个人空间。企业返回 `personal_space_required` + `switch_to_personal_space`，缺失/无法验证绑定返回 `product_space_context_required`，不调用成员服务、不含列表或详情数据。保留原账号及 generation 围栏，并显式捕获 transition epoch 和空间 ID；即使账号切换事务随后 abort，旧调用仍失效。企业 UI 行为不变。

**验证**：九通道逐项检查企业拒绝、零 provider 调用、无数据字段；个人正常读取与既有 token CAS/账号替换/空间离开回归通过；缺少 context、他账号绑定拒绝；abort 后旧异步回执为 session_changed；真实 PREPARE→STOP→COMMIT 从可信列表提交 personal kind，renderer 伪造额外 kind 参数无效，revoke 后清空。

### 完整验证、基线与交付

- **受影响回归 40 个独立进程，1047 pass / 0 fail，全部退出 0**。保留 R5 的 34 个进程，加入 Main 生命周期、严格权益、七 locale 错误消费、ProductSpace 契约、trusted launch bridge 和 handoff 六组；R4 原复现别名的 25 个重复执行仍计入运行数，不宣称为额外唯一场景。R4 到期、currentEntitlement 六类取消复现及 R5 五项均继续通过。
- 完整输出、命令、退出码为根目录 `verify-r5a.log`（忽略、不入库）；复跑 `python3 .pipeline/r5afix/run-tests.py verify-r5a.log`。每个 Bun 文件路径以 `./` 开始，各 isolated 文件单独进程；每个进程先证明临时 HOME/homedir 与配置目录隔离。HTTP fixture 自身 finally 关闭服务。
- Electron/shared/server-core 类型检查、shared 权威构建、Electron Main/Renderer 构建均通过；修改的 Main 文件、renderer 两个 adapter、shared 准入模块定向 lint 为 0 error / 0 warning；i18n 调用覆盖检查通过。Renderer 大 chunk 提示为既有构建提示。
- **额外范围外基线探针**：`admin-local-app-session-ending.isolated.ts` 原始版本在本轮与独立 `9198d0b6` 源码快照中均因 mock 缺少 NativeInstallationReportSchema 无法加载。临时补齐其契约/config/SDK/presence 夹具后，前后均为相同 17 pass / 7 fail，失败名逐项一致。未修改这些既有业务断言，也未保留探针夹具改动或纳入上述绿色 40 组；原始文件保持不变。基线命令/输出与差异在 `.pipeline/r5afix/baseline-integration-*.log`、`integration-fixture.log`、`baseline-integration-comparison.json`；独立临时源码快照已清理。没有把全仓测试或该额外套件报告为绿色。
- 此交付是 Client 实现与隔离回归，不替代真实支付/生产数据或正式 Acceptance。R6 在独立副本以旧 HEAD 运行，本轮未读取/修改 `.pipeline/poo77-79-r6-*` run_root、未操作其进程/资源；没有用它的结果为新提交背书。
- 红测试提交 `97a7b50c`、`6b68392b`、`05194a97`；测试类型/fixture 补全不降低断言。只提交当前主 worktree 分支，不 push、不合并 dev；TASK/授权文件保持 untracked，运行器、契约读取快照和探针均保留在自有忽略目录。
