# 原生素材到任务候选

适用版本：`native-materials-r3-20261022`，以当前工作树的源码、锁文件和再生成检查为准。
`AGENTS.md` 已路由到本 Skill；无需全局 design-system-adopt / 原型制作 Skill。

## 先分清范围和来源

- **实现复用范围**：当前基线导入 renderer 的登录、工作台、圈子、聊天样本和设置注册表子页。完整集合查 `assets/source-baseline/baseline-manifest.json`，不再手抄一份目录。源码入口为 `tools/source-baseline/entries/scenes.tsx`；设置子页来自 `apps/electron/src/renderer/pages/settings/settings-pages.ts`，画廊来自 renderer `playground/registry/*`。实现素材可用于保留现状，不等于该区域有新的设计确认。
- **已确认设计范围**：仍按模型的 modules、Spec、foundations 和原确认记录。设置/助手可复用现有实现，不能把工作台 hex 变量或旧目标 HTML 风格强加给它们。
- **目标设计**：`docs/mvp-complete-flow-hifi/prototype.html#scene=P-*` 与维护模板 `references/client-workbench.template.html` 是另一层；其确认范围以 Spec 为准。不要把目标、当前实现、候选和历史快照混评。
- **缺口**：完整助手工作台装配、dark、异常系统态、新组合布局等见 `page-baselines.md`。未变且无法复现区域可说明 Placeholder；本次改动与必要入口/返回/结果不可用占位遮蔽。

## 浏览与源码落点

当前实现浏览入口：`assets/source-baseline/index.html`；场景直达 `assets/source-baseline/entries/baseline.html?scene=ID&pure=1`（均可 file://）。实际可编辑入口是 **tools 下的 TSX/CSS/HTML**，assets 是输出。

- `entries/baseline.tsx`：mock 首先安装、i18n、Jotai/Theme/ProductSpace/MemberCatalog/MemberCircleResource/Modal/TabShell 等 providers。不要只摘 scene JSX 丢掉这些上下文。
- `entries/scenes.tsx`：原生场景组合与真实 imports。工作台 `workspace-home` 可从首页进入我的圈子/详情并返回；区域 `circle-detail-subscription` 可只看订阅区。改入口/返回流程时应保留整页路由，而非只截取订阅卡。
- `entries/fixtures.tsx`：只替代 IPC/后端数据，不代表真实服务、支付或持久化。新增本地交互结果需明确内存 fixture 边界。
- `entries/gallery.tsx`：复用生产注册的 component/wrapper/props/mockData，不复制生产组件库。
- `entries/baseline.css`：真实 renderer index.css + 任务布局的 Tailwind 扫描。设置使用 renderer 体系；圈子组件自行装配 workbench 样式。新增任务文件要加入扫描，不能只把类名粘入无扫描的 JSX。

## 环境和现有导出（cwd：仓库根）

依赖只安装到当前隔离树，禁止链接活跃 dev 的 node_modules。需要 Bun、Node、Python 3：

```bash
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/shared build
python3 .agents/skills/polo-ai-design-system/tools/source-baseline/build.py
python3 .agents/skills/polo-ai-design-system/tools/source-baseline/build.py --check
```

共享包构建生成忽略的 `packages/shared/dist` 浏览器 exports，缺失时 Vite 无法解析 `@polo-ai/shared/product-spaces`。
`build.py` 先 tsc，再求值真实注册表，最后 Vite 打包；输出在 `assets/source-baseline/`。`--check` 到临时目录真实再生成并逐字节比较输入记录/输出，不能只重写 hash。

## 任务内可编辑候选（原生 Vite，不改生产）

可在已忽略 `.tmp/<task>/` 新建任务候选。以下是保留现有组合的原生入口准备；不要复制 build.py 到另一层目录（它按自身位置求 repo root）。

```bash
# cwd: 仓库根；每项任务选择一个尚不存在的目录，避免覆盖已有候选
TASK_DIR="$PWD/.tmp/<task>"
mkdir -p "$TASK_DIR"
cp -R .agents/skills/polo-ai-design-system/tools/source-baseline/entries "$TASK_DIR/entries"
```

任务的 `vite.config.mjs` 直接复用原配置，repo 位置由启动时的 `POLO_TOOLCHAIN_ROOT` 提供，native root 是运行命令的 cwd：

