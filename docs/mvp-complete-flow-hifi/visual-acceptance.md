# POO-70 · MVP 完整流程高保真 — 视觉验收

日期：2026-09-17 · 修订 `poo70-ux-r4-v2-7`（继承 D-PC-07/08/09，经四轮用户走查迭代收敛） · 评审壳：[prototype.html](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fprototype.html) · 产品表面：[surface.html](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fsurface.html) · 追溯：[prototype-manifest.json](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Fprototype-manifest.json) · 逐步走查：[review.md](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Freview.md)

截图均直接对 `surface.html`（纯产品表面，无任何评审 chrome）拍摄——v2 契约下产品表面与评审 chrome 分离于两个文件，不再需要 `?clean=1` 之类的隐藏开关。

---

## 1. 自动化检查结果

| 检查项 | 方法 | 范围 | 结果 |
| --- | --- | --- | --- |
| v2 契约校验 | `validate_prototype.py`：双文件嵌入 manifest 与文件 canonical 一致、surface `(data-go,data-transition)` 有序多重集 == manifest 声明、评审壳结构（1 iframe + 3 inspector tab + 评审 brief）、禁 fixed/禁评审字符串、离线正则、源 sha256 实算、全场景自 start_scene 可达 | 两文件 + manifest + 16 项 sources + 设计 Skill 绑定 | **通过**：`valid v2 high_fidelity prototype: 92 scenes, offline and source-bound` |
| 全部 transitions 落点 | Playwright 逐场景激活后逐按钮点击，核对 `data-transition`/`data-go` 与实际落点 | **1601 / 1601 条** | **全部命中**，0 失效边、0 脚本异常（工具 `tools/smoke_review.py`） |
| 脚本异常（pageerror / console.error） | Playwright 页面事件监听 | 评审壳全交互冒烟全程 | **0** |
| 网络请求 | v2 禁网校验（`https?://`、协议相对 URL、fetch/XHR/WebSocket/EventSource 调用）+ surface CSP `connect-src 'none'` | 两文件 | **0 外部引用、0 网络调用**（仅 file:// 本地打开） |
| 横向溢出 | 每场景激活后测 scene/document `scrollWidth` | 106 场景 × 2 视口 = 212 次加载 | **0 屏溢出** |
| 交互元素可达性 | 每个可见 button/a/input 逐个 `scrollIntoView(nearest)` 后立即测矩形是否越出视口（±4px 容差） | 同上 | **0 元素越界** |
| 页面索引 / 页面说明 / 本轮评审 | Playwright 实测：三标签切换、分组跳转、当前屏标注 | 评审壳检查器 | **通过**：92 项按 11 模块分组；标注含 ID/分类/依据/需求节点；本轮评审标签含现状→差异→依据→评审问题 |
| Back / Reset / 直达链接 | Playwright 实测 | 评审壳 | **通过**：`#scene=<ID>` 直达、Back 回退、Reset 回起始屏 |
| 四条故事播放 | Playwright 实测：进入/自动同步/下一步到末尾/退出 | S1（12 步）/ S2（14 步）/ S3（7 步）/ S4（7 步） | **通过**：进入落首步、产品点击自动推进、末步禁用 next、可退出 |
| 视口切换真实性 | Playwright 读 iframe `innerWidth`/`innerHeight`，并验证检查器开合不改变二者 | 1440×900 与 1024×768 | **通过**：两档均精确等于所选视口；检查器只改变显示缩放 |

检查工具：Playwright（`chromium.launch()` headless，deviceScaleFactor=1）；审计明细见 `build/viewport-audit.json`（空对象即零问题）；构建工具链见 [feature-map.md §5](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Ffeature-map.md)。

## 2. 截图索引 — 1440×900（30 张）

文件位于 `screenshots/1440x900/`：

