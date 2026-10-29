# POO-178 原生侧栏任务入口

维护用途：复用真正 AppShell、Navigation/TabShell/providers 与既有 renderer 样式，
仅用类型化 backend fixture 提供长会话与数据源。生产消费者直接 import，未复制 AppShell。
不注册到共享基线入口，避免 fixture API 与整页 provider 影响其他场景。

仓库根执行类型检查：
`node_modules/.bin/tsc --project .agents/skills/polo-ai-design-system/tools/sidebar-runtime/tsconfig.json --pretty false`。
本目录执行 `../../../../../node_modules/.bin/vite --config vite.config.mjs --host 127.0.0.1 --port 43178 --strictPort`。
打开 `/entries/baseline.html?route=allSessions/session/read-1`；追加 `&savedWidth=220` 或260覆盖已存宽度。
每个独立 page/profile 只初始化一次，刷新保留后续宽度和 More 折叠偏好；不通过预设 nav:more 掩盖生产默认值。

`reference-source.json` 只保存已采用的来源和哈希，不替代 Notma 最新需求。
候选源是已归档的 `~/reports/2026-10-28-poo178-sidebar-candidate/prototype.html`；
用 `tools/export-sidebar-reference.py --source-export <原型路径> [--check] [--evidence <忽略目录>]`
校验固定 bundle 哈希后真实渲染、提取 DOM/CSS（固定时钟/随机种子稳定原生随机占位提示），输出 `assets/prototypes/interview-sidebar/`。
复用 `export-conversation-references.py` 的读取器，不再入库原候选21MB脚本或第二份生产组件。
reference 移除产品脚本，仅保留观测滚动恢复；交互 runtime 始终是真实 React AppShell。

已采用范围仅默认180px及数据源/技能 More 折叠，未采用 POO-180 的其他布局方案。
原候选来自4f9e6e6f，正文旧字号，不能作 POO-168 集成后的14px通过证据。
视觉 smoke 覆盖1280×800、1440×900的收起/展开状态；它不比较目标像素，不能替代长会话
第4节阅读锚点、宽度220/260保留、键盘、入口/返回、More偏好刷新及真实 Electron 验收。
业务实现前，当前 runtime 仍显示220px且无 More；这应如实记录为before，而不是伪装已实现。
