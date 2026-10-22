# Polo 客户端设计来源与消费规则

版本：`poo105-client-material-r2-20261021`（承 `poo105-client-material-r1-20261019`，承 `poo70-client-design-r2-20261004`）。适用 Polo Electron 外层工作台、登录、首页、圈子列表与详情；不适用于 Admin、创作者网页或第三方应用内部。r2 仅扩充消费素材与入口（token 预览、组件索引、页面基线索引、使用手册），不改变 r1 已确认的设计合同。

## 来源及优先级

产品需求唯一来源为 `docs/client-journey-review/spec.md`，当前 master-r15-closure，尤其 §13.8—13.13。本次用户要求按当前 `docs/mvp-complete-flow-hifi/prototype.html` 更新客户端 Design System 及相关任务的引用；这授权来源更新，不代表新增页面视觉验收或启动开发。

提取输入是 `poo70-workbench-r15-closure` 原型，更新前 HTML SHA256 为 `13911b0b01d394fae7468ee01264d86c677f43b697a8a0b8c8ee82afc1f5b4c4`。输入的第一段 CSS 与 `b82fa1e5` 的第一段 CSS 逐字节一致（原始 CSS SHA256 `81a832802625fb2b618bace6c7efb6fa5e31c74c3802c64d8014cdbc44895a12`），现提升为本 Skill 的 `assets/tokens/workbench-base.css`，仅清理原有行尾空白；该文件是维护源，HTML 内样式是生成输出。`assets/tokens/workbench-review.css` 是后续已明确导航、首页及圈子增量的维护源。按基础样式、增量样式的顺序合成，最终 CSS cascade 决定实际样式，不能只摘一个 token 推定组件外观。

G4 `sources/g4-product.css`、`sources/g4-review-record.md`、固定 Renderer `sources/renderer-index.css` 和 `docs/DESIGN.md` 保留为各自历史版本证据。G4 曾冻结的组件及状态只能在未被当前 Spec 替代的范围继承；旧的顶栏空间下拉、常用配置上限、资源第二排 Tab、助手三栏示意不能覆盖当前规则。`docs/DESIGN.md` 的另一套主色不能作为本批视觉来源。

已确认：b82fa1e5 风格、§13.9—13.13 明确入口/行为/文案。新组合页面的具体布局仍待复看；提取尺寸和断点是当前目标实现事实，不能据此声称整页已验收。light 是本批目标；dark 令牌存在但本批未验收，不自行扩成深色重建。

## 令牌与几何

实际值读取 `assets/tokens/workbench-base.css` 和 `assets/tokens/workbench-review.css`，不维护第二套独立数值表。当前 light 画布 #fbfbfa、表面 #ffffff、前景 #17181a、强调 #6e56cf；info/success/destructive 使用相应语义色及 soft 派生色。颜色是完整 CSS color，不能包入 `hsl(var(...))`。生产令牌名称不同可由实施卡提供有验证的映射，不能全局覆盖助手原有令牌。

字体沿基础 CSS 的系统字体栈与字号/字重阶梯；字号、行高、间距、圆角、阴影均按实际选择器和断点读取。不要用统一无阴影、灰蓝画布、黑按钮替换现有风格。基础卡片 20px 圆角、最小阴影；dialog 使用 edge 圆角和 panel 阴影；控件、头像、状态标签各用自己的尺寸和圆角，不把卡片参数套到全部组件。

桌面验证视口为 1440×900、1024×768；800×600 是原型声明的额外窄窗回归，未扩大本批 YAML 验收范围。CSS 在 1080/760 及增量 1050/850 等断点适配，读取最终生效规则，不把媒体查询前的桌面值当窄窗值。主要工作区自行纵向滚动，不允许非预期横向溢出、截断操作或让嵌套滚动触发顶栏边线。

## 微透材质合同（POO-105，用户 2026-10-19 接受 explore-r5 A）

