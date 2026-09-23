# 四端共享设计基础（G4 UI 原型设计契约）

状态：Phase 1 产物初版（2026-08-10）；四条黄金流程确认后冻结

依据：`docs/g4-ui-prototype-reimplementation-plan.md` §3.1。本文冻结四端共用的品牌、token、组件、状态、权限和响应式规则。每个值标注追溯等级：`exact`（逐字取自源码）、`derived`（由源码证据机械推导，附推导）、`approximate`（源码无证据，最小范围近似，附原因）。

## 1. 视觉权威来源

| 端 | 权威来源 | 追溯 |
| --- | --- | --- |
| Polo 客户端 | `polo-dir/dev@01f4447c docs/DESIGN.md`（450 行设计系统定义） | exact |
| 三个管理端 | `polo-admin-dir/dev@ce3bbdce src/app/globals.css`、`tailwind.config.ts`、`src/components/admin-shell.tsx`、`src/components/organization-console-shell.tsx`、`src/components/ui/*` | exact |
| 冲突裁决 | 计划 §2：产品文档 > 本计划 > 真实源码 > DESIGN.md 可复用视觉语言 > 现有 G4 HTML 局部经验 | — |

渲染验证（2026-08-10）：polo webui（`bun run webui:dev` :5175）HTTP 200 可渲染；polo-admin（`npm run dev` :3100）登录页 HTTP 200，DB 依赖页面需数据库，静态源码兜底。管理端无 i18n；客户端 7 语言（`packages/shared/src/i18n/locales/`）。

## 2. 品牌与色彩

### 2.1 品牌锚点（2026-08-10 用户裁决改版：客户端与管理端使用不同品牌色）

| Token | 值 | 等级 | 说明 |
| --- | --- | --- | --- |
| client accent | `#9570BE`（oklch 由 token 系统换算后记录于客户端产物 CSS） | 用户裁决 | Polo 客户端品牌色，替代 DESIGN.md 的 `#5e17eb`。用于 logo 标记、主 CTA、激活态、焦点环；深色主题派生更亮变体（沿用 DESIGN.md +0.08 lightness 模式） |
| admin primary | `#1ABCFE` | 用户裁决 | 三个管理端统一品牌色，替代此前的品牌紫派生规则。用于主按钮、导航激活态、焦点环、关键链接 |
| on-accent | 取对比度 ≥4.5:1 方向：两个品牌色均为浅色，文字默认用深色（近 foreground），不用白色 | derived | 具体值以对比度实测为准并在产物 CSS 注释记录数值 |

语义状态色（info/success/destructive 暖对比系）维持 §2.2 不变。计划 §5.1"不通过更换品牌主色伪装成不同产品"指管理端三端之间一致（同用 `#1ABCFE`）；客户端与管理端的色族差异是用户明确裁决（2026-08-10）。

### 2.2 语义状态色（四端共享，暖对比系）

| 语义 | 浅色 | 深色 | 等级 |
| --- | --- | --- | --- |
| info/警告 | `oklch(0.72 0.16 75)` `#d4960c` | `oklch(0.76 0.15 75)` `#e0a830` | exact |
| success/完成 | `oklch(0.58 0.14 165)` `#0d9465` | `oklch(0.68 0.14 165)` `#14b880` | exact |
| destructive/危险 | `oklch(0.58 0.22 25)` `#e03e3e` | `oklch(0.64 0.22 25)` `#ef5555` | exact |

规则（exact，DESIGN.md Do/Don't）：语义色各守其道——琥珀=预警/配额/待确认，青绿=成功/完成，暖红=错误/危险/注销；不新增第五种语义色；语义色用于 8–10% 着色底 + 同色文字的状态徽章。

管理端映射：destructive 替换现行 `0 84.2% 60.2%`；info/success 新增为 Tailwind token。等级：derived。

### 2.3 中性色系统

客户端（exact）：双核心派生——`background oklch(0.98 0.008 290)` `#faf8fd` / `foreground oklch(0.17 0.02 290)` `#1a1726`；深色 `oklch(0.14 0.025 290)` / `oklch(0.94 0.015 290)`。fg-N 阶梯（N=2,3,5,7,10,20,30,40,50,60,70,80）用 `color-mix(in srgb, var(--foreground) N%, var(--background))` 派生；border=fg-5；elevated=fg-1.5；user-bubble=fg-5。

