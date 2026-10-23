# Polo 设计系统使用手册（新需求实施流程）

版本：`native-materials-r4-dev-aligned-20261023`。目标：让实施 Agent 不经提醒即可发现并复用本 Skill 的三层素材，提高原型还原度。三层素材的优先顺序：**Skill 内当前实现基线（页面/区域）→ 真实组件 → 设计变量**；旧目标设计（docs 原型）按已确认范围另列对照，不覆盖当前实现基线。

当前实现基线的统一入口：`assets/source-baseline/index.html`（file:// 可直接打开；含第二层组件画廊与页面/区域场景目录）。单个场景直达：`assets/source-baseline/entries/baseline.html?scene=<ID>`（同样 file:// 可开）。场景 ID 以 `assets/source-baseline/baseline-manifest.json` 为准（由 `tools/source-baseline/build.py` 从真实代码机制化提取）。

## 新需求先定位，再原生编辑

先读 [原生候选制作入口](native-reuse.md)：包含可复用实现范围与已确认设计范围的区别、依赖准备、原生源码位置、任务内可编辑候选、真实预览/导出命令。该入口不要求固定查询流程；直接读文件、跟随 imports 或使用已有可选工具均可。以下七步是检查事项，按任务选择最短路径。

## 七步流程

1. **核实基线版本与范围**。读 `references/design-system.json` 的 `revision` 与 sources SHA（`docs/mvp-complete-flow-hifi/tools/check_design_system.py` 一键校验）。确认需求落点是否在本 Skill `modules` 与 `paths` 内；范围外需求先查当前实现基线是否已覆盖该页面/区域（如设置子页，当前集合以注册表为准），未覆盖时走例子 A 的降级路径。
2. **定位页面/区域**。查 `references/page-baselines.md`：有对应场景 → 直接打开 `assets/source-baseline/entries/baseline.html?scene=<ID>` 对照当前实现（登录/工作台首页/圈子/助手/设置清单由 baseline-manifest.json 派生）；需要对照目标设计时再开 `docs/mvp-complete-flow-hifi/prototype.html#scene=<ID>`，两者分开使用不混评。无场景 → 查该文档「覆盖缺口」，按缺口规则处理（仅未修改且无法复现区域可 Placeholder；需求区域与必要上下文须补原生组合或报告阻塞），不得用 `design-demos` 历史画廊或 `docs/reports` 快照冒充。
3. **选择组件**。查 `references/component-usage.md`：优先复用生产组件（真实 import）；离线浏览组件与变体 → 基线统一入口第二层组件画廊（`entries/baseline.html?scene=components-gallery`，各分组条目数以运行画廊分组过滤为准，每卡标注生产落点）；需要完整交互态 → 启动 playground（`http://localhost:5173/playground.html`），画廊与 playground 渲染协议同源。对照 Skill 合同组件↔生产落点表。4 个 `assets/components/*.js` 是原型行为脚本，不是组件库。
4. **消费变量**。产品面读 `assets/tokens/workbench-base.css` → `workbench-review.css`（cascade 顺序，不能只摘一个 token 推定外观）；具体值浏览 `assets/tokens/token-preview.html`（生成产物）。合同细节（材质作用域、禁用画法、Header 细线）读 `references/foundations.md`。已确认的产品设计保留使用；当前实现不是新产品授权。
5. **只修改必要区域**。未变化区域复用基线/现有代码；不整页重设计、不改产品行为。POO-105 材质只作用在 `data-client-material="light"` 且非 dark 的宿主，缺标记回落不透明样式。
6. **浏览器核验**。运行真实目标（Electron 页面用 `bun run electron:dev`；playground 用 :5173），对照基线截图核对代表页面与交互态（loading/empty/error/focus/disabled），不能以 hash/检查通过替代视觉核对。
7. **同步派生物**。改了 token CSS / 模板 / 模型 → 重跑 `tools/build-token-preview.py`、`env VITE_BIN="$PWD/node_modules/.bin/vite" POLO_ELECTRON_ROOT="$PWD" python3 docs/mvp-complete-flow-hifi/tools/build_review.py`（repo root 执行；build_review 依赖 design-demos 旧导出工具，两个 env 入口分别指定 vite 可执行文件与 electron 工具链根，不依赖碰巧的 shell 环境）、`check_design_system.py`；改了基线生成器或其消费的 renderer 源码 → 在 repo root 重跑 `python3 .agents/skills/polo-ai-design-system/tools/source-baseline/build.py`，并以 `--check` 确认输入指纹与输出逐字节再生，保持生成链一致。

## 例子 A：设置页新增一项（当前实现基线已覆盖）