默认浅色增加「微透材质」层，权威确认摘录在 `references/poo105-confirmation.md`，固定参考快照在 `assets/prototypes/poo105-materials/approved-r5.html`（绑定见同目录 `source-binding.json`）。合同要点：

- 作用域：`data-client-material="light"` 标记 + 默认浅色主题同时成立才生效——视觉暗色判定用 `isDark`（覆盖系统深色、Scenic 壁纸与深色专属自定义主题），存在自定义主题文件（`presetTheme`）时不投放；第三方 App 内部不套用。缺标记时全部回落既有不透明样式。
- 表面：底板 canvas = 背景 93% 不透明度；列表面 list = 表面 94%；阅读面 reading = 表面 99%；卡片/表单 card = 表面 98%；登录品牌面 brand = 近背景 94%（#f7f7f8 系）。blur 统一 24px。令牌名 `--client-material-*`：需要透明度的表面从材质专用字面锚点（`--client-material-base-background` #fbfbfa、`--client-material-base-accent` #6e56cf）`color-mix` 派生，保证在原型与 Renderer 宿主求值一致；前景/禁用族直接取下方合同字面色，不维护第二套色表。
- 前景：透明度只作用于背景色。文字、图标、头像、输入内容、placeholder 一律实色——主前景 `--foreground`；次级操作 #45474f 系（`--client-material-fg-secondary`）；次级文本 #60636a 系；placeholder #676a73 系且 `opacity:1`。
- 选中：导航/标签选中用强调色 9% 背景（rgba(110,86,207,.09)）＋ #392d65 文字。
- 真禁用：实色灰 #e2e4e8 底 / #747983 字（`--client-material-disabled-bg/fg`），`opacity:1`；禁止用整容器 opacity 淡化表达禁用。此条只约束「视觉禁用态」的画法，不把占位按钮 `opacity:1` 泛化成全局样式。
- Header：材质作用域内 Header 与底板同层同色——bar 背景透明让唯一画布板透出，不画第二块色板（两层半透会叠出接近不透明的「假白」）；任何滚动状态都不出现分层背景与细线（见下方顶栏合同的裁决）。Renderer 顶栏为 fixed、悬浮于画布之上（内容区以 padding 让位，不与 bar 重叠），`blur(24px)` 为将来内容穿越预留可读性、不构成第二色板；原型布局 bar 无 blur。

## 页面与组件合同

- 登录：`auth-root`、`login-split`、`login-panel`、既有表单控件及按钮。密码/验证码可切换；手机号首次验码自动注册，不新增独立注册页。发送中、倒计时、输入错误、提交失败、取消及我的空间准备/重试保留明确反馈，沿真实认证实现接线。
- 顶栏：`workbench-bar`、首页与已打开 App 标签、运行状态、当前空间静态标识、通知及账号菜单。切换空间从账号菜单进入，顶栏没有独立空间切换下拉；不增加「应用/技能/圈子」第二排 Tab。主体在顶部时无边线，主体滚离顶部显示细线，返回顶部隐藏——POO-105 材质作用域内被 §微透材质合同 覆盖：Header 与底板同层，任何滚动状态都不显示细线；滚动线规则只对非材质作用域（深色/未标记宿主）保留。内部聊天/列表滚动不能误触。
- 首页：标题「我的应用」；完整应用目录、搜索、排序、零记录、真空目录、失败与离线缓存各有真实状态。圈子是个人首页普通入口，企业首页不出现个人圈子。助手卡保留既有打开动作；管理技能入口的位置遵守 Spec，但本批不实施目标页。
- 应用卡：首页与圈子共用 `product-card`、`app-art`、标题、创作者来源、打开动作及间距。不显示常驻左下角「可使用/有更新/两个有效来源」；标题下创作者信息用于辨识，详情才展开全部来源。按稳定作品 ID 去重，不按名称合并。失权原因由动作/详情说明；此样式合同不改变 Runtime、安装、打开或授权数据合同。
- 圈子列表：一组「我的圈子」＋「查看圈子内容，管理订阅」，随后搜索、筛选及统一 `circle-card` 列表。固定头像、名称/创作者、摘要、权益/有效期，右侧「查看详情」。免费/月度/年度用轻量权益文字区分，不另造年度大卡；不能虚构创作者/内容字段。桌面列表及空态不新增粘贴分享链接入口。
- 圈子详情：保留原圈子身份与内容/更新/订阅三个分区；内容标题仅「应用」「技能」，应用卡复用首页；技能在本批只读，禁止实现管理/启用/安装。退出只放订阅区域。价格、周期、有效期分别只出现一次；已购下一年度、提前续费、退出一个来源仍有其他来源可用的事实按真实数据处理。
- 对话框与系统态：`dialog`、`dialog-row`、`progress-track`、`system-state-card`、`state-facts`。确认、取消、错误、查询中与重试是独立状态；失败不改写已知成功事实。页面/按钮状态不以纯颜色传递；错误文本与恢复动作保留。
- 浏览器交接：`flow-state-page` 只表达系统浏览器交接，不复制支付/创作者后台。返回圈子/订单后由用户主动核对，不自动重复支付、加入或恢复任务；真实网页由 POL-114，身份 POL-112，独立联调 POL-174 承担。
- 助手：既有聊天、输入、附件及会话导航以当前 `apps/electron/src/renderer/` 为准，原型转译助手只作行为衔接。暂缓管理技能页面与打开助手后的 Polo 助手内部代码，不能从历史 `assistant-shell` 派生重写。第三方 App 内部仍归其自己的应用实现。

