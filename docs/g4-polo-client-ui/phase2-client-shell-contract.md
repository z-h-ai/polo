# 任务合同：G4 Phase 2-A — Polo 客户端工作台壳层原型

> 用户原始诉求（原话）：根据计划 @docs/g4-ui-prototype-reimplementation-plan.md 实现 G4 四端高保真交互 HTML

## 1. 目标（为什么做 + 做成什么样）

G4 重新实现要求四个产品入口的 `index.html` 从 Phase 2 起就是**纯产品界面**（计划 §3.2 硬门禁）。本任务交付 Polo 客户端的整端产品壳层：工作台外壳 + 多应用 Tab + 首页，作为后续 11 条流程 After 汇入的骨架（Phase 5 的承载体）。

做成什么样：在 `/Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/design-demos/polo-client-g4-ui/` 下得到可在浏览器直接打开的 `index.html`（+ 共享 `assets/`），呈现一个可信的 Polo 桌面客户端工作台：顶部工作台栏、首页各分区、内置 App 入口、空间切换菜单、浅色/深色双主题。视觉严格遵循 `docs/four-end-design-foundation.md` 的客户端族参数（oklch 双核心派生、品牌紫 #5e17eb、悬浮面板语言）。

## 2. 验收标准（逐条可验证）

1. `index.html` 通过本地 HTTP 服务打开无控制台错误、无失败资源请求（用 Playwright/Chromium 实测，不允许"应该没问题"）。
2. 顶部工作台栏包含：空间切换入口（我的空间 + 一个企业空间示例）、应用 Tab 区、运行状态入口、通知入口、账号菜单。首页 Tab 固定不可关闭；打开第二个 App 出现新 Tab，重复打开回到已有 Tab（计划 §4.1）。
3. 首页按序呈现（计划 §4.3）：继续使用和最近打开 / 当前空间已添加的 Apps / 可添加的 Apps / Polo 内置应用（Polo 助手、文件、任务与结果）/ 当前空间可供 Polo 助手使用的 Skills / 最近结果与内容变化。Skills 明确标注"由 Polo 助手调用"，不伪装成 App（计划 §4.4）。
4. 空间菜单只出现"我的空间"和企业空间，不出现创作者圈子（计划 §4.2）；切换空间时首页内容整体替换（用前端状态模拟两个空间的不同目录）。
5. 浅色/深色主题可切换（账号菜单内），双主题下文字对比符合 foundation §2.3 规则（正文 ≥fg-60）。
6. 全部文案为正式中文，词汇遵循 `CONTEXT.md`（我的空间/企业空间/创作者圈子/Polo 助手等）；无 lorem ipsum、无"流程编号"、无评审/状态切换/来源说明等任何评审 UI。
7. 1440×900 与 1024×768 两种视口截图检查：布局不溢出、不错位；1024 下允许合理收紧但不截断关键操作。另加 390×844 窄窗口探针：呈现 foundation §7 的最小窗口保护态（明确的"窗口过窄"提示，不是移动端布局），截图存 `screenshots/`。
8. 文件全部使用本地相对路径；不引入任何 CDN（纯产品页面不依赖 AB 契约的 React CDN）。

## 3. 停止条件（遇到立即停下并在最终报告中说明）

- 需要修改 `design-demos/polo-client-g4-ui/` 目录之外的任何文件（`review-record.md` 和既有 `V2.html` 本任务不碰）。
- 计划文档与本合同冲突，或foundation doc 缺少做某组件所必需的 token。
- 任何需要"假装有后端"才能表达的交互（本任务是纯前端模拟，用内嵌 fixture 数据）。

## 4. 必读上下文（按此顺序）

1. `/Users/wow/project/z-h-ai/polo-admin-dir/POL-68/refactor/comm-defs/docs/g4-ui-prototype-reimplementation-plan.md` §3、§4（客户端产品结构全部小节）。
2. `/Users/wow/project/z-h-ai/polo-admin-dir/POL-68/refactor/comm-defs/docs/four-end-design-foundation.md`（全部 token 与组件契约）。
3. `/Users/wow/project/z-h-ai/polo-dir/dev/docs/DESIGN.md`（客户端视觉语言的 exact 来源）。
4. `/Users/wow/project/z-h-ai/polo-admin-dir/POL-68/refactor/comm-defs/CONTEXT.md`（产品词汇）。

## 5. MUST DO

- 单页应用式静态实现：`index.html` + `assets/product.css` + `assets/app.js`，原生 HTML/CSS/JS，无构建步骤。
- CSS 变量实现双主题（`:root` / `[data-theme="dark"]`），全部颜色经变量，不硬编码十六进制散落各处（变量定义处的 oklch 值除外）。
- 首页每个 App 卡片展示：名称、来源（Polo 内置 / 认证创作者·圈子名 / 企业内部导入）、状态（可使用/准备中/更新中/已停用/不可用）。
- 顶部运行状态入口展示一个"运行中"示例项；通知中心可从账号区打开、每条通知标注所属空间。
- 空间切换、Tab 开关、主题切换、通知中心、账号菜单都用原生 JS 真实可点（前端状态模拟，不造假后端请求）。
- 自检：用 `python3 -m http.server` 起本地服务 + Playwright（`/Users/wow/project/z-h-ai/polo-admin-dir/POL-68/refactor/comm-defs/node_modules` 里有 playwright 可 `node -e` 引用，Chrome 路径 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`）跑一遍：控制台零错误、资源零 404、两种视口截图存到 `design-demos/polo-client-g4-ui/screenshots/`。

## 6. MUST NOT DO

- 不在产品 HTML 中加入任何评审 UI：流程选择器、状态切换器（normal/empty/loading/failure/restricted）、场景参数面板、设计说明、来源标注、TODO 注释。
- 不实现 Skill 独立打开界面、不把圈子做成空间、不做全局左侧栏（计划 §4.1 明确无常驻左侧栏）。
- 不做登录页、不做平台级"继续工作/待人工确认"队列（计划 §4.3 明确不做）。
- 不修改生产代码、不动 git 提交、不新建 git 分支、不删除任何既有文件。
- 不使用 emoji 充当图标；图标用内联 SVG（线性、16px 基准）。
