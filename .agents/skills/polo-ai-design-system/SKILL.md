---
name: polo-ai-design-system
description: Polo 桌面客户端（Electron 工作台）产品 UI 的视觉令牌与组件语言。制作 Polo 客户端线框、高保真原型或评审产品页面视觉时使用；不适用于 Admin/浏览器后台、第三方 App 内部业务页或其他产品。
---

# Polo AI 设计系统（客户端）

提取式设计 Skill。权威来源是 POO-41 的 **G4 UI v1 冻结稿**（`POO-41/feat/polo-client-g4-ui@ef3528ef` 的 `docs/g4-polo-client-ui/`，2026-08-11 产品确认冻结，对应本卡快照 `docs/mvp-complete-flow-hifi/sources/g4-product.css`）；冻结范围是 PC-F01—F11 整端 UI v1（见 `sources/g4-review-record.md`）。修改产品页面/状态语义须生成新 artifact commit 并重新确认，本 Skill 不授权解冻。

## 令牌权威与实现证据

| 角色 | 来源 | 用法 |
| --- | --- | --- |
| authority | `docs/mvp-complete-flow-hifi/sources/g4-product.css`（G4 冻结稿） | 视觉令牌与组件样式的唯一权威：background/foreground 派生色 + accent/info/success/destructive、system-ui 字体栈与字号阶梯、圆角/阴影/层级、`[data-theme=dark]` 深色令牌 |
| implementation | `apps/electron/src/renderer/index.css`（dev 01f4447c） | 「当前已有」结论的真实样式证据；与冻结稿不一致时以冻结稿为准 |
| implementation（历史基线） | `docs/DESIGN.md`（oklch · `#5e17eb`） | 与 G4 冻结主色 `#6e56cf` 不一致，按冻结稿执行；DESIGN.md 待后续卡更新 |

主题只对 `light` 做过视觉验收；dark 令牌存在但验收延后。

## 结构组件（直接复用，不重画）

- **workbench-bar 顶栏**：品牌、标签、运行状态 pill、当前空间静态标识、通知、账号菜单。头像菜单中的「切换空间」进入 M02 空间列表；顶栏始终显示已提交的当前空间，但不再提供独立切换下拉（D-PC-10）。管理入口仍只在账号菜单按资格出现（D-PC-07）。
- **app-shell + workspace-main**：主内容工作区。App 打开后占满工作区（D-PC-05），容器外不得加 App 内部 chrome。
- **product-card / card-grid / app-art**：App 卡与常用区，来源行 source-line 必须保留（同名靠来源辨识）。
- **assistant-shell 三栏 + chat-composer**：侧栏 / 会话导航 / 主面板。助手、Skills、会话文件、数据源共用（D-PC-06 直接复用，不得为概念线框重画）。
- **dialog / dialog-row / progress-track**：空间切换确认、关闭三选项、安装准备等模态。
- **system-state-card / state-icon / state-facts**：登录承接、ContractGate、失败恢复等整页系统态，居中 + 最小操作集。
- **flow-state-page**：浏览器跨端交接卡——eyebrow 标注系统浏览器上下文，事实用 state-facts，不复制完整后台。
- **circle-card / circle-work-row / circle-detail-heading**：我的圈子列表/详情。
- **chat-file-row / skill-row / credits-banner**：文件留在会话内（D-PC-03）；积分不足用 Polo 容器级横幅（PC-N03）。
- **status / statusChip 语义**（good/info/bad/neutral/stopping）：运行、阻断、到期、待审批一律用语义色，不新造色。

## 原型指导

- 高保真原型离线双文件：`prototype.html` 纯产品表面 + `review.html` 评审壳（product-ui-prototype v3）；零网络请求、零外部资源。
- 演示数据一律虚构（人名、企业、价格、积分），不使用真实账号或真实 App 材料。
- App 内部一律中性 FDE 占位；不得用示例 App 的执行/结果页充当 Polo 产品设计。
- 失败/取消分支若无可自然触达的产品按钮，用评审壳的 `review_entries` 进入，不在产品表面增加演示按钮。
- 目标视口 1440×900 与 1024×768：不得出现非预期横向溢出、遮挡或不可达操作。

## 边界

- 不适用于 Polo 管理端（POL-113 企业后台）、创作者工作台、平台后台的页面设计；浏览器端在这些卡走查。
- 第三方 App 内部业务交互由 FDE 负责（D-PC-02/D-PC-05），本 Skill 不为它们提供容器外样式。
