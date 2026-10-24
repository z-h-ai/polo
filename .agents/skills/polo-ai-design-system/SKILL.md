---
name: polo-ai-design-system
description: Apply the polo-ai repository design system within its declared platform, module, and path scope. Use only after verifying the bound sources remain current.
---

# polo-ai Design System

Adoption revision: `native-materials-r5-lifecycle-candidate-20261023`. Mode: `extracted`.

## Applicability

- Repository: `polo-ai`
- Paths: `apps/electron/src/renderer`, `apps/electron/src/main`, `apps/electron/src/preload`, `docs/mvp-complete-flow-hifi`, `.agents/skills/polo-ai-design-system`
- Platforms: desktop-electron
- Modules: 登录与自动注册、外层顶栏、首页应用目录、我的圈子及圈子详情；main/preload仅对应受信交接，不定义业务页视觉

If repository identity or path scope does not match, do not apply this Skill. Read [the bound design model](references/design-system.json) and verify its sources before high-fidelity work.

## Start a new requirement

Read the [native reuse guide](<references/native-reuse.md>) for applicability, coverage and gaps. Find a matching page or region first, then actual components, then variables. Follow existing repository routing; this is the single project design Skill entry.
Implementation reuse coverage can extend beyond confirmed design scope. Distinguish current implementation, confirmed design, task candidate and version-labelled history. Preserve the selected theme, providers, CSS cascade and assets; do not mix style systems.

- [Page / region baselines](<references/page-baselines.md>) — coverage/gaps, applicability, browsing entry, editable native source, reuse and regeneration/check commands.
- [Real components and variants](<references/component-usage.md>) — coverage/gaps, applicability, browsing entry, editable native source, reuse and regeneration/check commands.
- [Variables and style preview](<references/style-usage.md>) — coverage/gaps, applicability, browsing entry, editable native source, reuse and regeneration/check commands.

Create an editable task-local candidate from the native scene/composition using the guide and existing project tools. Keep layout, imports, providers, styles, assets and fixtures; implement only the requirement delta. Generated HTML is an export. Production edits are a separate authorized implementation step.
A Placeholder is allowed only for an unchanged region that cannot be reproduced. Name its source and gap. Never hide the requested change, required entry/back path or resulting state behind a Placeholder.
Source-binding checks establish source consistency only. When actual material inputs change, reconcile their semantic impact, regenerate affected material with its native tool, and check real inputs, outputs and reproduction separately. Never refresh hashes to disguise an old export. Browser fidelity and independent consumption require their own evidence.
At final main integration (before acceptance is sealed) and before a new task locks its source baseline, check actual material inputs and outputs using the native reuse guide. Both workflow hooks call this same project Skill. Current material is reused; stale material requires source reconciliation, native regeneration and verification before dependent work. A CI artifact is not an adopted repository update.
Maintenance can create local Git changes but never authorizes commit, push, version bumps, tags, release-finish or deployment. Include adopted materials in the same integration candidate; task-start repairs stay isolated until adopted. Recheck conflict-resolved inputs before publication. Use consumed bytes, not HEAD equality, to avoid a material-only commit triggering another refresh.

## Sources

