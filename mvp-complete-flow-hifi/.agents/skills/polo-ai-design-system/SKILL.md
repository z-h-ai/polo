---
name: polo-ai-design-system
description: Apply the polo-ai repository design system within its declared platform, module, and path scope. Use only after verifying the bound sources remain current.
---

# polo-ai Design System

Adoption revision: `poo71-adopt-1（2026-09-16，随 POO-71 高保真重建建立）`. Mode: `extracted`.

## Applicability

- Repository: `polo-ai`
- Paths: `apps/electron/src/renderer`, `design-demos/polo-client-g4-ui`, `docs/mvp-complete-flow-hifi`
- Platforms: desktop-electron
- Modules: Polo 桌面客户端工作台（首页 / 全部 Apps / 助手 / App 容器 / 圈子 / 设置 / 登录与系统态）

If repository identity or path scope does not match, do not apply this Skill. Read [the bound design model](references/design-system.json) and verify its sources before high-fidelity work.

## Sources

- `docs/mvp-complete-flow-hifi/sources/g4-product.css` — authority; Polo 客户端 UI v1 冻结稿全部视觉令牌与组件样式（POO-41 artifactCommit ef3528ef，2026-08-11 产品确认冻结）; SHA-256 `fe62101ae60d6a11021f98af04e20b1eba97920eb41d7f49d4f9751dd6bb0218`
- `docs/mvp-complete-flow-hifi/sources/g4-review-record.md` — authority; UI v1 冻结范围（PC-F01—F11 整端）、验收结论与「修改需新 artifact commit」约束; SHA-256 `56fdd07ddaf3f5525736b124cac3cdc14ecb6953703283f0a09730effdbd7843`
- `docs/DESIGN.md` — implementation; 现行 Electron 渲染层设计语言文档（oklch 体系）；历史基线，与 G4 冻结令牌不一致时以冻结稿为准; SHA-256 `214e90085d7d1f9dfb9cc45a81de182a92bbb85523d4d726929419844b21efdf`
- `apps/electron/src/renderer/index.css` — implementation; 当前发布客户端真实样式令牌；「当前已有」视觉证据来源（dev 01f4447c）; SHA-256 `964e3744691aeea9aa3f94f5084c4405a97ac046a0e8f348b13241fe4c2bbfaf`

## Reuse

- Token family `色彩（background/foreground 派生 + accent/info/success/destructive）` comes from `docs/mvp-complete-flow-hifi/sources/g4-product.css`; use its actual values rather than duplicating them here.
- Token family `字体与字号阶梯（system-ui 栈 + 等宽）` comes from `docs/mvp-complete-flow-hifi/sources/g4-product.css`; use its actual values rather than duplicating them here.
- Token family `圆角、阴影、层级（radius/shadow/elevation）` comes from `docs/mvp-complete-flow-hifi/sources/g4-product.css`; use its actual values rather than duplicating them here.
- Token family `深色令牌（[data-theme=dark]，本阶段未做视觉验收）` comes from `docs/mvp-complete-flow-hifi/sources/g4-product.css`; use its actual values rather than duplicating them here.
- `workbench-bar（顶栏：品牌、标签、运行状态、空间切换器、通知、账号）` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: 桌面窗口结构直接复用；空间切换器 popover 与运行 pill 是 M02/M04 的唯一入口
- `app-shell + workspace-main（主内容工作区）` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: App 打开后占满主内容工作区（D-PC-05），容器外不得加 App 内部 chrome
- `product-card / card-grid / app-art（App 卡与常用区）` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: 首页常用 Apps 与全部 Apps 分组共用；来源行 source-line 必须保留
- `assistant-shell 三栏（侧栏 / 会话导航 / 主面板）+ chat-composer` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: 助手、Skills、会话文件、数据源共用三栏骨架（D-PC-06）；不得为概念线框重画
- `dialog / dialog-row / progress-track（确认与进度对话框）` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: 空间切换确认、关闭三选项、安装准备等模态均用此结构
- `system-state-card / state-icon / state-facts（系统态卡）` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: 登录承接、ContractGate、失败恢复等整页系统态用此卡，居中 + 最小操作集
- `flow-state-page（跨端交接卡）` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: 浏览器端只画交接卡：eyebrow 标注系统浏览器上下文，事实用 state-facts，不复制完整后台
- `circle-card / circle-work-row / circle-detail-heading（圈子）` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: 我的圈子列表/详情新增页复用卡片与工作行语言
- `chat-file-row / skill-row / credits-banner（会话文件 / Skills / 积分提示）` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: 文件留在会话内（D-PC-03）；积分不足用容器级横幅（PC-N03）
- `status / statusChip 语义（good/info/bad/neutral/stopping）` from `docs/mvp-complete-flow-hifi/sources/g4-product.css`: 运行、阻断、到期、待审批等状态一律用 status 语义色，不新造色

