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