```js
import base from '../../.agents/skills/polo-ai-design-system/tools/source-baseline/vite.config.mjs'
export default base
```

生产模块仍留在原位置。修改某个已有页面/组件时，将**所选叶子**复制到 `TASK_DIR/entries`（保留其它 imports；相对 imports 应显式指回原模块），只在任务配置中用 Vite 原生 alias 切到它。例如设置 `PreferencesPage.tsx` 或圈子 `CircleSubscriptionPanel.tsx` 都使用普通 JSX 和已有组件：

```js
import { resolve } from 'node:path'
import base from '../../.agents/skills/polo-ai-design-system/tools/source-baseline/vite.config.mjs'
export default {
  ...base,
  resolve: {
    ...base.resolve,
    alias: [
      // 仅加入本任务实际修改的模块；原设置注册表/CircleDetailPage 用这些相对 import
      { find: './PreferencesPage', replacement: resolve('entries/PreferencesPage.tsx') },
      // { find: './CircleSubscriptionPanel', replacement: resolve('entries/CircleSubscriptionPanel.tsx') },
      ...Object.entries(base.resolve.alias).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
}
```

设置叶子原文件：`apps/electron/src/renderer/pages/settings/PreferencesPage.tsx`；订阅叶子：`apps/electron/src/renderer/components/circles/CircleSubscriptionPanel.tsx`。只复制所需叶子，不维护第二组件库。在任务 `entries/baseline.css` 添加对应 `@source './PreferencesPage.tsx';` 等扫描。新增组件/组合也可直接在任务 `scenes.tsx` 中正常 import。若有改动语言文案，候选可使用任务内 i18n 资源/初始化，不改生产翻译来做原型。

```bash
# cwd: 仓库根，先保存绝对路径
REPO_DIR="$PWD"
TASK_DIR="$REPO_DIR/.tmp/<task>"
cd "$TASK_DIR"
# 预览：选择该任务独占的空闲端口；不杀/复用其他树的服务
POLO_TOOLCHAIN_ROOT="$REPO_DIR" "$REPO_DIR/node_modules/.bin/vite" --config vite.config.mjs --host 127.0.0.1 --port 4283 --strictPort
# 浏览 http://127.0.0.1:4283/entries/baseline.html?scene=settings-preferences&pure=1
# 停止自有预览后导出（仍在 TASK_DIR），输出为 task 内单文件
POLO_TOOLCHAIN_ROOT="$REPO_DIR" POLO_BASELINE_DIST="$TASK_DIR/dist" "$REPO_DIR/node_modules/.bin/vite" build --config vite.config.mjs
```

导出：`TASK_DIR/dist/entries/baseline.html?scene=ID&pure=1` 可 file:// 打开。保留任务源码及输出，先不改需求的原生副本应与基线一致，再只实现 delta。设置沿用 SettingsSection/Card/Toggle 和 renderer token；订阅沿用真实 `clientWorkbenchButtonClassName`、材质宿主和导航。不要手改 bundle、凭截图重画，或以 DOM 注入伪造结果。需要真实后端/生产持久化的实现另外按 Spec 授权处理。

## 自检与再生成

- 模型/Skill 绑定：候选 framework 的 `adopt.py --check` 只校验来源与 wrapper，不代表离线素材已更新。
- 实现输入变动：比较 `baseline-manifest.json.inputs` 和当前源码，分析组件/provider/布局/注册项影响后运行原生 build + `--check`；manifest 的 snapshot 是生成时记录，不要求等于提交后的 HEAD。
- token/目标模板变动：按 `usage-playbook.md` 完整命令再生；未变的 token-preview 先比较已有输出，不重复覆盖。
- 任务候选：检查只改了所选 TSX/CSS/fixture，真实浏览器核对基线与 delta、focus/开关/入口/返回/结果及网络依赖。临时证据保留在任务目录或 /tmp。
- 新 Agent 独立发现/消费、浏览器视觉、真实 Electron/API/支付验收分别留证；本说明与机械检查均不授予 PASS。

导航/Header 运行检查必须显式指定临时证据目录，避免默认路径回写历史 r15 截图：

```bash
# cwd: 仓库根
POLO_REVIEW_EVIDENCE="$(mktemp -d /tmp/polo-navigation.XXXXXX)" python3 docs/mvp-complete-flow-hifi/tools/check_navigation_header.py
```