管理端（exact）：shadcn HSL——background `0 0% 100%`、foreground `222.2 84% 4.9%`、muted `210 40% 96.1%`、muted-foreground `215.4 16.3% 46.9%`、border/input `214.3 31.8% 91.4%`、ring `222.2 84% 4.9%`、card/popover 同 background、radius `0.5rem`。

对比度规则（derived；DESIGN.md 自承 fg-20/30 未审计）：正文/可操作文字 ≥ fg-60（浅底对比 ≈5.9:1，过 AA）；fg-50（≈4.3:1）仅限大号或次要说明；< fg-50 仅装饰。管理端 muted-foreground（≈4.8:1）为次要文字下限。状态徽章文字用语义色全强度，不用浅色变体。

### 2.4 壳层修复第 2 轮落定（2026-08-10 用户裁决 P0+P1 全做）

- **客户端字号回归源标尺**：display 20px（h1）、卡片标题 14px、正文/描述 13px、按钮 12px/500、meta 11px、时间戳/徽章 10px 下限；任何文字 ≥10px。新增 `.skeleton`/`.skeleton-stack` 与 `.empty-state` 组件（derived：foundation §5）。
- **管理端中性色漂移紫灰族**：`--ink` = #1A1726（与客户端前景同族），次级文字/边框/填充灰由 `color-mix(in srgb, #1A1726 N%, #FFFFFF)` 派生（N=72/56/40/10/5/3，产物 CSS 注释含实测对比度）；`--canvas` = #FAF8FD。蓝灰族（#111827/#667085 等）全部退役。
- **管理端 token 收编**：语义色统一为主色+strong+soft+border 四件套（`--info-strong/--danger-strong/--success-strong`、`--*-border`）；裸 hex 只允许出现在 `:root` 定义块。通知圆点默认 `--info` 琥珀，仅失败类用 danger。品牌标记彩色光晕移除。
- **管理端顶栏 60px**（brand 区同步），触达目标 ≥36px。
- 验收基线更新：壳层机械验收 84/84（`.pipeline/accept-phase2-shells.mjs`，含字号/色族/顶栏断言）。

## 3. 字体与排版

字族（exact）：正文 `system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`；代码 `'JetBrains Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace`（Google Fonts CDN 加载）。不引入品牌定制字体。

字号阶梯（exact，DESIGN.md；管理端 Tailwind `text-sm/xs` 与此兼容）：

| Token | px/weight/line-height | 用途 |
| --- | --- | --- |
| display | 20/600/1.25（-0.15px） | 页面大标题、空状态标题 |
| heading | 14/600/1.25 | 面板/卡片标题 |
| body-md | 14/400/1.6 | 正文、消息、按钮 |
| body-sm | 13/400/1.35 | 导航项、列表次级 |
| label | 13/500/1.25 | 表单标签、列表标题 |
| caption | 12/400/1.35 | 徽章、预览、辅助 |
| micro | 11/500/1.25（+0.75px 大写） | 区块 overline 标签 |
| tag | 10/500/1.4 | 状态徽章 |
| code-md/code-sm | 13/400/1.6、12/400/1.4 | 代码块/代码标签 |

规则（exact）：字重只用 400–600（品牌标记 700 例外）；正文不加大写字距；抗锯齿 `-webkit-font-smoothing: antialiased`。

## 4. 间距、圆角、阴影、动效

间距（exact）：2/4/6/8/12/16/20/24/32/40（xxs–5xl）。6px 面板间距是客户端悬浮面板特征；管理端卡片内边距用 16/24。

圆角（exact）：xs4/sm6/md8/inner10/lg12/edge14/bubble16/card20/pill。管理端现行 `radius 0.5rem`（=md 8），卡片用 lg 12 与本标尺对齐。等级：derived（管理端卡片半径从默认 8 上调到 12 以对齐家族语言）。

