# Worksheet — 设计系统组件化抽取与 Skill 更新

- 基线:分支 `dev` @ `e7c0e6bd`(Merge bundled CLI, SDK and Python app runtime into dev)
- 日期:2026-10-18
- 执行方式:主 agent 统筹,8 个子 agent(GLM-5.3,会话模型)并行只读探索,主 agent 汇总落盘
- 仓库:polo-ai(Electron Mac App:`apps/electron`,共享组件库 `packages/ui`,设计系统 skill:`.agents/skills/polo-ai-design-system`)

## 目标(来自用户指令,拆解为可验收项)

| # | 要求 | 验收口径 | 状态 |
|---|------|----------|------|
| G1 | 基于 dev 创建 worksheet | 本文件存在且记录基线/任务/结果 | ✅ 进行中 |
| G2 | 派尽量多的子 agent 并行探索仓库(Mac App 代码) | ≥6 个并行 Explore agent,覆盖 renderer/packages/ui/skill/docs | ⏳ |
| G3 | 汇总更新设计系统 skill | `.agents/skills/polo-ai-design-system/SKILL.md` 增加当前代码库组件盘点与更新说明,保留既有 decision/hash 绑定 | ⏳ |
| G4 | 组件化:技术组件(含 Icon)+ 业务组件抽取封装 | 产出组件清单(名称/来源/契约),技术组件与业务组件分层 | ⏳ |
| G5 | 最终做成一个 HTML | 自包含组件库展示页(真实 token 值驱动),可浏览器直接打开 | ⏳ |

## 子 agent 分工(并行,只读)

| Agent | 探索范围 | 产出 |
|-------|----------|------|
| A1 | `packages/ui`(Radix+Tailwind 共享库全量) | 技术组件清单+变体+样式模式 |
| A2 | `apps/electron/src/renderer/components/ui` + 顶层共享组件 + playground | renderer 侧基础技术组件清单 |
| A3 | `apps/electron/src/renderer/components/icons` + 图标使用模式 | Icon 体系盘点(数量/风格/命名/缺口) |
| A4 | `components/chat` + `messaging` + `markdown` + `shiki` | 会话/消息类业务组件清单 |
| A5 | `circles` + `product-space` + `workspace` + `app-shell` + `tab-browser` + `browser` | 客户端产品壳与圈子类业务组件清单 |
| A6 | `settings` + `right-sidebar` + `onboarding` + `automations` + `files` + `preview` + `apisetup` + `info` + `app-menu` | 设置/侧栏/文件类业务组件清单 |
| A7 | 设计 token 体系:index.css、tailwind 配置、packages/ui/styles、z-index/阴影 token | token 清单与样式架构结论 |
| A8 | 设计系统 skill 全目录 + spec §13.8–13.13 + mvp-complete-flow-hifi + design-demos | skill 覆盖面 vs dev 现状差距(更新建议) |

## 汇总产出计划

1. 组件清单落盘:`.agents/skills/polo-ai-design-system/references/component-inventory.md`(skill 内,不建第二设计目录,生产组件只引用不复制)。
2. Skill 更新:SKILL.md 增加"当前代码库组件盘点"章节指向上述清单,记录本次探索证据;不动既有 authority/decision/hash。
3. 组件库 HTML:`docs/reports/2026-10-18-polo-design-component-library.html`,分「设计 token / 技术组件(含 Icon)/ 业务组件」三区,样式值取自 skill 权威 token CSS。

## 结果记录(2026-10-18 回填)

### 探索结论要点(8 个子 agent,均 GLM-5.3)