- `docs/client-journey-review/spec.md` — authority; 当前产品唯一来源；沿用既有视觉确认，D-PC-15 多空间登录确认仅按当前Spec适用，独立基线场景缺口另列; SHA-256 `c191aa04cd35abc5917451f421785ff053bf5b9183c2b6282f15a86c74e78d5e`
- `.agents/skills/polo-ai-design-system/references/foundations.md` — authority; 本次原型提取与消费边界；明确确认/实现事实/待复看范围; SHA-256 `64c5dddd0bef2af4f5a2a648f8b5af3a7d5a26d06f7a8d5fade051909c25e90d`
- `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css` — authority; b82fa1e5 基础样式，按最新原型逐字节提取；当前外层工作台样式维护源; SHA-256 `fe5bfc320c7345ee5f22c400c51dd9f69049b6a9090b286ee31de5f7b244a20a`
- `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css` — authority; 导航/Header、首页、统一圈子列表及 POO-105 微透材质增量；按最终CSS cascade消费; SHA-256 `be4d7f7d4ae96ee18e06ce3976fc737fdaeefbdd29a479a31c1a4ff15f130a70`
- `apps/electron/src/renderer/index.css` — implementation; 本轮工作树Renderer样式事实；不是发布版或新的产品设计授权; SHA-256 `b3dabc1562cf3a91e45f055935ff749183e87b75a0d9a8158a67948a1cf8eeeb`
- `docs/mvp-complete-flow-hifi/sources/g4-product.css` — implementation; POO-41 ef3528ef 历史冻结样式；不覆盖当前Spec; SHA-256 `fe62101ae60d6a11021f98af04e20b1eba97920eb41d7f49d4f9751dd6bb0218`
- `docs/mvp-complete-flow-hifi/sources/g4-review-record.md` — implementation; 2026-08-11 历史冻结范围记录，非当前全页Acceptance; SHA-256 `56fdd07ddaf3f5525736b124cac3cdc14ecb6953703283f0a09730effdbd7843`
- `docs/mvp-complete-flow-hifi/sources/renderer-index.css` — implementation; 01f4447c固定Renderer快照，只作历史比较; SHA-256 `964e3744691aeea9aa3f94f5084c4405a97ac046a0e8f348b13241fe4c2bbfaf`
- `.agents/skills/polo-ai-design-system/assets/components/workbench-header-scroll.js` — implementation; 原型共享行为脚本；生产须接真实状态/服务，不移植模拟结果; SHA-256 `56eb0f05806951543eaaf4c0033c7fcc08eae3336ca6010794776f6ca97ab409`
- `.agents/skills/polo-ai-design-system/assets/components/space-switch-sequence.js` — implementation; 原型共享行为脚本；生产须接真实状态/服务，不移植模拟结果; SHA-256 `a5de1ede777f48032a3d945983bd987c28e42a6cd1f2efd5852e1f8c35a7ab73`
- `.agents/skills/polo-ai-design-system/assets/components/space-switch-progress.js` — implementation; 原型共享行为脚本；生产须接真实状态/服务，不移植模拟结果; SHA-256 `dda528141636c0253fe70afaeeb23a9919aa8264e562d63235c77316a6248de7`
- `.agents/skills/polo-ai-design-system/assets/components/circle-membership-feedback.js` — implementation; 原型共享行为脚本；生产须接真实状态/服务，不移植模拟结果; SHA-256 `b26fcc98fb62dc2d9ee91ddbed21a5bd83a23f830b9acea9028a40f747934808`
- `.agents/skills/polo-ai-design-system/references/usage-playbook.md` — authority; 新需求实施流程手册：当前实现基线→真实组件→设计变量的复用顺序、当前基线与目标设计分层、范围外降级路径、Placeholder 规则、常见坑; SHA-256 `2806d1d3120a96b2c72eb0f9745532f0cfeb8cc594918b3f9ed976ed5732b9c1`
- `.agents/skills/polo-ai-design-system/references/page-baselines.md` — authority; 页面/区域高保真基线索引：当前实现基线与目标设计模板分层、场景ID→打开方式→生产落点；覆盖缺口明确列出; SHA-256 `1f8f5207d773719b1ea9806adc4567fbaf0c364d9c45e540bd3b9eb1ad4efbb4`
- `.agents/skills/polo-ai-design-system/references/component-usage.md` — authority; 组件素材索引：playground 与基线画廊双通道可再生展示注册、生产落点、token 桥梁；非权威素材边界; SHA-256 `571019ba393a2d1d1bb6f13cffed31704ac03697a7faa83a94c965b78986edbe`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/vite.config.mjs` — implementation; 当前实现基线生成器：vite 配置（alias @→renderer 源码，单文件内联，模块图与 watch 文件收集入输入指纹，确定性构建无时间戳）; SHA-256 `8ee2ead08fa1bcce8c2cea675fea02e15e989cc2d42c2461c07cc14194e452f4`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/vite.scene-ids.config.mjs` — implementation; 场景清单 SSR 提取构建（ssr noExternal 全打包，单 cjs 输出）; SHA-256 `eff52dc6b1854c66cddd6242ad42735092cece0c77a2b197b160caf5e6b03252`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/scene-ids-runner.cjs` — implementation; happy-dom 下执行场景清单 SSR bundle，stdout 输出 JSON 行（只求值模块作用域，不渲染组件）; SHA-256 `4af8277faaf90e266f9a5051f5379d8abde722fb0f9c187f598fd969de9f2975`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/tsconfig.json` — implementation; 基线入口真实类型检查配置（继承 apps/electron tsconfig，检查器强制跑通）; SHA-256 `fe55756c85d43c98d8776a79b18188dc89dbe873ebf6eb9b5e79ffc8b3f6e0e4`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/build.py` — implementation; 基线落位生成器：tsc→vite SSR 场景提取→浏览器单文件打包→落位 assets/source-baseline→manifest+统一入口；--out 保护非拥有目录；--check 校验真实输入指纹与输出逐字节再生; SHA-256 `aa3f8aeeb445244037df2da327bba32ac21323082de2c7096ae3916515837f36`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/entries/baseline.tsx` — implementation; 基线入口：Provider 栈+材质作用域+场景路由（?scene/#scene/pure），导出运行时场景 ID 清单供再生核对; SHA-256 `6033e00e1aa89a0e267b84b2df2e8a73117827d0db4bea703e32e149ae81b855`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/entries/scenes.tsx` — implementation; 基线场景注册表（组件画廊/登录/工作台整页/首页/圈子/助手/设置注册表子页+未登录独立态）；清单由真实模块求值机制化提取，与运行时集合强一致; SHA-256 `958a39ebee44cc66a3c674c69d0eaf5cdad27279c338e66d22ffc2d4d42b36ed`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/entries/gallery.tsx` — implementation; 第二层组件画廊：三组生产组件卡复用 playground 注册渲染协议，真实变体切换+生产落点索引；布局 guard 只抑制自动聚焦滚动，用户滚动立即接管; SHA-256 `3973d12d5b6356c1c3f7c3adcd3aaf805f7351dde4a1e0dbb098b0e4d5c3e227`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/entries/scene-ids.ts` — implementation; 场景清单提取入口：求值真实场景注册表模块并输出 ID/region/fullBleed JSON; SHA-256 `95ce8fbb7474bdb0fc408c7cc23ab6dd710f24374d794f896dea824e2b477b9f`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/entries/fixtures.tsx` — implementation; 受控 fixture：真实类型 satisfies+zod parse，只替换后端数据（正常态默认，写接口仅内存完成，不存任何 secret）; SHA-256 `d5c4761835f8a6a48425169e27abf2a50c518feabd6ecfbb8070705a40c4ee07`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/entries/baseline.css` — implementation; 基线浏览壳样式：@import renderer index.css + 本目录入口/场景/画廊的 Tailwind @source 扫描声明 + 仅基线文档的滚动覆盖; SHA-256 `3f708acb93832bbb1340748efaa4ae032b0eff163282f5e8c1c6ffb7e16e1cf6`
- `.agents/skills/polo-ai-design-system/tools/source-baseline/entries/baseline.html` — implementation; 基线 HTML 入口; SHA-256 `262b459b4a4778ebf03da8bed6e26e7dba9cb698241b6c827b427206225e22bc`
- `.agents/skills/polo-ai-design-system/references/native-reuse.md` — implementation; 当前实现复用范围与已确认设计范围分离；原生源码→任务内候选→预览/导出与环境入口; SHA-256 `34cc28424646e740e2cbcbb4482dacd09a93e50e74cd62fb869e6a7679ab7689`
- `.agents/skills/polo-ai-design-system/references/style-usage.md` — implementation; 工作台与renderer样式体系、变量预览、原生消费和再生方法; SHA-256 `0f87d6691a5436941a1fb1b0d57e640ae5d573d890618a3771897a24713e1887`

