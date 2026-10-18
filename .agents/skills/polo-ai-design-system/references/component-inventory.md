# polo-ai 生产组件盘点(Component Inventory)

- 基线:分支 `dev` @ `e7c0e6bd`;日期 2026-10-18。
- 性质:**只读登记**。生产组件留在原拥有模块,本清单只引用(`file:line`),不复制实现;登记不构成视觉授权,也不改变 SKILL.md 的 modules 声明与 Sources 边界。
- 生成方式:8 个并行探索 agent 汇总(packages/ui、renderer ui、icons、chat/messaging、产品壳/圈子、设置等目录、token 体系、skill 差距分析),主 agent 落盘。
- 配套交付:`docs/reports/2026-10-18-polo-design-component-library.html`(组件库展示页,消费本清单与 workbench token)、`docs/reports/2026-10-18-design-system-component-extraction-worksheet.md`(工作表)。

## 1. packages/ui — 共享技术组件库

根:`packages/ui/src`;导出面 `src/index.ts`(约 130 个符号)+ 10 个子路径导出(`./ui/drawer`、`./ui/styled-dropdown`、`./styles` 等)。Tailwind v4 CSS-first(`src/styles/index.css`,549 行,`:root`/`.dark` oklch 6 色系 + `@theme inline`),无 tailwind.config;Radix 仅 4 处(tooltip/dropdown-menu/dialog/context-menu),Drawer 用 vaul;无 cva(变体为手写 union)。组件 tsx 导出约 108 个。

| 域 | 代表组件 | 文件 | 要点 |
|---|---|---|---|
| 基础 | Spinner / LoadingIndicator | `src/components/ui/LoadingIndicator.tsx` | 3×3 cube spinner + 计时;renderer 引用 34 次(最高频) |
| 菜单 | StyledDropdown 全家(9) | `src/components/ui/StyledDropdown.tsx` | Radix;`popover-styled`、destructive 变体;electron 经 shim `components/ui/styled-dropdown.tsx` 被 26 文件引用 |
| 菜单(旧) | SimpleDropdown | `src/components/ui/SimpleDropdown.tsx` | 手写 fixed portal,160px 假宽度(:174-185);与 StyledDropdown 并存待收敛 |
| 浮层 | Tooltip 全家 | `src/components/tooltip.tsx` | dark + backdrop-blur,`z-tooltip` |
| 浮层 | Drawer 全家(10) | `src/components/ui/drawer.tsx` | vaul,四方向 |
| 浮层 | Island / IslandContentView / useIslandNavigation | `src/components/ui/Island.tsx`、`useIslandNavigation.ts` | 自研动态岛浮层框架 + 返回栈;与 Radix 关闭优先级经 `lib/dismissible-layer-bridge.ts` 仲裁 |
| 表单 | FilterableSelectPopover | `src/components/ui/FilterableSelectPopover.tsx` | 泛型可过滤多选 anchor popover(桌面形态) |
| 编辑 | TiptapMarkdownEditor + Bubble/Hover/Slash | `src/components/markdown/Tiptap*.tsx` | 所见即所得 + caret 菜单(InlineMenuSurface) |
| 聊天 | SessionViewer / TurnCard / UserMessageBubble / SystemMessage / AcceptPlanDropdown / CompactAcceptPlanDrawer | `src/components/chat/` | 回合卡片(嵌套子代理/annotations)、用户气泡(`--user-message-bubble`)、紧凑抽屉配对形态 |
| Markdown | Markdown(mode: terminal/minimal/full)、CodeBlock(Shiki)、10 个富块、CollapsibleSection、ImageCardStack | `src/components/markdown/`(38 文件) | 三分级渲染; datatable/diff/doc/html/json/latex/mermaid/pdf/spreadsheet |
| 预览 | FullscreenOverlayBase + PreviewOverlay + 12 个专用 Overlay + ContentFrame/CopyButton/ZoomControls/ItemNavigator | `src/components/overlay/`(20 文件) | 统一预览壳,`--z-fullscreen` |
| 代码 | ShikiCodeViewer / ShikiDiffViewer / UnifiedDiffViewer | `src/components/code-viewer/` | 自研透明底 Shiki 主题 |
| 终端 | TerminalOutput + ansi-parser | `src/components/terminal/` | ANSI 上色 |
| 标注 | AnnotationIslandMenu / AnnotationOverlayLayer + 14 个 hooks/状态机 | `src/components/annotations/` | 隐形子系统:不走根 barrel,仅 TurnCard 与 DocumentFormattedMarkdownOverlay 内部消费 |
| 浏览器 | BrowserShader / BrowserControls / BrowserEmptyStateCard | `src/components/ui/Browser*.tsx` | shader 背景读取 `--accent-rgb`;Safari 式工具栏 |
| 图标 | Icon_Folder / Icon_Home / Icon_Inbox | `src/components/icons/` | 仅 3 个,`IconProps = SVGProps + size` |
| Context | PlatformProvider / ShikiThemeProvider | `src/context/` | 平台动作注入 / Shiki 主题 |
| lib | cn、CHAT_LAYOUT/OVERLAY_LAYOUT、dismissible-layer-bridge、tool-parsers | `src/lib/` | 布局常量与工具 |