- **packages/ui(A1)**:约 108 个组件导出;Tailwind v4 CSS-first,无 tailwind.config,无 cva;Radix 仅 4 处;浮层 29(Island 自研框架 + dismissible-layer-bridge)、markdown 28、chat 6;Spinner 引用 34 次为最高频;基础表单原子(Input/Select/Switch 等)只存在于 electron 侧未共享。
- **renderer ui(A2)**:74 文件;shadcn 式原子 ~24(button 用 cva)+ 复合件 ~25(DataTable/SortableList/EntityList/EntityRow/EntityPanel)+ 领域耦合 ~20;playground 是现成的组件文档化基础设施(registry 协议)。
- **Icon(A3)**:四种模式并存(lucide 158 文件/134 图标为主体 + 自定义 28 + packages/ui 3 + 品牌 17);无统一签名、无 barrel、尺寸/描边/命名三重不一致;4 个死文件。
- **chat/messaging(A4)**:AuthRequestCard 四形态状态机;PairingCode/TelegramSupergroup ~80% 同构、Telegram/LarkConnect 同构;StreamingMarkdown 分块 hash-memo;shiki/ 3 个 wrapper 无 importer。
- **产品壳/圈子(A5)**:skill 10 个组件全部找到生产落点(TopBar/HomePage/MemberAppCard/MyCirclesPage/MemberCircleRow/CircleDetailPage/LeaveCircleDialog/ProductSpaceSwitch* 等);token 桥梁 = `lib/client-workbench-style.ts`(?raw 消费 skill CSS);main 容器样板重复 4 次;tab-browser 4 个退役文件。
- **设置等目录(A6)**:settings 13 原语 + 13 页(500ms 自动保存);onboarding 状态机外置;async 三态 ≥5 处、输入壳 ≥6 处、SectionHeader 三变体等重复模式;files/preview 死代码。
- **token(A7)**:两套体系对照表成型(oklch 相对色 vs hex 权威);z-index 16 档、批准阴影 10 类、圆角 8 档注册表;packages/ui styles 与 renderer 已漂移(第三份主题)。
- **skill 差距(A8)**:8 个 hash 绑定源全部验证无漂移;必须保留 5 个 decision 与 hash 链;「管理技能页面暂缓」与 ProductSpaceSkillsDialog 现实冲突列为待复核;design-demos 三目录均非 authority。

### Skill 更新(已完成)

- 新增 `.agents/skills/polo-ai-design-system/references/component-inventory.md`(§1-§10:技术组件/Icon/业务面/token/组件化机会 15 条/死代码与待复核/统计)。
- SKILL.md 新增「Production component inventory」章节(+7 行):登记只读边界、skill 组件↔生产落点映射、展示产物声明;未动 Sources/Decisions/hash/生命周期规则。
- 再生成:因本机无 node_modules 且 build_review.py 的 vite 路径写死(作者机器布局),按生成器同款逻辑外科手术式刷新 digest 链(manifest `design.sha256` + prototype/review.html 内嵌副本 + consumer `source_manifest_sha256`)。
- 校验:`check_design_system.py` ok=true(12 源、10 组件、51 消费场景,0 错误);`validate_unified.py` passed=true 256/256。

### 组件库 HTML(已交付)

- `docs/reports/2026-10-18-polo-design-component-library.html`(约 123KB,自包含,无外部依赖)。
- 结构:①设计令牌(色彩/圆角/阴影/字号/z-index 与断点注册表,值逐字取自 workbench 权威 CSS,含 dark 预览开关)②Icon 体系(JS 注册表 ~60 枚统一签名渲染 + 搜索 + 尺寸/描边切换 + 品牌彩色图标)③技术组件(按钮/输入/徽标横幅/菜单弹层 Toast/头像/分段开关进度/空状态)④业务组件(登录分屏卡/顶栏滚动发丝线交互/首页目录+应用卡/圈子列表四 tone/圈子详情分区订阅/退出确认对话框/系统态与空间切换/助手会话与工具卡/Composer/授权卡/配对码/设置面)⑤清单与统计(规模统计/关键组件索引/15 条组件化机会/两套令牌对照/死代码与待复核)。
- 校验:HTML 良构(HTMLParser 0 错误)、JS `node --check` 通过、JS 引用的元素 ID 全部存在、data-icon 引用全部在注册表内。

## 完成审计

- [x] G1 worksheet 存在且已回填结果(本文件)
- [x] G2 并行探索已执行:8 个 Explore 子 agent(单轮并行派发,覆盖 packages/ui、renderer ui、icons、chat/messaging、产品壳/圈子、设置类目录、token、skill/docs)
- [x] G3 skill 已更新:component-inventory.md 新增 + SKILL.md 章节,digest 链再生成,check/validate 双绿;既有 authority/decision/hash 未破坏
- [x] G4 组件清单覆盖技术+Icon+业务组件并标注来源 file:line(component-inventory.md §1-§6;HTML §5 摘要)
- [x] G5 HTML 已生成:docs/reports/2026-10-18-polo-design-component-library.html,浏览器直接打开,真实 token 值驱动,结构/JS 校验通过