## Reuse

- Token family `颜色与语义派生色（完整CSS color）` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`; use its actual values rather than duplicating them here.
- Token family `系统字体栈与字号/字重/行高` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`; use its actual values rather than duplicating them here.
- Token family `圆角/阴影/层级` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`; use its actual values rather than duplicating them here.
- Token family `工作区尺寸/间距/密度/桌面断点` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css`; use its actual values rather than duplicating them here.
- Token family `当前导航与首页/圈子增量样式` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css`; use its actual values rather than duplicating them here.
- Token family `POO-105 默认浅色微透材质与前景令牌（--client-material-*）` comes from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css`; use its actual values rather than duplicating them here.
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
- `微透材质表面` from `.agents/skills/polo-ai-design-system/assets/tokens/workbench-review.css`: data-client-material=light 且非 dark 才生效；canvas/list/reading/card/brand 表面加 24px blur，前景与 placeholder 实色，真禁用实色灰；缺标记回落既有不透明样式

## Themes and viewports

- Themes: light
- `desktop-1440x900`: 1440 x 900
- `desktop-1024x768`: 1024 x 768
- `desktop-800x600`: 800 x 600

## Interaction states

- loading/preparing/submitting, empty/search-no-results, hover/focus-visible/disabled, error/retry/offline, expired/revoked/multi-source fallback, success/cancel/interruption, return to original circle/order with manual recheck