## Themes and viewports

- Themes: light
- `desktop-1440x900`: 1440 x 900
- `desktop-1024x768`: 1024 x 768

## Interaction states

- loading / preparing（spinner + 幂等说明，如「正在准备我的空间」「正在终止运行项」）, empty（零常用、真空目录、零圈子、企业目录为空）, running / background（运行 pill、运行状态中心、标签运行点）, stopping / partially-failed（逐项终止、部分停止失败、已终止项不自动恢复）, offline（缓存目录标注获取时间；联网步骤等待）, blocked（版本紧急阻断、分发撤下、订阅到期、OS 权限拒绝）, expired / pending（圈子到期、共享邀请待审批）, error / recovery（目录失败、目标空间失败、更新失败、查询失败；重试幂等）, interrupted / partial output（生成中断保留已生成部分；停止原因分开展示）

## Prototype guidance

- 高保真原型为离线单文件（surface.html + prototype.html 评审壳），零网络请求、零外部资源
- 演示数据一律虚构（人名、企业、价格、积分），不得使用真实账号或真实 App 材料
- App 内部一律中性 FDE 占位；不得用示例 App 的执行/结果页充当 Polo 产品设计
- 浏览器端只画交接卡（flow-state-page），不把支付/管理后台复制进客户端
- 评审 chrome（索引、标注、故事、视口）只在 prototype.html；surface.html 保持纯产品表面
- 失败/取消分支若无可自然触达的产品按钮，用带「分支」前缀的次要按钮表达，并在标注中说明
- 目标视口 1440×900 与 1024×768：不得出现非预期横向溢出、遮挡或不可达操作

## Checks

- No repository-owned mechanical design check is currently bound; use representative-page visual review and record this gap.

## Decisions

- `D-TOKENS-G4` confirmed: 原型与客户端 UI v1 的视觉令牌以 G4 冻结稿 product.css 为唯一权威；不混用 docs/DESIGN.md 的 oklch 旧令牌 (source `docs/mvp-complete-flow-hifi/sources/g4-product.css`)
- `D-FREEZE-SCOPE` confirmed: 冻结范围 = PC-F01—F11 整端 UI v1（2026-08-11 产品确认）；改产品页面/状态语义须生成新 artifact commit 并重新确认 (source `docs/mvp-complete-flow-hifi/sources/g4-review-record.md`)
- `D-IMPL-EVIDENCE` confirmed: 「当前已有」结论绑定 apps/electron/src/renderer/index.css（dev 01f4447c）与真实页面截图；集成候选（C-INT）单独标注，不冒充发布版 (source `apps/electron/src/renderer/index.css`)
- `D-DESIGN-DOC-DELTA` suggested: docs/DESIGN.md（oklch · #5e17eb）与 G4 冻结令牌（#6e56cf）不一致：按冻结稿执行，DESIGN.md 待后续卡更新 (source `docs/DESIGN.md`)
- `D-THEME-LIGHT` suggested: 本阶段只对 light 主题做视觉验收；G4 含 dark 令牌，dark 验收延后 (source `docs/mvp-complete-flow-hifi/sources/g4-product.css`)

When a bound source changes, locate affected rules and pages before refreshing this Skill. Preserve confirmations whose source and scope did not change.
