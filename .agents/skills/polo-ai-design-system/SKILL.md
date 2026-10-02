---
name: polo-ai-design-system
description: Polo 桌面客户端（Electron 工作台）产品 UI 的视觉令牌与组件语言。制作 Polo 客户端线框、高保真原型或评审产品页面视觉时使用；不适用于 Admin/浏览器后台、第三方 App 内部业务页或其他产品。
---

# Polo AI 设计系统（客户端）

提取式设计 Skill。**助手范围现以 `design-demos/polo-client-source-baseline/src/` 为用户指定基线**：固定组件来源 `01f4447cf77612ca2c62d9c7155601a51bdb7b5b`，证据见该目录 `SOURCE-EVIDENCE.md` / `SCENE-TRACEABILITY.md`。聊天壳层调整与 `src/mvp/` 新增状态属于设计提案，非真实客户端现状。默认工作区由系统准备；当前个人/企业仅静态标识；不迁移旧助手 Workspace 创建/切换、远程工作区或组织管理入口。助手样式沿用基线 `src/styles/`，不要以旧 MVP 助手为生成参考。

**非助手范围**的权威来源是 POO-41 的 **G4 UI v1 冻结稿**（`POO-41/feat/polo-client-g4-ui@ef3528ef` 的 `docs/g4-polo-client-ui/`，2026-08-11 产品确认冻结，对应本卡快照 `docs/mvp-complete-flow-hifi/sources/g4-product.css`）；冻结范围是 PC-F01—F11 整端 UI v1（见 `sources/g4-review-record.md`）。G4 是历史基线；本卡 2026-10-02 用户明确要求重新优化全部 UI/UX，授权本轮原型修改。新增视觉以 `assets/tokens/workbench-review.css` 作为两份产品表面的共同维护来源（r15 设计提案，待复看）；不覆盖历史快照，也不据此改写已确认业务规则。

## 令牌权威与实现证据

| 角色 | 来源 | 用法 |
| --- | --- | --- |
| authority | `docs/mvp-complete-flow-hifi/sources/g4-product.css`（G4 冻结稿） | 历史冻结视觉依据：background/foreground 派生色 + accent/info/success/destructive、system-ui 字体栈与字号阶梯、圆角/阴影/层级、`[data-theme=dark]` 深色令牌 |
| implementation | `docs/mvp-complete-flow-hifi/sources/renderer-index.css`（dev 01f4447c，原路径 apps/electron/src/renderer/index.css） | 固定版本实现样式证据，已与该 commit 逐字节核对；不以当前工作树文件冒充此版本。非助手与 G4 冻结稿不一致时以冻结稿为准 |
| implementation（历史基线） | `docs/DESIGN.md`（oklch · `#5e17eb`） | 与 G4 冻结主色 `#6e56cf` 不一致，按冻结稿执行；DESIGN.md 待后续卡更新 |

主题只对 `light` 做过视觉验收；dark 令牌存在但验收延后。

## 结构组件（直接复用，不重画）

- **workbench-bar 顶栏**：品牌、标签、运行状态 pill、当前空间静态标识、通知、账号菜单。头像菜单中的「切换空间」进入 M02 空间列表；顶栏始终显示已提交的当前空间，但不再提供独立切换下拉（D-PC-10）。企业/创作者管理及全局设置在账号菜单按资格出现；技能管理按 D-PC-13 上提为 Polo 一级入口。
- **app-shell + workspace-main**：主内容工作区。App 打开后占满工作区（D-PC-05），容器外不得加 App 内部 chrome。
- **product-card / card-grid / app-art**：App 卡与完整应用目录，来源行 source-line 必须保留（同名靠来源辨识）。
- **助手 SourcePoloShell + EmptyChat / ResourceListDetail**：输入区、会话和数据源复用新基线；依 master-r14 §13，外层补 Polo 顶栏，技能管理独立于助手导航，复用授权/准备/版本状态；MVP 业务状态由 `src/mvp/` 扩展，旧 `assistant-shell` 不再是当前来源。
- **dialog / dialog-row / progress-track**：空间切换确认、关闭三选项、安装准备等模态。
- **system-state-card / state-icon / state-facts**：登录承接、ContractGate、失败恢复等整页系统态，居中 + 最小操作集。
- **flow-state-page**：浏览器跨端交接卡——eyebrow 标注系统浏览器上下文，事实用 state-facts，不复制完整后台。
- **circle-card / circle-work-row / circle-detail-heading**：我的圈子列表/详情。
- **chat-file-row / skill-row / credits-banner**：文件留在会话内（D-PC-03）；积分不足用 Polo 容器级横幅（PC-N03）。
- **status / statusChip 语义**（good/info/bad/neutral/stopping）：运行、阻断、到期、待审批一律用语义色，不新造色。

## 原型指导

- 当前统一评审入口 `docs/mvp-complete-flow-hifi/review.html`；MVP 与助手各保留独立产品 HTML，由 manifest 页面归属映射驱动。助手只改源码再导出；统一入口用 `python3 docs/mvp-complete-flow-hifi/tools/build_review.py` 更新。
- 高保真原型离线双文件：`prototype.html` 纯产品表面 + `review.html` 评审壳（product-ui-prototype v3）；零网络请求、零外部资源。
- 演示数据一律虚构（人名、企业、价格、积分），不使用真实账号或真实 App 材料。
- App 内部一律中性 FDE 占位；不得用示例 App 的执行/结果页充当 Polo 产品设计。
- 失败/取消分支若无可自然触达的产品按钮，用评审壳的 `review_entries` 进入，不在产品表面增加演示按钮。
- 目标视口 1440×900 与 1024×768：不得出现非预期横向溢出、遮挡或不可达操作。

## 边界

- 不适用于 Polo 管理端（POL-113 企业后台）、创作者工作台、平台后台的页面设计；浏览器端在这些卡走查。
- 第三方 App 内部业务交互由 FDE 负责（D-PC-02/D-PC-05），本 Skill 不为它们提供容器外样式。
