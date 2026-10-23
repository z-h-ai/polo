# Polo 组件素材使用索引（可再生展示与生产落点）

版本：`native-materials-r4-dev-aligned-20261023`。本文是 Skill 的维护源（登记于 `references/design-system.json` sources），由 `docs/mvp-complete-flow-hifi/tools/check_design_system.py` 校验其与 playground 注册的一致性。

## 定位与边界

- 生产组件留在所属代码模块，**通过真实 import 复用**；本文只给入口，不复制实现。
- 组件「可浏览」的权威方式是**可再生展示**：renderer playground 与 Skill 内当前实现基线组件画廊都直接 import 生产组件渲染，改组件即改展示。
- 下列素材**不是组件库**，不得当作完整组件实现来源：
  - `assets/components/*.js`（4 个）——原型共享行为脚本（Header 滚动线、空间切换序列/进度、圈子回执反馈），生产须接真实状态/服务，不移植模拟结果。
  - `docs/reports/2026-10-18-polo-design-component-library.html`——一次性手工组装展示快照（token 为逐值副本，会漂移），只作历史参考。
  - `design-demos/polo-client-source-baseline/components/index.html`——r12 之前的历史冻结画廊（旧 oklch token），非当前生产 React 证据。
  - `design-demos/polo-chat-options/`、`design-demos/polo-stage4-change-map/`——历史提案快照，非 authority。

## 可再生展示：renderer playground 与 Skill 内基线

两条可再生展示通道，分工不同，都直接 import 生产组件（展示自动跟随组件变更）：

- **renderer playground**（交互调参台）：`bun run electron:dev` 后打开 `http://localhost:5173/playground.html`，左侧按分类选择组件，支持变体切换与可调尺寸预览。注册协议见 `apps/electron/src/renderer/playground/registry/types.ts`（`ComponentEntry`），注册中心 `registry/index.ts`。
- **当前实现基线**（Skill 内离线场景，`assets/source-baseline/`）：统一入口 `assets/source-baseline/index.html`（三层导航 + 生成/验证记录），场景目录 `assets/source-baseline/entries/baseline.html`。其中**第二层组件画廊**（`entries/baseline.html?scene=components-gallery`，file:// 可开）按 Settings/聊天业务/Onboarding 三组收列生产组件卡与变体，每卡标注生产落点，渲染协议与 playground 注册同源（默认打开 Settings 分组；布局 guard 只抑制自动聚焦滚动，用户滚动立即接管）。由 `tools/source-baseline/build.py` 单向生成（tsc 真实类型检查 → vite 场景提取与打包 → 产物落位），fixture 只替换后端数据、不改组件；再生一致性由 check_design_system.py 强制（真实输入指纹 + 输出逐字节再生，非 HEAD 等值）。地址支持 `?scene=ID` / `#scene=ID`，`&pure=1` 为纯页面模式。

按产品区域的覆盖矩阵（区域 → Skill 内场景 → 生产文件）：

| 区域 | Skill 内场景（`assets/source-baseline/entries/baseline.html?scene=`） | 生产文件 |
|---|---|---|
| 登录 | `login-phone` / `login-password` / `login-error`（真实 OnboardingWizard 外层壳，含 useClientMaterialScope 材质画布） | `components/onboarding/OnboardingWizard.tsx` + `AdminLoginStep.tsx`/`PhoneAuthStep.tsx` |
| 工作台整页 | `workspace-home` / `workspace-circle-detail`（真实 TabShell+TopBar+ClientHomeRouter，首页→圈子→详情产品路由） | `tab-browser/TabShell.tsx` + `app-shell/TopBar.tsx` + `circles/ClientHomeRouter.tsx` + `context/ClientPageContext.tsx` |
| 工作台首页 | `home-page`（正常应用目录 + 圈子关系，异常态另列于目录 fixture 说明） | `tab-browser/HomePage.tsx` |
| 圈子列表 | `circles-list`（付费+免费两条样例） | `circles/MyCirclesPage.tsx` + `MemberCircleRow.tsx` |
| 圈子详情 | `circle-detail-content` / `circle-detail-updates` / `circle-detail-subscription`（可读订阅周期+续费预览契约） | `circles/CircleDetailPage.tsx` + `CircleSubscriptionPanel.tsx` |
| 助手 | `chat-input-container` / `chat-turn-card` / `chat-turn-card-tasks`（整体复用 playground chat 注册的 wrapper/mockData 协议） | `playground/registry/chat.tsx` 消费的 InputContainer/TurnCard 生产组件 |
| 设置 | `settings-<注册表 key>`；完整集合见 baseline-manifest.json，另有账号安全未登录态 | `pages/settings/settings-pages.ts` + `pages/settings/*.tsx`（注册表自动遍历，不手抄场景目录） |

Settings 分类注册（`registry/settings.tsx`，与本文联动校验；id 集合必须与下面列表一致）：

- `settings-page-preview` — 整页拼装（registry `PageDemo` 组合展示示例，import `@/components/settings` 真组件；非直接 import `pages/settings`）：Section + divided Card + 行控件 + danger 区 + Footer
- `settings-section` — SettingsSection（default/danger 变体）
- `settings-toggle` — SettingsToggle（含禁用态）
- `settings-select` — SettingsSelect / SettingsSelectRow
- `settings-menu-select` — SettingsMenuSelect（含描述、超 8 项自动搜索）
- `settings-segmented-control` — SettingsSegmentedControl（sm/md）
- `settings-segmented-card` — SettingsSegmentedControlCard（2-4 列卡片段）
- `settings-radio-group` — SettingsRadioGroup / SettingsRadioCard（选中展开 expandedContent）
- `settings-input` — SettingsInput / SettingsInputRow（含 error 态）
- `settings-secret-input` — SettingsSecretInput（显隐切换）
- `settings-textarea` — SettingsTextarea（字数计数）
- `settings-row-divider-group` — SettingsRow / SettingsDivider / SettingsGroup 原语