electron renderer 高频复用 top:Spinner(34)、Tooltip(14)、TurnCard(6)、DocumentFormattedMarkdownOverlay(4)、DataTableOverlay(4)、CodePreviewOverlay(3)、JSONPreviewOverlay(3)、BrowserControls(3)、UserMessageBubble(3)。

## 2. renderer components/ui — 应用侧技术组件

目录:`apps/electron/src/renderer/components/ui/`(74 文件,约 12k 行)。除非注明,纯 local state + Tailwind + `cn()`。

### 2a. shadcn 式原子基元(最可上提共享层)

button(cva:variant default/destructive/outline/secondary/ghost/link × size default/sm/lg/icon)、badge(4 变体)、input/textarea/label、switch、kbd/KbdGroup、separator、tabs、dialog(`showCloseButton`/`overlayClassName` 扩展)、popover、select(`container` portal 扩展)、dropdown-menu(`autoMirrorHoverToOpen`)、context-menu(单键快捷键注册表)、scroll-area(`viewportRef`)、collapsible(AnimatedCollapsibleContent,motion 弹簧)、resizable、command(cmdk)、calendar(react-day-picker v9)、table(`noWrapper`/sticky head)、avatar + CrossfadeAvatar + AvatarGroup(max+N 溢出)、empty(EmptyMedia variant default/icon)、sonner toast 容器(依赖 renderer ThemeContext,上提需改 prop 注入)。

### 2b. 复合技术组件

- DataTable(`data-table.tsx`:TanStack 封装,排序/过滤/分页/树形/列宽拖拽 + SortableHeader)。
- SortableList(dnd-kit + SmartPointerSensor)、EntityList/EntityRow/EntityPanel(泛型列表:分组/折叠/多选/长按手势状态机 `long-press-state.ts`)、EntityIcon(emoji/file/fallback 三态,消费 `@polo-ai/shared/icons` 尺寸阶梯)。
- styled-context-menu(与 StyledDropdown 同风格双生子,应同去留)、menu-context(同一菜单内容 Dropdown/ContextMenu 双栖)。
- HeaderIconButton / PanelHeaderCenterButton / TopBarButton(含 `titlebar-no-drag` Electron 语义)、HeaderMenu、RenameDialog、MetadataBadge、EntityListBadge、EntityListEmptyScreen、FadingText、GradientResizeHandle/HorizontalResizeHandle(+ useResizeGradient hooks)、client-workbench.ts(POO-70 共享 class 令牌:Dialog/Menu/Button 三套常量)。
- drawer/styled-dropdown/window-header-badge 为 `@polo-ai/ui` 的 shim(规避根 barrel 的 react-pdf worker bundler 差异)。

### 2c. 领域耦合件(不建议上提)

