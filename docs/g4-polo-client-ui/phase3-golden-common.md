# G4 Phase 3 黄金流程公共合同（四条流程共享，必须随流程附件一起读）

> 用户原始诉求（原话）：根据计划 @docs/g4-ui-prototype-reimplementation-plan.md 实现 G4 四端高保真交互 HTML

## 1. 目标

四条黄金流程（PC-F04 / ENT-F07 / CRE-F05 / OPS-F10）用于提前冻结四端公共视觉与交互语言（主计划 §7）。每条流程产出一个符合 AB 契约 + G4 补充契约的独立评审 bundle，Before 从冻结源码真实提取，After 按四端设计基础与壳层语言实现新设计。

## 2. 必读上下文（按序，全部必读）

1. 主计划 `/Users/wow/project/z-h-ai/polo-admin-dir/POL-68/refactor/comm-defs/docs/g4-ui-prototype-reimplementation-plan.md` §3、§6、§7、§9。
2. 设计基础 `/Users/wow/project/z-h-ai/polo-admin-dir/POL-68/refactor/comm-defs/docs/four-end-design-foundation.md`（token/组件/状态/权限表达规则，含追溯等级）。
3. 场景矩阵 `/Users/wow/project/z-h-ai/polo-admin-dir/POL-68/refactor/comm-defs/docs/g4-ui-prototype-scene-matrix.md`（§0 全局协议 + 本流程的场景集/角色/fixture/交互轨迹——**scene ID 必须逐字一致**）。
4. 契约补充 `/Users/wow/project/z-h-ai/polo-admin-dir/POL-68/refactor/comm-defs/docs/g4-ui-prototype-contracts-addendum.md`（§1 capability-gap、§3 hash、§4 产品 manifest）。
5. AB 契约 `/Users/wow/.agents/skills/ab-prototype/references/review-contract.md` 与 `/Users/wow/.agents/skills/ab-prototype/references/source-style-extraction.md`；模板 `/Users/wow/.agents/skills/ab-prototype/assets/prototype-template.html`、`comparison-template.html`。
6. 对应流程文档（comm-defs/docs/ 下四份 *-user-flows.md 中本流程全文）与 `CONTEXT.md` 词汇。
7. 对应端壳层产物（该端 `design-demos/<product>/index.html` + `assets/`）——After 的壳层语言必须与已验收壳层一致。

## 3. 输出结构（每条流程一个 bundle，自包含）

```
<产品目录>/flows/<flow-id-lowercase>/   # 如 flows/pc-f04
├── before.html
├── after.html
├── comparison.html
├── prototype-manifest.json
├── assets/
└── screenshots/
```

硬性规则：
- before/after 用 AB 模板，内嵌 `prototype-config`，支持 `scene`（+客户端 `theme`、`lang`）query 协议；管理端省略 themes/langs 键。
- 仅允许的远程 URL：React 18.3.1 / ReactDOM 18.3.1 / Babel 7.29.0 三个 unpkg 固定地址。其余全部本地相对路径，bundle 内自包含（禁止 `../` 逃逸）。
- **产品 HTML 零评审 UI**：before/after 内不得出现流程编号、场景/状态选择器、来源说明、设计说明、`review` 字样控件。场景只能靠 query 或真实产品交互触发。
- comparison.html 用模板生成，是唯一的评审工具页；视觉明确区别于产品。
- manifest：schemaVersion 1.0.0；states 为完整笛卡尔积；regions 四数组齐全；样式来源标 exact/derived/approximate；近似值进 approximations 且页面带 `approximate:<id>` 不可见标记；capability-gap 流程加 `beforeCapability` 块（addendum §1）。
- 文案全部正式中文（客户端 bundle 需支持 7 语言 query 切换，至少 zh-Hans 完整、en 完整，其余 5 语言可只翻关键导航与标题并在 manifest 声明）。

## 4. Before 提取规则

- 冻结源码根与 commit 见 phase0-baseline §1；只读，不修改、不运行 `npm install` 之外的命令，不提交 git。
- 客户端（polo-dir/dev）：静态提取为主（运行时依赖后端）。从流程附件指定的真实文件提取结构/class/文案/i18n 键值（zh-Hans 与 en 从 `packages/shared/src/i18n/locales/` 取真实文案）。构建产物 `dist/` 不可用（gitignore 且早于冻结 HEAD）。
- 管理端（polo-admin-dir/dev）：静态提取 + 仅公开页可运行。Tailwind/shadcn 类名从源码组件逐字提取，globals.css token 逐字复制。
- 每个 region 必须在 manifest 记录 componentSources/styleSources 真实路径；拿不到证据的值标 approximate 并给原因——**禁止虚构旧版产品 UI**。
- capability-gap / nearest_reference 流程：before.html 呈现真实现有产品的诚实缺失（最近真实页面/导航状态），不得画出现有源码不存在的功能界面。

## 5. After 规则

- 用设计基础与壳层的既有 token/组件语言表达新设计；优先复用壳层 `assets/product.css` 的模式（复制进 bundle，不跨目录引用）。
- 场景语义与 Before 一一对应（同一 scene 在两边表达同一业务状态）。
- 交互真实可点：流程附件"交互轨迹"中的动作必须在 after.html 里以纯前端状态机走通（含确认 Dialog、重新验证、 loading/失败/受限态）。
- 权限差异：角色变体 scene 中，无权操作禁用并附原因（foundation §6 规则）。
- PC-F04 例外：既有 Polo 助手内部状态只冻结入口、ProductSpace 交接和真实组件复用边界，不在 POO-41 静态 After 中重写会话、输入、Sources、Automations、Browser 或 Skill 执行状态机；内部交互由 POO-44 E2E 证明。

## 6. 自检（执行者必须完成并贴输出）

1. `python3 /Users/wow/.agents/skills/ab-prototype/scripts/validate_bundle.py <bundle目录>` 零 error。
2. 截图覆盖 before/after × 全部 scene × 声明视口（客户端 1440/1024/390，管理端 1440/1024/390；首语言 canonical 截图，客户端加 en 抽查桌面关键 scene）。本环境 Codex 沙箱不能起 HTTP 服务/浏览器时：**不要伪造截图**，在报告声明，由协调方补做。
3. 静态自查：零额外 CDN、零评审字样泄漏、scene 集与矩阵逐字一致。
4. 报告格式：列出哪些事实来自当前源码、哪些是近似、哪些验收项未完成及原因。

## 7. MUST NOT DO

- 不修改任何生产代码、源码根、git；不删除既有文件；不写 bundle 目录之外的文件（流程附件另有指定的除外）。
- 不把评审/状态/场景切换 UI 放进 before/after。
- 不虚构 Before 证据；不把 approximate 升级为 derived/exact。
- 不用 emoji 当图标（内联 SVG）；不用 lorem ipsum；不出现与 `CONTEXT.md` 冲突的词汇。