## 状态与可访问性

覆盖 loading/preparing、empty、hover、focus-visible、disabled/submitting、error/retry、offline、expired、success、cancel/interruption 及返回原对象恢复。复用语义色；焦点按增量 CSS 使用强调色外框，禁用状态同时禁止动作。标题/label/按钮文字表达可操作对象；保留 prefers-reduced-motion；不添加仅用于挑选成功/失败的产品按钮。POO-105 材质作用域内禁用视觉按 §微透材质合同 改为实色灰表达，替代增量 CSS 的 `button:disabled{opacity:.5}` 画法；焦点外框、reduced-motion 与禁止动作不变。

## 维护与检查

仅维护 canonical `references/design-system.json`、本说明、令牌、组件脚本、`references/client-workbench.template.html`，以及 r2 新增的消费入口文档：`references/usage-playbook.md`（实施流程手册）、`references/page-baselines.md`（页面/区域基线索引）、`references/component-usage.md`（组件索引，与 renderer playground `registry/settings.tsx` 注册联动校验）。`assets/tokens/token-preview.html` 是生成产物，唯一维护源是 `tools/build-token-preview.py`（从两份权威 token CSS 确定性再生，输入不变则逐字节不变）；不得手改预览页。原型正文的维护位置提升到本 Skill，文档路径 `docs/mvp-complete-flow-hifi/prototype.html` 继续作为兼容产品出口；不维护两份产品源码。`tools/build_review.py` 生成该出口、review 壳、主 manifest、Skill 所有的消费 manifest，以及兼容 adoption 模型。消费 manifest 只索引本批相关场景并指向同一产品出口，不复制原型或需求。

修改后重新生成 Skill、运行 build_review.py、重新生成 token-preview、检查 source hashes/SKILL.md 正文绑定/模板合成/token-preview 再生一致和 validate_unified.py。派生模型、HTML、manifest、任务正文/index 都须同轮更新。历史 evidence 绑定旧版本，不回写；最新生成检查不替代历史视觉 Review，也不证明真实 Electron/API/支付/安装验收。

本轮没有建立完整 `.agents/policy-readiness.json`/政策确认注册，也没有锁定生产 runtime 或 parity receipt。V2 模型完整性不等于 execution_ready；POO-80 开工前仍须核对实际 worktree 继承及政策准备，锁定最新 Plan/来源。任务验收保持原 YAML：实现卡 milestone，集中节点 visual smoke；此次来源更新不升级成逐卡 E2E 或 parity。
