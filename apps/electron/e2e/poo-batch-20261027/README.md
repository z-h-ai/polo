# poo-batch-20261027 — 2026-10-27 发布批真机 E2E 钉子

钉住 2026-10-27 批(v0.22.0)四个运行期修复的交互回路,真实 Electron + 生产组件
(无产品代码 stub,只 stub IPC/electronAPI 与登录态)。防回归:任何一侧行为回退,
本场景以非零退出码失败。

| 回路 | 任务 | 断言核心 |
| --- | --- | --- |
| A 浏览器侧边栏 | POO-157 | 打开默认进右侧栏(不弹独立窗);显式弹出移动同一 WebContents;系统关闭独立窗收回侧边栏且页面状态(输入/滚动/JS/历史)保留;工具栏隐藏同样收回 |
| B 设置面叠层 | POO-153 | 激活 Polo 助手 tab 后打开全局设置面:与 Polo 面板列同层(DOM 靠后获胜),整面网格取样零泄漏、根容器不透明;关→再开回路 |
| C 画布应用 | POO-154 | 固定↔取消固定往返;关 Tab 后 Home「画布应用」区块可重开;空组织名册下发布按钮诚实禁用(中文原因,无英文报错) |
| D 计费气泡 | POO-155 | `402 POLO_INSUFFICIENT_CREDIT` sentinel(实时与持久化两形状、zh/en)显示本地化余额文案,无「Update credentials」误导动作,原文进可折叠技术详情;普通 402 反例保持原语义 |

## 运行

```sh
bun apps/electron/e2e/poo-batch-20261027/run.mjs
# 环境变量
#   POO_BATCH_BUILD_DIR   构建/运行产物目录(默认 /tmp/poo-batch-20261027)
#   POO_BATCH_EVIDENCE_DIR 证据输出目录(截图/runtime JSON/checks)
#   POO_BATCH_SOURCE_REF  记录用源提交号(run.mjs 自动取 dev HEAD)
```

## 边界

- electronAPI 与 Main RPC 为 fixture(组织名册为空 = POL-88 现状),非完整登录 App 验收;
  Main 侧 `BrowserPaneManager`、renderer 侧 `RightSidebarPane`/`useSidebarBrowserSync`/
  `GlobalSettingsSurface`/`TabShellProvider`+pin/publish 桥/`ChatDisplay` 均为生产源码。
- BP-04(跨会话收回隔离)由 `browser-pane-sidebar.test.ts` 与
  `use-sidebar-browser-sync.interaction.isolated.ts` 单测钉住,本场景不重复。
- host.capturePage 不含 BrowserView(平台限制),截图为 host 页 + 网页 view 各自采集。