需求示例：「在设置里加一个『会话历史同步』开关」。

1. **范围判断**：设置页不在 Skill `modules` 的产品面工作台范围，但**当前实现基线已覆盖**：`page-baselines.md` 与基线清单含设置注册表子页场景（包含 `settings-tools`；`settings-app`…`settings-preferences`，另有未登录独立态 `settings-account-security-signed-out`）。样式体系是 renderer `index.css` 的 oklch token（不是本 Skill 的十六进制 token，两套不可混用，见 component-inventory §7）。
2. **页面入口**：消费方 `apps/electron/src/renderer/pages/settings/*`（如 `PreferencesPage.tsx`，自动保存 500ms debounce 模式）。整页/子页布局对照 `assets/source-baseline/entries/baseline.html?scene=settings-preferences` 等对应子页场景（构建自真实页面代码）。
3. **组件**：用 `@/components/settings` 现有件（`SettingsSection` + `SettingsCard divided` + `SettingsToggle`），不新造开关样式。浏览真实组件态：基线画廊 Settings 组（`?scene=components-gallery` 默认分组，12 条注册条目含禁用态变体）；或 `bun run electron:dev` → `http://localhost:5173/playground.html` → Settings 分类 → `settings-page-preview`（组合展示示例，import `@/components/settings` 真组件）。
4. **变量**：跟随所在页面既有类与 renderer token；需要新色值时先查 component-inventory §7 的对照表确认该页用的是哪套体系。
5. **核验**：Electron 真实打开设置页核对（自动保存、禁用态、focus 外框）；基线画廊/playground 截图作为组件态证据。

## 例子 B：产品面页面改动（范围内，复用基线）

需求示例：「圈子详情订阅区加一个『发票』入口」。

1. 基线：当前实现基线 `assets/source-baseline/entries/baseline.html?scene=circle-detail-subscription`（或 `-content`/`-updates` 分区场景）对照现状；需要目标设计对照时另开 `prototype.html#scene=P-M07-DETAIL-PAID-SUBSCRIPTION`（或 FOCUS 变体），两者分开使用；确认改动只在订阅区。
2. 组件：生产落点 `circles/CircleDetailPage.tsx` 的 Subscription 分区；价格/周期/有效期各出现一次的文案规则（foundations §圈子详情）不受影响。
3. 变量：从真实 `CircleSubscriptionPanel.tsx` 的 `clientWorkbenchButtonClassName` 与所属材质作用域复用；目标模板中的 `card-action`/`circle-open` 仅用于该 HTML 目标，不能拿它替换生产 React 样式。
4. 核验：对照基线场景截图 + Electron 实际页面；免费圈走真实产品路径核对（基线 `workspace-home` → 我的圈子 → 「入门指南圈」查看详情 → 订阅分区，应显示免费/长期有效），`circle-detail-*` 三个基线场景固定为 `circle-baseline-monthly` 月度圈样例，不代表免费圈形态。
5. 新场景需要入当前实现基线时：改 `tools/source-baseline/entries/scenes.tsx` 注册表 → repo root 重跑 `build.py` → 确认清单与运行时集合一致 → 更新 page-baselines 表格 → 重跑检查。目标设计原型新场景仍走主 manifest 权威源 → 按第 7 步完整命令重跑 `build_review.py` 再生。

## Placeholder 规则

仅限未变化且确实无法从源码/基线复现的区域：在任务中标注 `Placeholder: <区域> — <缺口>；现状来源 <真实代码路径>`。已有源码可运行时优先原生复用。不得遮住本次新增/修改区域、必需入口/返回路径或结果态；这些缺失时应补 fixture/组合，或报告具体阻塞。历史转译素材不能冒充当前高保真。

## 常见坑

- 两套 token 体系混用（oklch vs 十六进制）——先判断页面归属。
- 材质作用域外写 `--client-material-*`——无标记宿主读不到，会静默回落。
- 把 `assets/components/*.js` 的模拟结果移植进生产——它们只演示行为衔接。
- 只跑 hash 检查就宣称视觉完成——检查器证明来源一致，不证明还原度。
- 顶栏细线规则：非材质宿主「主体滚离顶部出现、回顶消失」；材质作用域内任何滚动状态都不显示（POO-105 收窄，见 foundations）。
- 手改 `assets/source-baseline/` 下的任何生成文件（含 manifest/index.html）——它们只能由 `build.py` 再生；手改会让 `--check` 失败且不构成来源更新。
- 基线打开方式用 `index.html`/`entries/baseline.html` 的 file:// 直开或场景参数；不要拿开发服务器中间产物（`tools/source-baseline/dist*`）当素材。
