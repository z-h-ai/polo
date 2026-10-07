---
name: polo-ai-design-system
description: Apply the polo-ai repository design system within its declared platform, module, and path scope. Use only after verifying the bound sources remain current.
---

# polo-ai Design System

Adoption revision: `poo70-client-design-r2-20261004`. Mode: `extracted`.

## Applicability

- Repository: `polo-ai`
- Paths: `apps/electron/src/renderer`, `apps/electron/src/main`, `apps/electron/src/preload`, `docs/mvp-complete-flow-hifi`, `.agents/skills/polo-ai-design-system`
- Platforms: desktop-electron
- Modules: 登录与自动注册、外层顶栏、首页应用目录、我的圈子及圈子详情；main/preload仅对应受信交接，不定义业务页视觉

If repository identity or path scope does not match, do not apply this Skill. Read [the bound design model](references/design-system.json) and verify its sources before high-fidelity work.

## Sources

- `docs/client-journey-review/spec.md` — authority; 当前产品唯一来源 master-r15-closure；§13.8—13.13 覆盖旧设计指令; SHA-256 `44b0f01e3b710204266a85922b6615d15a4e2f233dfac921f4709fbf25c6fae6`
- `.agents/skills/polo-ai-design-system/references/foundations.md` — authority; 本次原型提取与消费边界；明确确认/实现事实/待复看范围; SHA-256 `1b6e8a4c4fed83dd0451709f2ccb1e24c47e5cefb7fb9ae8d38b2184dfe43d9d`
- `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css` — authority; b82fa1e5 基础样式，按最新原型逐字节提取；当前外层工作台样式维护源; SHA-256 `fe5bfc320c7345ee5f22c400c51dd9f69049b6a9090b286ee31de5f7b244a20a`
- `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css` — authority; 导航/Header、首页和统一圈子列表已明确增量；按最终CSS cascade消费; SHA-256 `75e75333fb309f5ffb3262082dbddbffd3ee7e6a08f4503b1f3a22dbf120f591`
- `apps/electron/src/renderer/index.css` — implementation; 本轮工作树Renderer样式事实；不是发布版或新的产品设计授权; SHA-256 `91fb77782a6d5dadb2cff70f05a88fa2ec67672e50dc2362020aa5b393d13449`
- `docs/mvp-complete-flow-hifi/sources/g4-product.css` — implementation; POO-41 ef3528ef 历史冻结样式；不覆盖当前Spec; SHA-256 `fe62101ae60d6a11021f98af04e20b1eba97920eb41d7f49d4f9751dd6bb0218`
- `docs/mvp-complete-flow-hifi/sources/g4-review-record.md` — implementation; 2026-08-11 历史冻结范围记录，非当前全页Acceptance; SHA-256 `56fdd07ddaf3f5525736b124cac3cdc14ecb6953703283f0a09730effdbd7843`
- `docs/mvp-complete-flow-hifi/sources/renderer-index.css` — implementation; 01f4447c固定Renderer快照，只作历史比较; SHA-256 `964e3744691aeea9aa3f94f5084c4405a97ac046a0e8f348b13241fe4c2bbfaf`
- `.agents/skills/polo-ai-design-system/assets/components/workbench-header-scroll.js` — implementation; 原型共享行为脚本；生产须接真实状态/服务，不移植模拟结果; SHA-256 `56eb0f05806951543eaaf4c0033c7fcc08eae3336ca6010794776f6ca97ab409`
- `.agents/skills/polo-ai-design-system/assets/components/space-switch-sequence.js` — implementation; 原型共享行为脚本；生产须接真实状态/服务，不移植模拟结果; SHA-256 `a5de1ede777f48032a3d945983bd987c28e42a6cd1f2efd5852e1f8c35a7ab73`
- `.agents/skills/polo-ai-design-system/assets/components/space-switch-progress.js` — implementation; 原型共享行为脚本；生产须接真实状态/服务，不移植模拟结果; SHA-256 `dda528141636c0253fe70afaeeb23a9919aa8264e562d63235c77316a6248de7`
- `.agents/skills/polo-ai-design-system/assets/components/circle-membership-feedback.js` — implementation; 原型共享行为脚本；生产须接真实状态/服务，不移植模拟结果; SHA-256 `b26fcc98fb62dc2d9ee91ddbed21a5bd83a23f830b9acea9028a40f747934808`

## Reuse

