# POO-159：统一右侧浏览区实施 Plan

日期：2026-10-28。基线：`dcf5f710411b6c7619be10b27f6243bd48e63fe1`。

需求来源：POO-159 用户对侧栏、HTML、文件、网页及画布打开行为的澄清，以及本轮“删除原型、按此前 SPEC 拆 Plan、由 Codex GPT-6.1-Sol high 实现、用 diff-summary 总结”的明确授权。此前线框及其中额外的说明文案、演示按钮已经撤销，不是实现或视觉验收依据。下文固定此前文字需求在本轮的执行范围；实际界面复用当前生产组件和样式。

## SPEC 执行范围

1. 点击本地 HTML 后立即打开右侧浏览区并显示读取反馈，读取成功默认渲染，失败可见且可恢复。普通文件沿用对应的预览能力，进入同一右侧容器；HTML 可使用已有样式的最小源码切换。
2. 网页和 AI 浏览器默认在侧栏打开。AI 操作与用户看到的是同一会话绑定的浏览实例；只有用户主动弹出才使用独立窗口。已有手动浏览实例、其他会话和其他 ProductSpace 不被夺取。
3. 网页浏览器和画布弹出后右侧区域释放占用宽度，不保留大块占位说明和“收回／关闭”演示按钮。显式收回保留同一页面实例、输入和浏览状态。
4. 隐藏只隐藏当前呈现，保留浏览状态；独立窗口隐藏不自动变成侧栏。×按隐藏处理；显式收回单独执行。再次打开恢复已有实例，不重复建窗。
5. 显式关闭结束浏览实例，不删除源文件。AI 正在操作时说明结束的影响并确认，取消保持原位置。隐藏不终止 AI 操作，重开已关闭页面不自动恢复旧操作。
6. 画布遵循上述位置与生命周期含义。禁止把重建 guest、重载页面或仅恢复持久化数据描述成“同一实例保留状态”。
7. 保持现有账号、ProductSpace、session 与 owner 隔离；普通 HTML 不获得可信画布的宿主桥、分区或任意本地文件权限。文件快速切换、关闭、空间切换后，迟到读取不得覆盖当前内容。

本轮不改应用目录、添加到我的应用、固定标签或发布服务（POO-158），不引入新原型说明层或演示数据到产品。普通文件／HTML 的本轮交付是侧栏预览和隐藏恢复，保留原有外部打开入口；独立窗口迁移覆盖用户明确指出问题的网页浏览器和画布，不额外引入一套普通文件弹窗协议。报告不得把这一边界描述成所有资源都已支持独立窗口。

## 执行顺序

| 阶段 | 输入与动作 | 主要消费者／文件 | 完成条件 |
| --- | --- | --- | --- |
| P0 基线与技术验证 | 未修改的生产代码采集真实运行 before；固定 1440×900、同资源和操作；验证 Electron 同 WebContents 的画布迁移 | `apps/electron/e2e/poo159-unified-browser/`；生产 BrowserPaneManager、RightSidebarPane、CanvasPane | before 图像及采集凭据可追溯；迁移探针记录实例 ID 与内存状态；失败不能静默降级为重载 |
| P1 文件进入侧栏 | HTML 局部分类；读取前先设置加载状态；请求序号和作用域防旧结果回写；复用现有 embedded preview | `useLinkInterceptor.ts`、`App.tsx`、`AppShellContext.tsx`、`AppShell.tsx`、`RightSidebarPane.tsx`、`FilePreviewPane.tsx` 与现有 preview overlays | HTML 渲染／源码／错误反馈可见；图片、PDF、Markdown、代码正常；切换和失败反例通过 |
| P2 浏览器生命周期 | 移除 hide→return 与 invisible→autoembed；统一默认侧栏、显式弹出／收回／隐藏／关闭；复用既有确认组件与菜单 | `sidebar-browser.ts`、`use-sidebar-browser-sync.ts`、`browser-pane-manager.ts`、browser handlers、RemoteBrowserPaneManager | 弹出释放空间；隐藏不回栏、不停止工作；同实例收回；AI活动中取消关闭不丢位置；其他 owner 不受影响 |
| P3 画布同实例迁移 | 实测采用同一 guest 的承载方式；保留桥注册和分区边界；移除弹出占位 | `CanvasPane.tsx`、`canvas-popup-manager.ts`、`canvas-popout.tsx` 与必要桥／协议消费者 | 输入、内存计数、guest ID 在弹出／收回／隐藏后不变；关闭只结束目标；失败可恢复 |
| P4 回归与评审 | 局部测试、真实 Electron 用户路径、独立代码与 SPEC 审查；修复后复验 | 新旧相关 tests、原生 harness、7 个 locale | 必需场景通过；既有失败与任务回归分别记录；未验证部分不得写作通过 |
| P5 交付与资源收尾 | 固定最终文件指纹；生成 diff-summary 前后截图和代码红绿对照；归档；回收任务资源 | `~/reports/2026-10-28-poo159-unified-browser/`；任务卡与资源回执 | 报告可打开、资源链接有效、截图与版本一致；明确创建／回收／保留原因 |