阴影（exact，客户端四级）：L1 `shadow-minimal`（1px ring 4% + 0.5px blur 3%，侧栏/未聚焦输入）；L2 `shadow-middle`（ring 6% + 1/3/6px 三层 blur，聚焦输入/卡片）；L3 `shadow-panel-focused`（渐变描边 + 1/3/6/12/24px 五层，主面板）；T `shadow-tinted`（语义色环，权限徽章）。浅色下保持"几乎不可见"的克制；深色下 ring 0.08→0.15、blur 0.06→0.12。管理端弹层/卡片复用 L1/L2 参数。等级：derived（管理端现行 Tailwind 默认 shadow 替换为家族参数）。

动效（derived；DESIGN.md Known Gaps 记录的无系统标尺）：微交互 0.1–0.15s ease-out；状态切换 0.25–0.35s；弹层入场 fade+translateY(4px) 0.15s；不用弹性过冲曲线。管理端现行 `transition-transform duration-200 ease-in-out` 与此兼容。

## 5. 共享组件契约

表达分两族：**客户端族**（悬浮面板、磨砂登录卡、ghost 按钮）与 **Admin 族**（shadcn 浅色、左侧导航壳）。语义规则四端一致，视觉参数各族取 §2–4 对应值。

| 组件 | 语义契约 | 客户端族参数 | Admin 族参数 |
| --- | --- | --- | --- |
| 主按钮 | 每视图一个主动作；品牌紫底白字；loading 内置 spinner 且禁重复提交 | rounded-md 8px、padding 10px、accent 阴影 `0 10px 24px accent 28%`（exact） | 同左色值；h-9 px-4 rounded-lg（derived 自 shadcn button） |
| 次按钮/ghost | 工具栏/行内动作用 28×28 ghost（exact）；表单次动作用描边按钮 | fg-50 文字、hover fg-5 底 | `Button variant="ghost" size="sm"`（exact，admin-shell 用法） |
| 危险按钮 | destructive 色；仅危险确认 Dialog 内出现主危险按钮 | exact 色值 | 同左 |
| 表单输入 | bg-background、rounded-md、10px 12px padding；focus=accent 描边 + 3px accent 12% 环（exact）；错误=destructive 描边 + caption 错误文案 | exact | 同左；现行 `input` token 保留为默认边 |
| 搜索/筛选 | 工具行左搜索右筛选；筛选变更即生效；空结果走空状态 | derived（客户端无成熟表格筛选，取 family 语言） | exact（现行表格页模式） |
| 表格 | 表头 caption/micro 次要色；行 hover fg-3；行内主操作一个，其余入更多菜单；空表=空状态组件 | derived | exact（`components/ui/table.tsx`） |
| 卡片 | 白底、border fg-5、rounded-card/lg、padding 24 | rounded-card 20 + shadow-minimal（exact） | rounded-lg 12 + border `214.3 31.8% 91.4%`（derived） |
| Badge/状态徽章 | 语义色 8–10% 底 + 同色全强度文字 + tag 字体；高度 18–22px | exact（tag-chip/status-chip/permission-badge） | 同左（derived） |
| Toast | 右上角滑入，4s 自动消失，危险/成功用语义色左边条 | approximate：两源码均无 Toast 实现（DESIGN.md Known Gaps 自承；admin 无组件），取家族语言最小表达 | 同左 |
| 空状态 | display 标题 + body-sm 说明 + 一个主行动按钮；不放插画库外素材 | derived（登录/空态标题规则 exact） | 同左 |
| 加载 | 区块级用 skeleton（exact，`components/ui/skeleton.tsx`）；按钮级用 spinner（exact，admin-shell 退出按钮模式）；整页加载=骨架屏不白屏 | — | — |
| Dialog | 居中、max-width 28–32rem、遮罩 `black/40`（exact，admin mobile overlay 值）；Esc 关闭；危险 Dialog 必须含原因输入或确认勾选 | derived | exact 模式已在 shell 行为中 |
| Drawer | 右侧详情面板；管理端详情首选 Drawer 而非跳页；宽度 420–560px | approximate：源码无 Drawer；取管理后台成熟模式，家族 token 表达 | 同左 |
| 重新验证 | 高风险动作专用 Dialog：密码/口令输入 + 原因必填 + 影响摘要 + 确认按钮 loading 态 | derived（产品文档 OPS/ENT 高风险规则 + 登录输入 exact 参数） | 同左 |
| 不可修改审计预览 | 只读记录卡：操作者、目标、原因、时间、结果四元组 + 语义色结果徽章；不提供编辑入口 | derived（audit 产品语义 + 卡片参数） | 同左 |