## Prototype guidance

- 最终 main 集成前和新任务锁定依据前，按 references/usage-playbook.md 的维护入口检查三层素材；检查只读，维护不自动 commit/push/tag/发版。
- 新需求先读 references/native-reuse.md：原生入口、任务内叶子副本/组合、providers与CSS扫描、独立依赖、真实预览和导出命令；assets是生成物，不手改、不静默改生产。
- 先读 references/foundations.md，产品行为读Spec；当前实现基线直接打开 assets/source-baseline/index.html（file:// 可开；场景直达 entries/baseline.html?scene=<ID>）；目标设计仍消费 docs/mvp-complete-flow-hifi/prototype.html 与主manifest，逐卡按scene定位，与当前基线分开使用。
- 实施流程按 references/usage-playbook.md：核实基线版本与范围→定位页面/区域→选择组件→消费变量→只修改必要区域→浏览器核验；新需求优先复用 Skill 内当前页面/区域基线，再真实组件，最后 token；旧目标设计按已确认范围另列，不覆盖当前实现基线。
- 当前实现基线（assets/source-baseline/）是 tools/source-baseline/build.py 的生成产物，不独立手改；含第二层组件画廊（components-gallery，三组生产组件卡与变体）与页面/区域场景目录，场景清单以 assets/source-baseline/baseline-manifest.json 为准；当前性由 build.py --check 按真实输入指纹与输出逐字节再生判定，--out 只写入该工具自有目录。
- 页面/区域基线与覆盖缺口索引读 references/page-baselines.md；仅未修改且无法复现区域可标 Placeholder；需求区及必需入口/返回/结果须完整原生复用，不得用历史画廊或快照冒充高保真；场景数量不是还原证明。
- 组件消费与可再生展示读 references/component-usage.md；第二层组件画廊离线浏览生产组件卡与变体（渲染协议与 playground 注册同源），playground（bun run electron:dev 后 :5173/playground.html）为完整交互调参台；assets/components/*.js 是原型行为脚本不是组件库。
- 设计变量浏览 assets/tokens/token-preview.html（由 tools/build-token-preview.py 从两份权威 token CSS 确定性生成，禁手改）；产品面 hex 与 renderer oklch 两套 token 体系不可混用。
- 最新原型是目标呈现；已确认风格/入口/文案与待复看整页布局分别记录。
- 仅维护Skill模板与样式；文档原型、消费manifest与兼容adoption是生成产物，不独立手改。
- 管理技能页面和Polo助手内部代码暂缓；真实助手UI继续复用Renderer，转译示意不能成为重写标准。
- 仅产品页面可进入客户端；review-shell按钮、模拟结果、虚构账号金额订单及第三方应用内部内容不进入生产。
- 未建立完整政策注册或生产parity绑定；来源/结构检查不证明execution_ready或业务验收。
- POO-105微透材质只在data-client-material=light且非dark的作用域消费：表面用--client-material-*加24px blur，前景/placeholder实色，真禁用实色灰；确认摘录见references/poo105-confirmation.md，固定快照与绑定见assets/prototypes/poo105-materials/。
- 生产组件盘点读references/component-inventory.md（2026-10-18 dev@e7c0e6bd只读登记）：modules之外的renderer面仅为登记不获得设计授权；skill组件与生产落点交叉映射在清单§4，token桥梁为apps/electron/src/renderer/lib/client-workbench-style.ts；配套展示docs/reports/2026-10-18-polo-design-component-library.html非权威。

## Checks

- `python3 docs/mvp-complete-flow-hifi/tools/check_design_system.py`
- `env VITE_BIN="$PWD/node_modules/.bin/vite" POLO_ELECTRON_ROOT="$PWD" python3 docs/mvp-complete-flow-hifi/tools/build_review.py`
- `POLO_REVIEW_EVIDENCE=/tmp/poo70-design-structure python3 docs/mvp-complete-flow-hifi/tools/validate_unified.py`
- `POLO_REVIEW_EVIDENCE="$(mktemp -d /tmp/polo-navigation.XXXXXX)" python3 docs/mvp-complete-flow-hifi/tools/check_navigation_header.py`
- `python3 .agents/skills/polo-ai-design-system/tools/build-token-preview.py`
- `python3 .agents/skills/polo-ai-design-system/tools/source-baseline/build.py --check`

## Decisions

- `D-CURRENT-STYLE` confirmed: Spec §13.10：b82fa1e5配色/风格替代初始r15灰黑方案；当前第一段CSS与该版本一致 (source `docs/client-journey-review/spec.md`)
- `D-NAV-HEADER` confirmed: Spec §13.9：去第二排资源Tab，圈子个人首页入口，管理技能在助手卡内，Header仅主体滚动后显示细线 (source `docs/client-journey-review/spec.md`)
- `D-HOME-CIRCLE` confirmed: Spec §13.11—13.13：我的应用标题、共享应用卡、圈子统一列表与详情文案去重、退出仅订阅区 (source `docs/client-journey-review/spec.md`)
- `D-ASSISTANT-REUSE` confirmed: Spec §13.11：真实助手UI复用当前Renderer；本批暂缓技能管理及助手内部应用代码 (source `.agents/skills/polo-ai-design-system/references/foundations.md`)
- `D-PAGE-VISUAL` confirmed: 布局与业务沿当前真实Renderer实现，不做整页视觉parity验收；页面视觉按已确认材质合同与b82fa1e5基线执行 (source `.agents/skills/polo-ai-design-system/references/foundations.md`)
- `D-POO105-MATERIAL` confirmed: Spec §13.14：默认浅色微透材质、Header与底板同层无滚动细线、前景/placeholder实色、选中accent 9%、真禁用实色灰；深色与第三方App不套用 (source `docs/client-journey-review/spec.md`)

When a bound source changes, locate affected rules and pages before refreshing this Skill. Preserve confirmations whose source and scope did not change.


## Design coverage

- color: explicit — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 已确认b82fa1e5色彩、当前增量cascade及POO-105 --client-material-*材质令牌（自基础色color-mix派生）；使用实际CSS颜色
- typography: explicit — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 源CSS定义字体/字号/行高阶梯；不能套全局新字体覆盖助手
- layout: derived — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 原型提取几何为目标实现事实，具体新组合布局待复看
- size: derived — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 控件/头像/工作区实际尺寸来自源CSS和最终cascade
- spacing: derived — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 组件内外间距读取源CSS/断点，不建立第二份数值表
- radius: explicit — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 源CSS radius与组件例外分别使用
- density: derived — .agents/skills/polo-ai-design-system/assets/tokens/workbench-base.css; 目录/卡片/统一圈子列表沿实际CSS；不恢复紧凑灰黑方案
- states: explicit — .agents/skills/polo-ai-design-system/references/foundations.md; loading/empty/error/recovery/focus/disabled与恢复合同明确；材质作用域内真禁用改实色灰表达，不用整容器opacity
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
- 微透材质表面: foundation, current; contract `.agents/skills/polo-ai-design-system/references/foundations.md`; replacement: none.

## Task-scoped native source

Use the native reuse guide above to locate the editable composition, its real imports, providers, styles and fixtures. Follow its project-owned preview/export commands from the declared cwd. No globally installed authoring Skill is needed to consume these materials.
Keep task-local candidate sources and generated exports distinct. Production modules remain in their owning paths; reuse their imports and current contracts.