| 屏 | 模块 | 说明 |
| --- | --- | --- |
| [P-M01-LOGIN-PASSWORD](screenshots/1440x900/P-M01-LOGIN-PASSWORD.png) | M01 | 现有登录卡（分段 tab + 协议勾选） |
| [P-M01-PERSONAL-PREP](screenshots/1440x900/P-M01-PERSONAL-PREP.png) | M01 | 我的空间幂等准备 |
| [P-M01-INVITE-BROWSER](screenshots/1440x900/P-M01-INVITE-BROWSER.png) | M01 | 浏览器邀请交接卡 |
| [P-M02-SWITCHER](screenshots/1440x900/P-M02-SWITCHER.png) | M02 | 空间切换器（集成候选还原） |
| [P-M02-CONFIRM](screenshots/1440x900/P-M02-CONFIRM.png) | M02 | 切换确认 · 终止 3 项 |
| [P-M02-CONFIRM-PERSONAL](screenshots/1440x900/P-M02-CONFIRM-PERSONAL.png) | M02 | 我的空间有活动时切企业 · 先确认终止 |
| [P-M02-STOP-FAILED](screenshots/1440x900/P-M02-STOP-FAILED.png) | M02 | 部分停止失败（重试/取消） |
| [P-M03-HOME-PERSONAL](screenshots/1440x900/P-M03-HOME-PERSONAL.png) | M03 | 个人首页（助手固定 + 3/5 常用） |
| [P-M03-HOME-ZERO](screenshots/1440x900/P-M03-HOME-ZERO.png) | M03 | 首登零常用引导（D-PC-01） |
| [P-M03-ALL-APPS](screenshots/1440x900/P-M03-ALL-APPS.png) | M03 | 全部 Apps · 来源分组 |
| [P-M03-HOME-ENT](screenshots/1440x900/P-M03-HOME-ENT.png) | M03 | 企业首页（无管理卡、无个人圈子通知，D-PC-07/08） |
| [P-M04-APP-VIEW](screenshots/1440x900/P-M04-APP-VIEW.png) | M04 | App 容器 · FDE 中性占位 |
| [P-M04-CLOSE-ACTIVE](screenshots/1440x900/P-M04-CLOSE-ACTIVE.png) | M04 | 关闭三选项 |
| [P-M04-PERM-DENIED](screenshots/1440x900/P-M04-PERM-DENIED.png) | M04 | OS 权限被拒 → 系统设置路径 |
| [P-M05-CHAT](screenshots/1440x900/P-M05-CHAT.png) | M05 | 助手会话（直接复用现有框架） |
| [P-M05-QUESTION-REOPEN](screenshots/1440x900/P-M05-QUESTION-REOPEN.png) | M05 | 追问待回答与重开恢复（PC-N04） |
| [P-M06-SKILLS](screenshots/1440x900/P-M06-SKILLS.png) | M06 | 技能列表（同名并列 + 授权态） |
| [P-M07-LIST](screenshots/1440x900/P-M07-LIST.png) | M07 | 我的圈子列表（本轮新增） |
| [P-M07-DETAIL-PAID](screenshots/1440x900/P-M07-DETAIL-PAID.png) | M07 | 付费订阅详情（虚构演示数据） |
| [P-M07-EXPIRED](screenshots/1440x900/P-M07-EXPIRED.png) | M07 | 单一圈子来源到期，另有来源的作品仍可打开 |
| [P-M07-SOURCE-FALLBACK](screenshots/1440x900/P-M07-SOURCE-FALLBACK.png) | M07 | 退出一个圈子后，同一作品经其他来源继续可用 |
| [P-M08-FILES](screenshots/1440x900/P-M08-FILES.png) | M08 | 会话文件（留原对话，D-PC-03） |
| [P-M09-PRE-BLOCK](screenshots/1440x900/P-M09-PRE-BLOCK.png) | M09 | 发送前积分不足（输入保留） |
| [P-M09-BROWSER](screenshots/1440x900/P-M09-BROWSER.png) | M09 | 充值浏览器交接卡 |
| [P-M09-RESUMED](screenshots/1440x900/P-M09-RESUMED.png) | M09 | 到账解除 · 由用户决定发送 |
| [P-M10-MENU](screenshots/1440x900/P-M10-MENU.png) | M10 | 账号菜单（管理入口按资格出现） |
| [P-M11-BLOCKED-EXPIRED](screenshots/1440x900/P-M11-BLOCKED-EXPIRED.png) | M11 | 最后一个有效来源失效才阻断 |
| [P-M11-CONTRACT](screenshots/1440x900/P-M11-CONTRACT.png) | M11 | 需要升级 Polo（ContractGate 还原） |
| [P-M11-REOPEN-RECOVERY](screenshots/1440x900/P-M11-REOPEN-RECOVERY.png) | M11 | 重开恢复（不猜成功） |
| [P-M11-OFFLINE-HOME](screenshots/1440x900/P-M11-OFFLINE-HOME.png) | M11 | 离线打开（缓存范围如实标注） |

## 3. 截图索引 — 1024×768（11 张）

文件位于 `screenshots/1024x768/`，验证 G4 布局在小视口下收敛（顶栏收纳、卡片栅格降列、助手三栏压缩）：