## 6. 状态统一表达（正常/空/加载/失败/受限/操作结果）

| 状态 | 统一表达 |
| --- | --- |
| 正常 | 真实数据密度；不用 lorem ipsum；稳定标识（作品 ID、企业名、账号）贯穿一致 |
| 空 | 空状态组件：为何为空 + 下一步主行动；权限不足导致的空 ≠ 无数据空（前者走受限表达） |
| 加载 | 骨架屏（结构同真实内容）；超过即时反馈阈值的动作用按钮 spinner；不确定进度不伪造百分比 |
| 失败 | 页面级=destructive 边条 + 重试按钮 + 可理解原因；操作级=Toast/行内错误；未知结果绝不显示为成功（S-060/PC-F10 规则） |
| 受限 | 保留数据只读展示 + 限制原因 + 恢复条件 + 责任人入口（计划 §5.1 共同权限规则）；角色无权操作=控件保留但禁用并附原因（tooltip 或相邻 caption）；完全无权模块=隐藏入口 |
| 操作结果 | 成功=success 语义反馈 + 状态就地更新；部分失败=逐项列出成功/失败，不允许整体假成功（OPS-F12 规则） |

焦点/键盘/禁用/只读统一规则：所有交互元素可见焦点环（accent 3px 12%，exact）；Dialog/Drawer 打开时焦点陷入、Esc 关闭（exact，admin-shell Esc 行为）；禁用元素 `aria-disabled` + 原因可感知（title 或相邻说明）；只读内容用正文色不用禁用灰，避免与"不可用"混淆（derived）。

## 7. 响应式与视口

| 端 | 主视口 | 次视口 | 手机降级 | 断点依据 |
| --- | --- | --- | --- | --- |
| Polo 客户端 | 1440×900 | 1024×768 小窗口 | 不覆盖（桌面产品；AB 声明窄视口仅查最小窗口保护） | exact：DESIGN.md"Electron 桌面应用无 CSS 断点，最小窗口在 BrowserWindow 层定义" |
| 三个管理端 | 1440×900 | 1024×768 平板横屏可操作 | 390×844 仅登录、邀请落地、状态查看、紧急确认 | exact：admin-shell `md:`(768px) 断点行为；计划 §5.1 |

管理端 1024 规则：侧导航可折叠为抽屉（exact：admin-shell 移动模式行为），表格允许横向滚动，不错位截断。手机降级页顶部显示"完整管理能力请使用桌面端"提示（derived，计划 §5.1）。

## 8. 语言与文案

客户端：7 语言源码能力；AB 评审 `zh-Hans` 为规范截图语言，`en` 为第二声明语言（契约允许全矩阵过量时取首语言规范截图）。管理端：仅 `zh`。全部产品文案为正式中文，信息架构词汇遵循 `CONTEXT.md`（我的空间/企业空间/创作者圈子/Creator Owner/平台运营端等）。

## 9. 产品/评审分离执行规则（计划 §3.2 落地）

1. 产品 HTML（index.html、before.html、after.html）只含真实产品界面；scene/theme/lang 仅经 URL query 注入，页面内不出现任何控制器、流程编号、来源或设计说明。
2. 每个 before/after 内嵌 `<script id="prototype-config" type="application/json">` 声明协议（AB 契约）；未知值回退首个声明值。
3. 评审工具（comparison.html、reviews/index.html）视觉与产品明确区分：中性灰壳、固定工具栏标题"评审工具"。
4. 近似值在产品 HTML 中以 `approximate:<id>` 不可见标记（HTML 注释或 data 属性），渲染层不可见；明细只进 manifest。

## 10. 追溯等级汇总

- exact：客户端全部 token（DESIGN.md）；管理端中性色/radius/shell 结构/skeleton/spinner/Esc/遮罩（globals.css、admin-shell.tsx、ui 组件）。
- derived：管理端品牌紫与语义色接入、管理端卡片圆角/阴影对齐、对比度规则、动效标尺、危险确认/重新验证/审计预览组件、响应式降级规则。
- approximate：Toast、Drawer（两族均无源码证据，已在 §5 记录原因）。

待黄金流程确认后冻结；任何 freeze 后变更回写本文并记录日期与原因。