相邻可参考的既有注册：`messaging-settings-page`（messaging 设置整页，间接展示 SettingsSection/SettingsCard 的真实组合，`registry/messaging.tsx`）；onboarding 登录步骤（`registry/onboarding.tsx`，对应 AdminLoginStep/PhoneAuthStep）。

## 生产组件消费

- 设置页组件：`@/components/settings`（导出面 `apps/electron/src/renderer/components/settings/index.ts`）；页面消费方 `apps/electron/src/renderer/pages/settings/*`（`settings-pages.ts` 注册表子页，当前集合以源码和生成 manifest 为准，自动保存 500ms debounce）。
- 应用侧原子基元：`apps/electron/src/renderer/components/ui/`（button/badge/input/switch/dialog/popover/select/dropdown-menu/table/avatar/empty 等 shadcn 式基元 + DataTable/EntityList 等复合件）。
- 共享技术组件库：`@polo-ai/ui`（`packages/ui/src/index.ts`，约 108 个导出：Spinner、Tooltip、Drawer、TurnCard 体系、Markdown/overlay/code-viewer 等）。
- 工作台样式桥梁（产品面 skill token → renderer）：
  - `apps/electron/src/renderer/lib/client-workbench-style.ts` — Vite `?raw` import Skill 两份 token CSS，解析 `:root` 生成派生别名；缺 `--surface/--shadow-panel` 即抛错。
  - `apps/electron/src/renderer/components/ui/client-workbench.ts` — Dialog/Menu/Button 组合类常量。
  - 注意两套 token 体系不可混用：renderer `index.css` 是 oklch 相对色（助手/全局），Skill 两份 CSS 是十六进制语义色（产品面）；对照见 `references/component-inventory.md` §7。

## Skill 合同组件 ↔ 生产落点 ↔ 展示入口

落点坐标继承 `references/component-inventory.md` §4（2026-10-18 dev@e7c0e6bd 只读登记；复用前按当前工作树核对）：

| Skill 合同组件 | 生产落点 | 可再生展示 |
|---|---|---|
| 登录表单 | `components/onboarding/AdminLoginStep.tsx` + PhoneAuthStep/MethodSwitch | playground `registry/onboarding.tsx`；页面基线 P-M01-* |
| 工作台顶栏 | `components/app-shell/TopBar.tsx` + `product-space/ProductSpaceSwitcher.tsx` | 页面基线 P-M03-HOME-*（无独立 playground 注册） |
| 工作区布局 | `tab-browser/HomePage.tsx` / `circles/MyCirclesPage.tsx` / `CircleDetailPage.tsx` / `ClientHomeRouter.tsx` | 页面基线各整页场景 |
| 应用卡 | `components/tab-browser/MemberAppCard.tsx` | 页面基线 P-M03-HOME-PERSONAL / P-M07-DETAIL-* |
| 首页目录 | `components/tab-browser/HomePage.tsx` | 页面基线 P-M03-*（含 9 种系统态） |
| 圈子统一列表 | `circles/MyCirclesPage.tsx` + `MemberCircleRow.tsx` | 页面基线 P-M07-LIST / P-M07-EMPTY |
| 圈子详情分区 | `circles/CircleDetailPage.tsx` + Content/Updates/Subscription | 页面基线 P-M07-DETAIL-* |
| 确认对话框 | `circles/LeaveCircleDialog.tsx` | 页面基线 P-M07-LEAVE* |
| 系统态与恢复 | `product-space/ProductSpacePreparationScreen/ErrorScreen` + `ProductSpaceSwitchDialog.tsx` | 页面基线 P-M01-PREP* / P-M07-RETURN* 等 |
| 浏览器交接 | `tab-browser/WebAppView.tsx` + CircleReturnPanel | 页面基线 P-M07-RENEW* / P-M09-BROWSER*（主 manifest） |
| 微透材质表面 | 挂载层 `data-client-material` 标记 + `lib/client-workbench-style.ts` | `assets/prototypes/poo105-materials/approved-r5.html`（固定快照）+ token-preview 交互态区 |

## 新增/更新组件展示的规则

1. 生产组件变更无需复制实现；playground 直接 import。离线画廊必须重新运行 `tools/source-baseline/build.py` 并 `--check`，导出不会自动更新。
2. 新增 Settings 分类条目：加进 `registry/settings.tsx` 并同步更新本文「Settings 分类注册」id 列表（检查器强制一致）。
3. 新分类条目（非 Settings）：在 `registry/index.ts` 注册并在 `registry/types.ts` 的 `Category` 与 `categoryOrder` 登记；本文只需在「相邻可参考」提一句。
4. 禁止把生产组件实现复制进 Skill assets 或任何展示 HTML。

原生候选继续 import 原模块；任务内叶子副本的 alias、providers、fixture 和导出命令见 [native-reuse.md](native-reuse.md)。样式来源/预览见 [style-usage.md](style-usage.md)。
