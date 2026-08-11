# Polo Electron Source Baseline

这是一个正在重建的 Electron Renderer 基线。旧的通用 Mock 已被否决，不能代表真实产品，也不能作为后续设计任务的依据。

所有目录场景均按真实 Renderer 源码直接翻译。真实 Electron 或明确标注的
Playground 截图是可选的视觉核验依据，不是静态基线的前置条件。静态源码无法
唯一推导的账户、组织、应用目录、会话与权限数据，必须使用显式命名的确定性
fixture，不能虚构为真实运行时数据。

## 使用

模块化版本需要通过本地 Vite 预览：

```sh
cd /Users/wow/project/z-h-ai/polo-dir/POO-41/feat/polo-client-g4-ui/design-demos/polo-client-source-baseline
/Users/wow/project/z-h-ai/polo-dir/dev/node_modules/.bin/vite --config vite.config.mjs
```

打开 `http://localhost:4183/`。可使用以下 URL 参数：

```text
?scene=home&state=normal&theme=light&lang=zh-Hans
```

单文件 `prototype.html` 不依赖生产源码，构建后可以直接通过 `file://` 打开。

## 日常更新与验收

不能把旧的通用 mock 或其截图用于设计改动。每个新区域先记录真实源码路径，直接翻译组件、CSS、文案和图标；需要额外视觉核验时再补充真实 Renderer 或 Playground 截图，并按以下顺序刷新产物：

```sh
node tools/export-single-file.mjs
node tools/validate-prototype.mjs
```

`export-single-file.mjs` 会先用固定的 Electron 工具链构建，再把 CSS/JS 内联到 `prototype.html`。模块化 `src/` 仍然是可编辑真源。旧 `scene-matrix.mjs` 和 `browser-smoke.mjs` 针对已否决的通用 mock，不能作为本重建的验收或截图生成器。

`validate-prototype.mjs` 的 `static: passed` 表示独立 HTML、来源清单和
traceability 文件自洽。`verification.sourceFidelity: static-source-derived`
表示每个目录场景已走静态源码派生路径；它不等同于任意真实账户数据下的运行时
截图逐像素证明。

场景协议保持稳定：`?scene=<id>&state=<state>&theme=light|dark&lang=<locale>`。设计任务优先复用现有场景和状态，只在确实新增产品可达状态时扩展 `scene-catalog.json`。

## 来源与刷新

当前基线固定来源：

- Source root：`/Users/wow/project/z-h-ai/polo-dir/dev/apps/electron`
- Git revision：`01f4447cf77612ca2c62d9c7155601a51bdb7b5b`

普通设计任务只读取本目录的 `prototype-manifest.json`、`scene-catalog.json` 和目标场景模块，不重新扫描 `apps/electron`。生产源码变更不会自动刷新本基线；只有明确的 baseline refresh 任务才允许更新来源 revision、截图和产物。

## 文件分工

- `src/`：长期可编辑的模块化原型真源。
- `prototype.html`：自动导出的单文件评审产物，不直接编辑。
- `scene-catalog.json`：稳定场景、状态、区域和源码路径。
- `SCENE-TRACEABILITY.md`：逐场景源码、参考截图和未完成审计项。
- `prototype-manifest.json`：来源、协议、覆盖、近似项和验收证据。
- `tools/`：导出、静态合同检查、来源漂移检查和截图工具。

现有 `design-demos/polo-client-g4-ui/` 是独立的 G4 新设计草稿，不属于本基线，禁止覆盖。