EditPopover(1166 行,设置"迷你 agent"编辑 + EditContext 注册表)、RichTextInput(819 行 contenteditable)、InlineMentionMenu(@联想,766 行)、InlineSlashMenu(/命令,721 行)、InlineLabelMenu(#标签)、LabelValuePopover/LabelBadgeRow/LabelIcon、MentionBadge、SourceAvatar/SkillAvatar/StatusIcon/ServiceLogo、SourceStatusIndicator、Compact\*(触屏抽屉形态配对:CompactSourceSelector↔SourceSelectorPopover、CompactWorkingDirectorySelector)。

### 2d. UI 强相关通用 hooks(renderer `hooks/`)

useRovingTabIndex、useFocusZone、useEntityListInteractions、useMultiSelect(纯函数状态机)、useEntitySelection/createEntitySelection(jotai 工厂)、useContainerWidth、useDynamicStack、useResizablePanels、useDirectoryPicker、useTheme、useWindowCloseHandler、useWorkspaceIcon、useLinkInterceptor。toast 无 hook 封装(`sonner` 直接 import,44 文件)。

### 2e. playground

`renderer/playground/`(独立入口 playground.html):registry 协议(`ComponentEntry`:props 定义/variants/mockData/wrapper)+ 可调尺寸预览 + 变体控件生成器 + 15 预设配色主题;24 注册模块 23 分类;mock `window.electronAPI`。是组件文档化的现成基础设施。

## 3. Icon 体系

四种模式并存,**无统一签名、components/icons 无 barrel**:

| 模式 | 规模 | 说明 |
|---|---|---|
| lucide-react 直接 import | 158 文件 / 134 图标 | 主体;高频:Check(32)、ChevronDown(22)、X(19)、Trash2(15)、ChevronRight(15) |
| 自定义内联 SVG 组件 | `components/icons/` 10 文件 / 约 28 导出 | `SVGProps` 无 size prop;含品牌(PoloAiLogo 与 PoloAiSymbol 逐字节重复)、导航(PanelLeft/RigthRounded)、状态(TodoStateIcons 7 个)、语义包装(SettingsIcons 11 个 + 映射表) |
| packages/ui 图标 | 3 个(Icon_Folder/Home/Inbox) | `SVGProps + size`;Lucide 2-22 bounds + strokeWidth 2 规范 |
| 静态 SVG 资产 + 运行时实体图标 | `renderer/assets/provider-icons`(14)/`messaging-icons`(3)/logo;EntityIcon + useEntityIcon(icon-cache)+ IconSize xs~xl 阶梯 | 品牌图标写死颜色 32px;实体图标 emoji/file-SVG/rawSvg(currentColor) |

一致性问题:三套尺寸约定(IconSize 阶梯 / 数字 size / 裸 Tailwind,`h-3.5 w-3.5` 245 次 vs `size-4` 65 次);strokeWidth 散乱(1.5×23、1.75、2.4、3;`var(--background,white)` 反色 hack);命名四类并行(lucide 裸名 / 裸名 / `Icon_` 前缀 / `*Icon` 后缀)。

死代码:ConnectionIcon.tsx、PanelRightRounded.tsx、PoloAiAppIcon.tsx、TodoStateIcons.tsx(其图形以 SVG 字符串活在 `packages/shared/src/statuses/default-icons.ts:13-45`,双份真相)。

建议:以 packages/ui `IconProps` 为唯一签名;补 `components/icons/index.ts` barrel;size 统一走 `IconSize/ICON_SIZE_CLASSES`;定义 strokeWidth token;品牌资产独立 `brand-icons/` 语义分层(不参与 currentColor)。

## 4. 业务组件 — 客户端产品面(skill modules 对应生产落点)

skill 的 10 个组件与生产代码的交叉映射(token 桥梁:`renderer/lib/client-workbench-style.ts` 用 Vite `?raw` import skill 两个 token CSS,解析 `:root` 变量生成派生别名,light 冻结/dark 回退全局主题;`components/ui/client-workbench.ts` 提供 Dialog/Menu/Button 组合类常量):

| skill 组件 | 生产落点 | 备注 |
|---|---|---|
| 登录表单 | `components/onboarding/AdminLoginStep.tsx:96`(+ PhoneAuthStep/MethodSwitch/AgreementClause/TrustRow) | `.login-split` 语义 Tailwind 化;focus `0 0 0 3px var(--accent-soft)` |
| 工作台顶栏 | `components/app-shell/TopBar.tsx:86` + `product-space/ProductSpaceSwitcher.tsx` + `TransportConnectionBanner` | 毛玻璃 64px、hairline 由 `context/ClientPageContext.registerMainScroller` 驱动(workbench-header-scroll.js 的生产等价) |
| 工作区布局 | 各页根 main:`tab-browser/HomePage.tsx:488-491`、`circles/MyCirclesPage.tsx:303-306`、`circles/CircleDetailPage.tsx:420-432`、`circles/ClientHomeRouter.tsx:99-104` | `max-w-[1260px]` + 断点 padding 样板重复 4 次,建议抽 WorkbenchPageMain |
| 应用卡 | `components/tab-browser/MemberAppCard.tsx:58`(variant home/detail) | 42px icon/`--accent-soft`、hover 上浮 1px;退役双胞胎 AllAppsView/OrganizationAppCard/ManageHomeAppsDialog/AppIcon 仅测试引用 |
| 首页目录 | `components/tab-browser/HomePage.tsx:193` | H1 projection + 搜索/筛选/排序 + 9 种系统态分区 |
| 圈子统一列表 | `circles/MyCirclesPage.tsx:225` + `MemberCircleRow.tsx:72` | 免费/月/年/受限同一行结构;头像 tone 类 color-mix |
| 圈子详情分区 | `circles/CircleDetailPage.tsx:258` + Content/Updates/Subscription/SupportPanel + CircleSkillSummary | 价格/周期/有效期各一次;退出仅订阅区 |
| 确认对话框 | `circles/LeaveCircleDialog.tsx:42` | edge 14px + shadow-panel;last-source 影响清单;busy 期禁 cancel |
| 系统态与恢复 | `product-space/ProductSpacePreparationScreen/ErrorScreen/ContractGate/WindowWidthGuard`、`ProductSpaceSwitchDialog.tsx:24`(六相进度) | space-switch-*.js 的生产等价;circle-membership-feedback.js 等价 = MemberCircleResourceContext 回执投影 |
| 浏览器交接 | `tab-browser/WebAppView.tsx`(new-window → electronAPI.openUrl)+ CircleReturnPanel(C8 回访核对) | 不复制网页业务 |

其他产品面组件:`tab-browser/TabShell.tsx:27`/`TabContent.tsx:54`(标签壳/深链/快捷键)、`ProductSpaceAppLaunchBridge`(启动凭据不进持久 tab)、`app-menu/`(Desktop/Mobile 双端菜单,schema 驱动单一真源)。

## 5. 业务组件 — 助手面(D-ASSISTANT-REUSE:renderer 为准)

- 壳:`app-shell/`(40+ 文件:AppShell 3565 行、LeftSidebar、SessionList、ChatDisplay 约 2300 行、NavigatorPanel、Panel/PanelHeader/PanelResizeSash、ActiveTasksBar、CompactSessionMenu/SessionMenu、FabNewChat、MultiSelectPanel 等)。
- 会话内嵌卡:`chat/AuthRequestCard.tsx`(授权卡:单值/Basic/multi-header/OAuth 四形态,pending/completed/cancelled/failed 状态机,非交互折叠单行)、`chat/EmptyStateHint.tsx`(空会话提示 + 内联实体徽章)。
- 消息平台:`messaging/`(MessagingDialogHost 三态 atom、PairingCodeDialog 与 TelegramSupergroupPairingDialog ~80% 同构、Telegram/LarkConnectDialog 同构 Test→Save 门控、WhatsApp QR 状态机、access/ 访问控制 5 组件)。
- Markdown/代码:`markdown/StreamingMarkdown.tsx:139`(分块 djb2 hash memo,仅尾块重渲)、`shiki/` 3 个 wrapper(当前无 importer,待清理或接线)。
- 权限/工具呈现:packages/ui TurnCard 体系 + ChatDisplay 内 MemoizedAuthRequestCard。

## 6. 业务组件 — 设置/引导/自动化/信息页

- `settings/`(14 文件,约 30 导出):SettingsSection/Group/Card/Row/Toggle/RadioGroup(RadioCard 选中展开)/SegmentedControl/Select/MenuSelect(>8 项自动搜索)/Input/SecretInput/Textarea + settingsUI 常量;消费方 `pages/settings/*` 13 页(自动保存 500ms debounce,无保存指示)。
- `onboarding/`(16 文件):OnboardingWizard 状态机(useOnboarding)+ StepFormLayout/StepIcon/StepHeader/StepActions/BackButton/ContinueButton 骨架 + 各步骤(Welcome/ProviderSelect/APISetup/Credentials/LocalModel/Completion/GitBashWarning/AdminLogin/PhoneAuth/Reauth/AdminKicked)。
- `automations/`(15 文件):AutomationsListPanel(EntityRow 体系)、AutomationInfoPage(Info_Page 六节)、AutomationEventTimeline、AutomationMenu/BatchAutomationMenu、AutomationAvatar、PhaseBadge;CronBuilder 与 AutomationCard 仅 playground 引用。
- `info/`(13 文件):Info_Page(loading/error/empty 三态壳)/Info_Section/Info_Table/Info_DataTable/Info_Alert(四色)/Info_Badge/Info_GroupedList/Info_Markdown + 4 个类型化 DataTable(Permissions/Tools/Labels/AutoRules)。
- `right-sidebar/SessionFilesSection.tsx`(621 行,文件树复刻 LeftSidebar 连接线/stagger)、`apisetup/ApiKeyInput.tsx`(831 行,20+ Provider 预设)+ OAuthConnect、`workspace/`(8 文件,工作区向导)。

## 7. 设计 token 与样式架构

两套并存,同名变量不同值,不可混用:

| 维度 | renderer `index.css`(1563 行,助手/全局) | skill `workbench-base.css`+`review.css`(产品面权威) |
|---|---|---|
| 色彩 | oklch 相对色 + color-mix 派生(`--background: oklch(0.98 0.003 265)`、`--accent: oklch(0.62 0.13 293)`、灰阶 `--foreground-1.5..95`) | 十六进制(`--background:#fbfbfa`、`--foreground:#17181a`、`--accent:#6e56cf`、`--info:#3275d8`、灰阶 `--fg-3..80`) |
| Dark | `.dark` class | `[data-theme="dark"]`(令牌存在,未验收) |
| 圆角 | 全局 `--radius:0`,组件级类 | 8 档 `--radius-xs..pill`(4/6/8/10/12/14/20/9999) |
| 阴影 | 多层环+模糊(`--foreground-rgb` 驱动,10 个批准类) | 两层实影 `--shadow-minimal/middle/panel` |
| z-index | 16 档 `--z-base..--z-splash`(0-600,ESLint no-hardcoded-z-index 强制) | 类内裸值 20/30/50/80/90 |
| 断点 | 容器查询 448/768px | 媒体查询 1080/760/640(+850/1050) |
| 字体 | sans 系统栈;mono JetBrains Mono 打头 | 系统栈;mono ui-monospace/SF Mono;html 15px(两者一致) |

桥梁:`lib/client-workbench-style.ts`(`?raw` import + 正则解析 + 派生别名 `--card/--popover/--muted/--primary/--shadow-modal-small→--shadow-panel` 等;缺 `--surface/--shadow-panel` 即抛错)。packages/ui `styles/index.css` 是第三份等价主题(仅 apps/viewer `@import` 消费),与 renderer 已漂移(Light accent `oklch(0.58 0.22 293)` vs `oklch(0.62 0.13 293)` 等),存在双份维护风险。POO-41 门控区(`[data-testid='home-app-hub']` 等三处)有作用域覆盖:`--accent:#6e56cf`(与 skill 一致)。批准阴影白名单(no-nonstandard-shadows):shadow-none/minimal/tinted/thin/middle/strong/panel-focused/modal-small/bottom-border/bottom-border-thin。

## 8. 组件化机会(优先级排序)

1. **WorkbenchPageMain**:main 容器样板(1260px + 断点 padding + scroller 注册)重复 4 次。
2. **AsyncContent(loading/error/empty/children)**:至少 5 处独立实现(Info_Page/Info_DataTable/Info_GroupedList/FileViewer/AutomationsListPanel)。
3. **InputShell/SecretInput**:输入壳 + 眼睛切换重复 6+ 次(settings 已有,onboarding/apisetup 未复用);`clientWorkbenchFieldClassName` 登录字段 focus 样式亦重复。
4. **SectionHeader**:SettingsSection ≈ Info_Section ≈ CronBuilder/AutomationCard 小节头三变体。
5. **WorkbenchBanner/WorkbenchEmptyState**:danger/info 横幅三元组与空态卡在产品面 10+ 处内联。
6. **内联菜单常量统一**:五份 MENU_*_STYLE 重复,packages/ui InlineMenuSurface 已 headless 但 renderer 零引用。
7. **PairingCodeBody / CredentialTestDialog**:配对码与凭据测试两对双胞胎(含逐行相同的倒计时 interval)。
8. **TreeView**:SessionFilesSection 整段复刻 LeftSidebar。
9. **CopyButton + useCopied**:3 处复制按钮/PatternBadge 双实现。
10. **ChoiceCard**:RadioCard/ProviderSelect/OptionButton 同视觉;SegmentedControl 手写 3 份。
11. **Dropdown 收敛**:SimpleDropdown(手写 fixed)→ StyledDropdown(Radix);styled-context-menu 随迁 packages/ui。
12. **基础原语上提**:renderer ui/ A 组 ~20 个原子件下沉 packages/ui(需随迁 `popover-styled`/`--z-*` token;sonner 需解 ThemeContext 依赖)。
13. **Icon 统一签名 + barrel + 尺寸/描边 token**(见 §3)。
14. **useAutosave(debounce+flush+脏检查)**:PreferencesPage 模式可被 14 个设置页复用;表单保存反馈三态(静默/status/toast)统一。
15. **徽章收敛**:MicroBadge vs Info_Badge vs ui/Badge 三套 → Info_Badge size 变体。

## 9. 死代码与待复核清单

- 死代码(0 生产引用):`components/files/FileViewer.tsx`、`components/preview/TableOfContents.tsx`、`settings/SearchableModelInput.tsx`、`settings/SettingsEditRow.tsx`(且未导出)、icons 4 文件(见 §3)、tab-browser 退役 4 文件(AllAppsView/ManageHomeAppsDialog/OrganizationAppCard/AppIcon,仅测试引用)、`shiki/` 3 wrapper 无 importer、`InlineSkillMention` @deprecated。
- 待复核:①「管理技能页面暂缓」(SKILL.md Prototype guidance / D-ASSISTANT-REUSE)与 `product-space/ProductSpaceSkillsDialog.tsx` 已存在的现状;② modules 声明与 paths 实际覆盖面的口径;③ Themes: light 单一声明 vs dark 令牌存在(polo-chat-options 演示含 dark);④ 800×600 回归口径 vs `WindowWidthGuard` ≤640px fail-closed;⑤ packages/ui styles 与 renderer index.css 双份主题漂移;⑥ design-demos 三目录(polo-chat-options=POO-50 提案、polo-client-source-baseline=2026-08-10 基线、polo-stage4-change-map=旧 oklch mock)均非设计 authority,引用时只当静态材料(chat-options manifest source root 指向外部机器路径)。

## 10. 统计总览

- packages/ui:约 108 个组件导出(浮层 29、菜单/按钮 14、markdown 28、chat 6、反馈 5、布局 4、其他领域 22)+ context 2 + lib 若干。
- renderer components/ui:74 文件(原子基元 ~24、复合 ~25、领域耦合 ~20、常量/shim 5)。
- Icon:lucide 134 个(158 文件)/ 自定义 28 个 / packages/ui 3 个 / 品牌资产 17 个。
- 业务组件目录:28 个子目录;产品面 10 个 skill 组件全部有生产落点;助手面、设置面、自动化面、messaging 面各有 8-40+ 组件。
- 设计 token:renderer 16 档 z-index、10 个批准阴影、oklch 6 色系;skill 8 档圆角、3 档阴影、hex 语义色、字号 9-38px 15 档。