- Token family `颜色与语义派生色（完整CSS color）` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`; use its actual values rather than duplicating them here.
- Token family `系统字体栈与字号/字重/行高` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`; use its actual values rather than duplicating them here.
- Token family `圆角/阴影/层级` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`; use its actual values rather than duplicating them here.
- Token family `工作区尺寸/间距/密度/桌面断点` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`; use its actual values rather than duplicating them here.
- Token family `当前导航与首页/圈子增量样式` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css`; use its actual values rather than duplicating them here.
- `登录表单` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`: 密码/验证码切换及手机号自动注册，复用真实认证；不新增独立注册页
- `工作台顶栏` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css`: 顶部首页与已打开App标签，账号菜单切换空间，主体滚离顶部才出现边线；无第二排资源Tab
- `工作区布局` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`: 读取最大宽度/内边距及断点；工作区纵向滚动，主内容不出现非预期横向溢出
- `应用卡` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`: 首页/圈子复用同一结构，创作者来源保留，省略常驻状态与来源数量；稳定作品ID去重
- `首页目录` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css`: 标题我的应用，完整目录搜索/排序及空失败态，个人圈子普通入口；助手仅保留已有打开动作
- `圈子统一列表` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css`: 免费/月度/年度统一头像/身份/摘要/权益/详情入口；不增加桌面分享链接输入
- `圈子详情分区` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css`: 内容/更新/订阅；退出仅订阅区，价格周期有效期各一次；技能本批只读
- `确认对话框` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`: 明确原对象的确认/取消及失败恢复；用edge圆角/panel阴影，不以模拟按钮选择业务结果
- `系统态与恢复` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`: 准备/加载/错误/离线/失权/主动重试，各自保留真实事实和最小恢复操作
- `浏览器交接` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`: 只承接原对象并主动核对，不复制网页支付/管理，不自动重复业务写

## Themes and viewports

- Themes: light
- `desktop-1440x900`: 1440 x 900
- `desktop-1024x768`: 1024 x 768
- `desktop-800x600`: 800 x 600

## Interaction states

- loading/preparing/submitting, empty/search-no-results, hover/focus-visible/disabled, error/retry/offline, expired/revoked/multi-source fallback, success/cancel/interruption, return to original circle/order with manual recheck

## Prototype guidance

- 先读 references/foundations.md，产品行为读Spec；UI消费最新 docs/mvp-complete-flow-hifi/prototype.html 与主manifest，逐卡按scene定位。
- 最新原型是目标呈现；已确认风格/入口/文案与待复看整页布局分别记录。
- 仅维护Skill模板与样式；文档原型、消费manifest与兼容adoption是生成产物，不独立手改。
- 管理技能页面和Polo助手内部代码暂缓；真实助手UI继续复用Renderer，转译示意不能成为重写标准。
- 仅产品页面可进入客户端；review-shell按钮、模拟结果、虚构账号金额订单及第三方应用内部内容不进入生产。
- 未建立完整政策注册或生产parity绑定；来源/结构检查不证明execution_ready或业务验收。

## Checks

- `python3 docs/mvp-complete-flow-hifi/tools/check_design_system.py`
- `python3 docs/mvp-complete-flow-hifi/tools/build_review.py`
- `POLO_REVIEW_EVIDENCE=/tmp/poo70-design-structure python3 docs/mvp-complete-flow-hifi/tools/validate_unified.py`

## Decisions

- `D-CURRENT-STYLE` confirmed: Spec §13.10：b82fa1e5配色/风格替代初始r15灰黑方案；当前第一段CSS与该版本一致 (source `docs/client-journey-review/spec.md`)
- `D-NAV-HEADER` confirmed: Spec §13.9：去第二排资源Tab，圈子个人首页入口，管理技能在助手卡内，Header仅主体滚动后显示细线 (source `docs/client-journey-review/spec.md`)
- `D-HOME-CIRCLE` confirmed: Spec §13.11—13.13：我的应用标题、共享应用卡、圈子统一列表与详情文案去重、退出仅订阅区 (source `docs/client-journey-review/spec.md`)
- `D-ASSISTANT-REUSE` confirmed: Spec §13.11：真实助手UI复用当前Renderer；本批暂缓技能管理及助手内部应用代码 (source `.agents/skills/polo-ai-design-system/references/foundations.md`)
- `D-PAGE-VISUAL` suggested: 整页布局待复看；当前提取只是目标实现事实；集中visual smoke不升级parity (source `.agents/skills/polo-ai-design-system/references/foundations.md`)

When a bound source changes, locate affected rules and pages before refreshing this Skill. Preserve confirmations whose source and scope did not change.


## Design coverage

- color: explicit — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 已确认b82fa1e5色彩与当前增量cascade；使用实际CSS颜色
- typography: explicit — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 源CSS定义字体/字号/行高阶梯；不能套全局新字体覆盖助手
- layout: derived — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 原型提取几何为目标实现事实，具体新组合布局待复看
- size: derived — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 控件/头像/工作区实际尺寸来自源CSS和最终cascade
- spacing: derived — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 组件内外间距读取源CSS/断点，不建立第二份数值表
- radius: explicit — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 源CSS radius与组件例外分别使用
- density: derived — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 目录/卡片/统一圈子列表沿实际CSS；不恢复紧凑灰黑方案
- states: explicit — .agents/skills/polo-ai-design-system/references/foundations.md; loading/empty/error/recovery/focus/disabled与恢复合同明确
- responsive: derived — .agents/skills/polo-ai-design-system/references/foundations.md; 1440×900及1024×768目标，800×600额外回归；媒体查询按最终规则

## Asset ownership and component lifecycle

Maintain current assets in this Skill under assets/; do not create a second project design directory.
Migrate the editable prototype source and update consumers; retain only version-labelled historical evidence.
Production components stay in their owning code modules. Reference them rather than copying their implementation.
Read component contracts and consumers before reuse. Business behavior follows current business authority.
Generated wrappers never delete or overwrite assets. Readiness and hashes are not visual acceptance.

- 登录表单: business, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.
- 工作台顶栏: business, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.
- 工作区布局: foundation, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.
- 应用卡: business, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.
- 首页目录: business, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.
- 圈子统一列表: business, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.
- 圈子详情分区: business, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.
- 确认对话框: foundation, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.
- 系统态与恢复: foundation, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.
- 浏览器交接: business, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.

## Task-scoped scene source

For a selected consumer manifest and scene ID, inspect the manifest first. If it declares `react_source`, run `product-ui-prototype/scripts/react_source.py <bundle> --scenes <IDs>` from the pinned framework checkout. Read the returned native JSX/TSX/CSS files, state/data, global entries, tokens, package and config once per task; follow additional imports when needed.
Prototype components are design references. Production components stay in their owning `src` modules; read their bound source paths and current contracts instead of copying prototype implementations.
HTML-only consumers keep their scoped scene reader when present. The offline `review.html` and `prototype.html` export remains bound to the authored source.
