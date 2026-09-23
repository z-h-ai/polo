# Polo 助手 Chat · 高保真原型

本目录沿用 `polo-client-source-baseline` 路径，当前交付物已调整为 Polo 助手聊天原型。默认打开 `chat/empty`；聊天、会话、技能、数据源等场景保留。浏览器式标签栏、侧栏账号页脚、Polo AI 菜单和 Home 应用入口已从当前原型移除。旧 `home`、`enterprise-home`、`app-menu` 深链接显示默认聊天页。

原型沿用固定版本的 Electron Renderer 组件与视觉资产，但上述壳层删改是本轮产品设计，不代表当前 Renderer 的实际界面。登录、组织、Browser 等保留场景仍是辅助参考；历史截图只证明截图拍摄时的组件，不能当作当前聊天页的整页验收。

当前聊天页的 [1440×900 截图](screenshots/chat-focus-r1/chat-empty-1440x900.png)、[800×600 截图](screenshots/chat-focus-r1/chat-empty-800x600.png) 和 [浏览器检查记录](screenshots/chat-focus-r1/browser-check.json) 对应本轮原型。窄窗默认收起侧栏，左上角按钮可将它以浮层打开。

## 打开与更新

单文件 [prototype.html](prototype.html) 可直接通过 `file://` 打开，也可用本地 HTTP 预览。模块化源码在 `src/`，通过 Vite 预览时使用：

```sh
cd design-demos/polo-client-source-baseline
/Users/wow/project/z-h-ai/polo-dir/dev/node_modules/.bin/vite --config vite.config.mjs
```

预览地址是 `http://localhost:4183/`；例如 `?scene=chat&state=conversation&theme=light&lang=zh-Hans`。无参数时显示空聊天。改动应先写入 `src/`，再从目录下执行：

```sh
node tools/export-single-file.mjs
node tools/validate-prototype.mjs
```

`prototype.html` 是自动导出产物，不直接编辑。`components/` 是独立组件画廊；其内容由 `node tools/export-component-gallery.mjs` 生成。场景索引由 `scene-catalog.json` 维护，来源和当前设计覆盖范围见 `SCENE-TRACEABILITY.md` 与 `prototype-manifest.json`。

## 来源边界

原始组件来源固定为 `/Users/wow/project/z-h-ai/polo-dir/dev/apps/electron` 的 `01f4447cf77612ca2c62d9c7155601a51bdb7b5b`。旧基线记录保留在 `SOURCE-EVIDENCE.md` 和历史截图中；当前原型的壳层删改以本轮用户要求为依据。静态结构校验只检查产物、清单与当前删改自洽，不证明真实 Electron 运行时已采用这套布局。