执行者：Codex `gpt-6.1-sol`，reasoning `high`。Root 负责范围、独立审查编排、报告及资源复核。一次只允许实现 agent 修改产品源码；评审基于冻结后的工作区指纹。阶段属于同一用户旅程，不拆互相依赖的空壳任务。无需新产品审批即可继续本轮授权范围；实现发现真实产品冲突时以具体例子和推荐方案呈现。

P0 原生验证后的技术选择：Electron 拒绝将已经附着于 `<webview>` 的 guest 直接 adopt 到 `WebContentsView`（`options.webContents is already attached to a window`）。P3 因此采用持久 BrowserView 承载现有画布 renderer，移动整个容器，内部 guest 保持挂载。新 carrier 必须接入原有 webview 安全链，在每次 attach 时校验 Main 登记的 session、partition 和 workspace；窗口／空间退出必须回收，不能仅依赖 renderer 的显示状态。

## 验收场景

| ID | 起点／操作 | 预期与反例 |
| --- | --- | --- |
| BR-01 | 聊天文件链接打开 HTML，随后打开其他文件 | 即时侧栏反馈，默认渲染；失败有恢复入口；慢请求不能覆盖后来文件或已关闭／其他空间的面板 |
| BR-02 | 聊天网页链接、AI browser 操作首次打开 | 同会话实例出现在侧栏，无额外控制窗口；现有手动实例和其他会话不被复用 |
| BR-03 | 侧栏输入内容后弹出、收回 | 宽度释放；输入、内存状态和实例 ID 保留；没有弹出占位说明 |
| BR-04 | 侧栏或弹窗按隐藏／×，然后恢复 | 不自动转移位置；状态保留；后台 AI 工作不因隐藏被 stop；恢复不重复创建 |
| BR-05 | AI 活动中关闭，取消后再确认 | 取消不改变位置或页面；确认只结束该实例，源文件与聊天保留 |
| BR-06 | 画布交互后弹出、隐藏、恢复、收回 | 同一 guest 和内存状态保留；可信桥仍限定原 scope；普通 HTML 没有相同权限 |
| BR-07 | ProductSpace/session 切换、快速打开／关闭、异步结果迟到 | 原资源不串至新作用域；边界不因统一容器或弹出而弱化 |

验证分层：单元／接口检查覆盖生命周期和归属；原生 Electron 隔离 fixture 运行真实生产组件及 manager，覆盖窗口与渲染旅程；视觉为 smoke 与真实 before/after，不拿撤销线框作 parity 基准。fixture 不等同于完整登录客户端和真实 AI 服务验收，报告必须区分。HTML 相对资源／脚本支持按实际安全能力记录，不能通过放宽可信桥权限制造通过。

计划命令（以实际可运行脚本及最终记录为准）：

```sh
bun run --cwd packages/shared build
bun apps/electron/e2e/poo159-unified-browser/run.mjs
bun test apps/electron/src/main/__tests__/browser-pane-sidebar.test.ts
# 另执行本轮 hook、sidebar、canvas 与权限相关测试，以及 Electron 类型检查和 lint。
```

## 适用来源与边界

当前生产组件和 `docs/client-journey-review/spec.md` 为样式／旅程复用来源。设计系统 new-task 维护检查发现既有生成材料基线过期；本轮不消费该过期页面或撤销原型来锁定设计，使用当前源码及本轮真实运行证据。若本轮修改影响已有派生产物，须核对其消费者并按既有生成方式更新或明确未更新原因，禁止单改指纹掩盖漂移。

禁止擅自 commit、merge、push、发布或删除用户已有工作。仅删除本轮明确撤销的原型及已核实归属的可重建资源。保留源码、Plan、必要证据和工作树，资源收尾以实际消失验证为准。