| 屏 | 模块 |
| --- | --- |
| [P-M03-HOME-PERSONAL](screenshots/1024x768/P-M03-HOME-PERSONAL.png) | M03 |
| [P-M03-HOME-ZERO](screenshots/1024x768/P-M03-HOME-ZERO.png) | M03 |
| [P-M03-ALL-APPS](screenshots/1024x768/P-M03-ALL-APPS.png) | M03 |
| [P-M04-APP-VIEW](screenshots/1024x768/P-M04-APP-VIEW.png) | M04 |
| [P-M05-CHAT](screenshots/1024x768/P-M05-CHAT.png) | M05 |
| [P-M07-LIST](screenshots/1024x768/P-M07-LIST.png) | M07 |
| [P-M07-SOURCE-FALLBACK](screenshots/1024x768/P-M07-SOURCE-FALLBACK.png) | M07 |
| [P-M08-FILES](screenshots/1024x768/P-M08-FILES.png) | M08 |
| [P-M09-PRE-BLOCK](screenshots/1024x768/P-M09-PRE-BLOCK.png) | M09 |
| [P-M10-MENU](screenshots/1024x768/P-M10-MENU.png) | M10 |
| [P-M02-SWITCHER](screenshots/1024x768/P-M02-SWITCHER.png) | M02 |

## 4. 任务验收标准对照

| 验收标准 | 证据 |
| --- | --- |
| M01—M11 均有页面或「直接复用」证据 | [feature-map.md](/__notma/open-file?path=%2FUsers%2Fwow%2Fproject%2Fz-h-ai%2Fpolo-dir%2FPOO-70%2Fdocs%2Fclient-journey-policy-interview%2Fdocs%2Fmvp-complete-flow-hifi%2Ffeature-map.md) §2/§3；106 场景逐场景 `category` 标注（manifest `scenes[].category`，11 modules 集合恰好等于场景所用） |
| PC-F01—F11 / PC-N01—N04 / C-R01—C-R08 / J-PC-01—07 / D-PC-01—09 / M01—M11 可追溯 | manifest `confirmations` 50 条，每条含结论 + `source_revision` + 实算 sha256 快照 |
| 四条故事连续走通（含成功/失败/取消/过期/重开/跨端） | manifest `stories` 4 条（S1 12 步 / S2 14 步 / S3 7 步 / S4 7 步）；评审壳「故事」下拉实测通过（本文 §1）；路径与验证点见 review.md §2 |
| 关键页面截图 + 无溢出/遮挡/不可达 | 本文 §1（1383 边全命中、184 次加载零溢出、零元素越界）+ §2/§3（41 张截图，按 `poo70-master-r10-v2-4` 重摄） |
| 「当前已有」绑定源码/截图 | manifest `sources` 16 项（POO-70 主说明、历史快照、v1 原型、G4 设计依据、D-PC-07/08/09 原话与本轮差异快照，均实算 sha256）；设计 Skill 绑定 `.agents/skills/polo-ai-design-system` |
| 双视口 1440×900 与 1024×768 | manifest `target.viewports`；评审壳真实 iframe 视口实测（本文 §1）；截图两档各成目录 |
| owner 同一评审入口复看本轮修订 | prototype.html（页面索引 + 页面说明 + 本轮评审标签 + 故事下拉）+ review.md §6 已解决项与后续输入；当前状态“修改待复看” |
| 离线零网络请求 | v2 禁网校验 + surface CSP `connect-src 'none'`；file:// 冒烟全程 0 网络调用 |

## 5. 已知限制

- **UI 基准为 POO-41 G4 冻结稿**：窗口 chrome（64px workbench-bar 单顶栏、brand-lockup、tabs、bar-actions）、`system-screen`、`modal-layer`、`toast`、组件语言（card/dialog/assistant-shell 三栏/login-split）与全部 token（`--accent:#6e56cf` 等）内联自 `polo-client-g4-ui/design-demos`（artifactCommit `ef3528ef`，98 scenes 全通过）的 `product.css` 原文；本原型仅补充该稿未覆盖的状态组件（积分横幅、问题卡、运行 pill 展开等），均用 G4 token 表达。
- **截图为纯产品表面形态**：直接对 `surface.html` 拍摄，天然不含评审 chrome；评审交互（索引/故事/视口）请打开 prototype.html 对照。
- **1024×768 是真实 CSS 视口**：评审壳切换的是 iframe 的真实 `innerWidth`/`innerHeight`；真实桌面窗口另有 OS 级标题栏高度。
- **浏览器交接卡不代表浏览器端设计**：8 个 cross 屏只表达桌面侧职责与交接规则。
- **FDE 区域为中性占位**：不猜测任何真实 App 的业务界面。
- **「分支：」虚线按钮**：截图中的虚线「分支：」按钮是评审分支入口（保证无自然入口的失败/取消路径可达），非产品设计；详见 review.md §6。
- **演示注入点**：部分失败/到账状态用「（演示）」按钮模拟服务端回调；真实实现中由服务端事件触发。
- **v2 叠层实现差异**：v2 禁 `position: fixed`，modal-layer/toast/system-screen/auth-ambient 四类叠层改为 `absolute` 锚定 100vh 场景容器，视觉不变（构建时逐类断言恰 1 处替换）。
