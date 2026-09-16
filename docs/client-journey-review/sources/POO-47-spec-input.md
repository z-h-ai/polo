父任务：POO-43

## 目标

在收窄后的 Catalog/安装/直接打开能力上实现客户端 App Runtime 外壳、运行中心、结果与文件，并承接平台级积分阻断。

## 前置依赖

- POL-87 → POO-42 → POO-43（成员首页、Catalog、安装与直接打开）。
- POL-102（App Run 按实际用量归集与异常收口）。
- POL-103（ProductSpace 积分商品、订单、支付渠道与查询 API）。

## 范围

- runtime key 使用 accountId + productSpaceId + artifactInstanceId/versionId，并保留独立 workspaceId。
- 客户端多 App Tabs 的打开、切换、关闭、后台继续和终止。
- 顶部运行中心与“任务与结果”统一承接运行中、后台、失败、历史执行和已保存结果。
- “文件”汇总助手附件、App 导入及 AI/App 导出的最近文件；文件名用默认应用打开，本机位置在 Finder 中打开所在目录。
- 平台级积分不足使用非模态提示；充值完成后只由用户触发一次查询，不轮询、不自动重试。
- 个人/企业 ProductSpace 的安装、运行、状态、日志、结果与文件严格隔离。

## 非目标

- Catalog 数据源、安装授权和首页快捷入口本身。
- FDE App 内部任务 UI、内部导航或结果组件。
- Polo 助手会话、附件索引、Skills 和执行上下文。
- App 固定报价、自动恢复或自动重试。

## 验收标准

1. personal/enterprise 同名 App 不共享 runtime key、安装状态、日志、结果或文件。
2. 关闭运行中的 Tab 时可明确选择后台继续或终止；终止失败保持原空间和可恢复状态。
3. 运行中心与任务结果状态一致，固定启动版本不因 Catalog 更新而切换。
4. 文件名由系统默认应用打开，本机位置准确在 Finder 定位所在目录；不存在独立上传入口。
5. 积分不足保持 App 打开并显示非模态平台提示；用户充值后只查询一次，不轮询、不自动重试任务。
6. 用户界面统一称 App，不暴露 Web App、localhost、FDE、本地/远程或沙箱实现标签。

## 视觉验收

- 启用 parity 视觉门禁，视口为 1440×900、1024×768、390×844。
- 按 `POO-41` UI v1 验收客户端外壳，并按 `POL-94` 客户端第二轮原型验收 App Tab、运行中心、结果、文件和积分阻断；只引用权威设计，不复制设计产物。

## 自动继续与暂停规则

IPC、状态存储、系统打开命令和后台运行实现由研发决定。只有 runtime key、平台/FDE 所有权边界或冻结交互需要改变时暂停裁决。

---

## 实现 Plan

状态：`awaiting-upstream-repin`  
生成日期：2026-09-08  
负责人确认：执行链与基线已确认；等待 POO-43 集成后 re-pin 最终文件锚点

### 1. 输入、基线与执行闸门

- 任务正文（本卡）是需求与范围权威；计划基于更新前卡片 rev `adad5a34b04de36455328bac7ebe2e92a6e1b5f2d5a12e1b513447ad4c17fe6d`。
- 代码探索以 POO-43 当前干净 HEAD `76ce05228a84ae1e66f14091e97d15661423522f` 为最新上游候选；其 Catalog、安装、`resolve-launch`、一次性 launch handoff 仍在独立 Acceptance，尚未进入集成基线，因此只能标为 `upstream-expected`，不能锁定为实现输入。
- 当前 POO-47 worktree 干净，HEAD 与 `integration/pol68-g5-client` 均为 `6cbdf573961776c4e69a9d990fd943d418a9b71d`，尚未包含 POO-43。因此本阶段只发布条件 Plan；开始实现前必须证明 POO-43 已集成并完成 re-pin。不得复制 POO-43 的未集成分支内容。
- POL-102、POL-103 已完成；实现时只消费其既有按量计费错误语义、积分/订单/查询能力，不在客户端重建计费或支付事实。
- `POO-41` 冻结客户端外壳与 `POL-94` 客户端第二轮原型是视觉/交互权威。POO-47 对 runtime key 的显式新约束优先于 POO-41 旧文档中 `workspaceId + executionId` 的旧缓存键示例。
- 390×844 继续展示 POO-41 已冻结的窄窗保护页；POL-94 的 390 资产仅用于核对提示组件缩放，不绕过窄窗保护。若产品要在 390 宽度进入 App 工作面，属于冻结交互变化，按本卡暂停规则重新裁决。

### 2. 冻结技术决策

1. **身份与运行键**
   - 新建碰撞安全的版本化 tuple helper：`["product-space-app-runtime", 1, accountId, productSpaceId, artifactInstanceId, versionId]`，使用 JSON 编码，不用字符串分隔符拼接。
   - `workspaceId` 保留为 execution/tab/result/file 记录的独立字段，不进入 runtime key，也不得由路径、活动窗口或 ProductSpace 猜测。
   - 安装存储继续按 account + ProductSpace + artifact 分区、版本作为该分区内的已安装版本；运行实例、日志、历史、结果和文件使用包含 `versionId` 的新 runtime key。Catalog 更新只影响下一次 `resolve-launch`，不能改写已打开 Tab 的版本身份。

2. **唯一状态源**
   - 以 Main/server-core 的受信执行注册表为活动状态权威，在同一 ProductSpace-scoped runtime projection 中持久化终态历史、显式保存结果与最近文件元数据。
   - 顶部运行中心和“任务与结果”只订阅这一 projection；不得分别维护 renderer 本地状态，从而避免一个显示“运行中”、另一个显示“失败”的漂移。
   - 持久化只写非秘密身份、状态、显示名、时间、已验证本机路径和来源；launch token、payer、余额、费率、Prompt、App 输入和 App 输出正文不进入 Tab/localStorage 或运行中心索引。

3. **App 与平台桥**
   - POO-43 的一次性 handoff 是唯一启动入口：consumer 用完整 immutable context 取走 credential-bearing launch，再把非秘密固定身份写入 Tab；失效、跨账号、跨空间或重复 take 全部 fail closed。
   - 遵循 POL-94 已冻结的边界：FDE App 只通过 Polo 提供的 loopback App API 发起本地 AI 调用、创建/结束 App Run，以及显式报告结果和导入/导出文件；不新增 WebView guest IPC 作为第二套平台协议。该 API 绑定 `127.0.0.1`，每次启动签发高熵、短生命周期 capability，Main 由 capability 重新取得 account、ProductSpace、artifact、version 和 workspace，拒绝 App 自报这些所有权字段。
   - capability 只通过进程环境交给该次启动的 App，不进入 Tab/localStorage/日志；进程退出、终止、版本替换或 scope epoch 变化时立即撤销。localhost API 返回稳定平台错误码，并把 `insufficient_credit` 等平台状态投影到 Main/runtime center，再由主 renderer 展示冻结提示。
   - FDE 仍拥有 App 内部任务 UI、导航和结果组件；Polo 只投影平台状态，不向 App 注入报价页、结果中转页或实现标签。

4. **关闭、后台与终止**
   - 关闭无活动执行的 App Tab 直接关闭；关闭有活动执行的 Tab 显示冻结的三选项：取消、后台继续、终止并关闭。
   - “后台继续”只移除 Tab/前台 WebView，运行记录继续存在并可从运行中心重新打开；“终止并关闭”发出一次 owner-scoped terminate 并等待终态确认。
   - 只有确认 `stopped` 后关闭 Tab。超时、失败、scope/generation 变化或同 ID replacement 均保持 Tab、原 ProductSpace 与可重试状态；不得复用仅服务于空间切换 token 的 `STOP_EXECUTION`，新增普通终止通道并复用 generation-safe drain。
   - Cmd/Ctrl+W、Tab 关闭按钮和运行中心终止统一走同一状态机。

5. **文件、结果与系统打开**
   - 最近文件 projection 合并三类既有事实：助手已保存附件、App 主动导入、AI/App 主动导出；按当前 account + ProductSpace 查询，workspaceId 作为独立归属字段，去重后按最近处理时间排序。
   - 不增加上传入口，也不扫描任意磁盘目录。App 上报路径须先 canonicalize，并限制在受信工作区、助手附件目录或该 runtime 的授权数据/导出目录；失效、符号链接逃逸或跨 scope 路径不入索引。
   - 文件名调用既有 `window.electronAPI.openFile(path)`，本机位置调用既有 `showInFolder(path)`；renderer 只传服务端回读的已验证 canonical path。
   - “已保存结果”只保存 App 显式声明的结果摘要和关联文件；不抓取 App 页面内容，不把普通任务完成自动等同为已保存结果。

6. **积分不足与充值恢复**
   - 只接受平台/计量边界给出的稳定 `insufficient_credit` 事实；renderer 不根据文案、余额或 HTTP 通用失败自行推断。
   - 当前 App Tab 顶部叠加 POL-94 非模态平台提示，WebView 和当前内容保持挂载。个人用户/企业 Owner 提供“去充值”，Manager/Member 提供“通知 Owner”；不显示余额、payer、Token、模型或内部计费字段。
   - “去充值”只在系统浏览器打开当前 ProductSpace 的支付中心，不选商品、不创建订单。返回客户端后展示“是否已完成充值？”。每次只有用户点击查询按钮才执行一轮受信恢复查询；没有 timer、interval、焦点触发查询或后台轮询。
   - 查询成功且平台确认已恢复时只移除阻断提示；处理中、未查到、查询失败或仍不足保持明确状态并允许用户再次点击。任何结果都不自动重放 App Run，也不自动点击 App 内任务按钮。

### 3. 文件级实施顺序

#### A. 共享契约与安全边界

- 新建 `packages/shared/src/product-spaces/app-runtime.ts`：runtime key、Tab/execution/history/result/file/platform-block 领域类型与 Zod 校验；`workspaceId` 与 runtime key 分离。
- 修改 `packages/shared/src/product-spaces/index.ts`：只导出上述公开契约。
- 修改 `packages/shared/src/protocol/channels.ts`、`packages/shared/src/protocol/routing.ts`：增加主 renderer 使用的 runtime center list/subscribe-or-refresh/terminate/recovery-query 通道；按数据所在位置将运行、日志、结果和本机文件标为 device-local，支付恢复查询走受信 Admin 代理。FDE App 的 run/result/file/AI 调用走下述 loopback API，不混入 renderer IPC。
- 修改 `packages/shared/src/protocol/local-apps.ts`：把 `ProductSpaceAppIdentity`/实际 versionId 纳入启动请求和结果，替代仅接收旧 `CatalogLocalAppScope` 的 ProductSpace 启动形态；保留 legacy 调用的显式兼容边界。
- 修改 `packages/shared/src/protocol/dto.ts`：增加最小 loopback App API 请求/响应 schema 与稳定平台错误码；请求只带 capability 和任务事实，不允许 scope/payer/价格字段由 App 提供。
- 修改 `packages/shared/src/product-spaces/paths.ts`、`packages/shared/src/admin/types.ts`、`packages/shared/src/admin/schemas.ts`、`packages/shared/src/admin/client.ts`：接入 POL-103 已存在的当前空间恢复查询能力，并校验返回值仍属于当前受信 ProductSpace。
- 修改 `packages/shared/src/product-spaces/__tests__/product-spaces.test.ts`、`packages/shared/src/admin/__tests__/client.test.ts`：覆盖 tuple 防碰撞、版本固定、跨空间响应拒绝、一次用户动作只产生一次查询。

#### B. Main/server-core runtime projection 与持久化

- 新建 `packages/server-core/src/runtime/app-runtime-center.ts`：活动执行 + 历史 + 结果 + 文件的单一 scope projection，原子持久化、上限裁剪、路径验证和订阅 revision。
- 新建 `packages/server-core/src/runtime/__tests__/app-runtime-center.isolated.ts`：覆盖 personal/enterprise 同名 App、同 artifact 不同版本、独立 workspaceId、崩溃重载、跨 scope 写入拒绝、文件逃逸与符号链接。
- 修改 `packages/server-core/src/runtime/product-space-executions.ts`：暴露普通 owner-scoped generation-safe 单项终止 primitive 和状态变化钩子；保持空间切换 stop token 语义不变。
- 修改 `packages/server-core/src/handlers/rpc/product-space.ts`：注册 runtime center 列表、普通终止和单次充值恢复查询；每次 await 前后复验 trusted account、活动 ProductSpace、context epoch 和 execution generation。
- 修改 `packages/server-core/src/handlers/rpc/index.ts`：注册新增 handler（若实现保持在 `product-space.ts` 内则只补相应导入/测试，不另建第二注册路径）。
- 修改 `packages/server-core/src/handlers/rpc/__tests__/product-space.isolated.ts`：覆盖关闭终止成功/失败、同 ID replacement、切换竞态、查询无轮询和跨空间不可见。

#### C. Electron App 启动、loopback API 与本机能力

- 修改 `apps/electron/src/main/handlers/local-apps.ts`：ProductSpace 启动必须消费完整固定版本 identity，修正当前 execution subject 将 `catalogAppId/name` 代填 `versionId/version` 的占位；runtime key、日志和 registry ref 都由受信 tuple 派生。
- 新建 `apps/electron/src/main/local-app-runtime/app-api-gateway.ts` 及对应 isolated test：在随机 loopback 端口提供版本化 App API，校验 per-launch capability，代理 App Run/AI 调用，并把平台错误、显式结果和文件事实写入唯一 runtime projection；不暴露通用 RPC 或 Admin 凭证。
- 修改 `apps/electron/src/main/local-app-runtime/manager.ts`、`apps/electron/src/main/local-app-runtime/index.ts`：在启动环境注入该次运行专用的 `POLO_APP_API_URL`/`POLO_APP_API_TOKEN`，将 capability 生命周期绑定到进程与固定 runtime identity，并在退出、终止、版本替换和 scope 失效时撤销。
- 修改 `apps/electron/src/main/index.ts`：随 Electron Main 启停 gateway，并确保监听失败时 App 启动 fail closed；不改变 WebView 的 Node/IPC 隔离。
- 修改 `apps/electron/src/preload/bootstrap.ts`、`apps/electron/src/shared/types.ts`、`apps/electron/src/transport/channel-map.ts`、`apps/electron/src/shared/__tests__/ipc-channels.test.ts`：向主 renderer 暴露 runtime center、普通终止和恢复查询 API；继续复用既有 `openFile/showInFolder`。
- 修改 `apps/electron/src/main/handlers/__tests__/local-apps.isolated.ts`：覆盖真实 versionId、同名跨空间隔离、handoff 过期/重复消费、启动/切换竞态、capability 伪造/重放/撤销和 gateway 启动失败。

#### D. Renderer 状态编排与 App Tabs

- 修改 `apps/electron/src/shared/tab-browser-types.ts`：为 App Tab 保存非秘密 launch context、runtime key、executionId 和平台阻断摘要；新增 `files`、`tasks-results` 两个 Polo 内置系统工具 tab 类型。
- 修改 `apps/electron/src/renderer/lib/product-space-app-launch-handoff.ts`：保持一次性 secret handoff，补 consumer 侧启动完成/失败后的明确销毁路径；禁止 credential 进入持久化 Tab。
- 新建 `apps/electron/src/renderer/context/AppRuntimeCenterContext.tsx`：按已提交 account/ProductSpace/contextVersion 读取唯一 projection、处理推送/重连全量刷新，并在 scope 切换时清空旧快照。
- 修改 `apps/electron/src/renderer/context/TabShellContext.tsx`、`apps/electron/src/renderer/atoms/tab-browser.ts`：消费 POO-43 launch 通知、启动并打开固定版本 Tab；实现统一异步 close state machine、后台 reopen 和内置工具 tab。
- 修改 `apps/electron/src/renderer/components/app-shell/TopBar.tsx` 及其 registry/runtime 交互测试：用共享 runtime context 替换当前独立 registry poller/dialog，在现有顶栏入口挂载运行中心，避免新增第二个入口或第二份状态。
- 修改 `apps/electron/src/renderer/components/tab-browser/TabShell.tsx`、`TabBar.tsx`：Tab 活动状态和所有关闭入口接入同一 context；窄窗继续 fail closed。
- 修改 `apps/electron/src/renderer/components/tab-browser/TabContent.tsx`、`WebAppView.tsx`：保持后台 App 内容/进程语义并承接平台 banner；App 内部导航仍留在同一个 Tab，且不向 guest 开放 Node/任意 IPC。
- 修改 `apps/electron/src/renderer/App.tsx`：把 runtime center provider 放在受 ProductSpace contextVersion 约束且能覆盖 TabShell 的位置，切换时不得闪现旧空间状态。

#### E. 运行中心、任务与结果、文件和充值 UI

- 新建 `apps/electron/src/renderer/components/app-runtime/RuntimeCenterPopover.tsx`：显示当前空间活动/后台/失败状态并跳转“任务与结果”。
- 新建 `apps/electron/src/renderer/components/app-runtime/TaskResultsPage.tsx`：用同一 projection 展示当前执行、失败/终止历史与已保存结果，支持打开 App 和 owner-scoped 终止。
- 新建 `apps/electron/src/renderer/components/app-runtime/FilesPage.tsx`：最近文件列表、搜索、来源、位置、时间和大小；只提供默认应用打开与 Finder 定位，无上传入口。
- 新建 `apps/electron/src/renderer/components/app-runtime/AppPlatformBlockBanner.tsx`、`RechargeRecoveryDialog.tsx`：实现 POL-94 非模态阻断、角色动作和显式单次查询状态机。
- 修改 `apps/electron/src/renderer/components/tab-browser/HomePage.tsx`：补 POO-41 冻结的“文件”“任务与结果”系统工具入口及运行数摘要，不改变 POO-43 Catalog/安装/首页快捷入口职责。
- 修改 `apps/electron/src/renderer/index.css` 并新增组件级样式（优先复用 token/primitive）：匹配 POO-41/POL-94 的 top bar、popover、table/card、banner/dialog，不复制原型源码或资产。
- 增加对应 interaction tests：`apps/electron/src/renderer/components/app-runtime/__tests__/RuntimeCenter.interaction.isolated.tsx`、`TaskResultsPage.interaction.isolated.tsx`、`FilesPage.interaction.isolated.tsx`、`CreditRecovery.interaction.isolated.tsx`，并扩展 `TabShell.scope-isolation.isolated.ts` 与 `HomePage.round2.interaction.isolated.ts`。

### 4. 验证与完成证据

1. **静态与单测**：运行共享包、server-core、Electron Main/Renderer 的 targeted tests，再运行仓库既有 typecheck、lint 和完整测试命令；不得通过修改测试来掩盖失败。
2. **隔离矩阵**：建立 personal-A / enterprise-B、同名 App、相同 artifact display name、不同 version/workspace 的 fixtures；验证 runtime key、安装状态、日志、活动状态、历史、结果、文件均无交叉读取或写入。
3. **关闭时序**：验证无运行直接关、后台继续、终止成功、终止超时/失败、终止期间同 ID replacement、Cmd/Ctrl+W，与空间切换并发；失败时仍在原空间且 Tab 可恢复。
4. **版本固定**：打开 v1 后模拟 Catalog 更新到 v2；活动 Tab、运行中心、日志和结果仍指向 v1，新启动才使用 v2。
5. **文件系统**：在 macOS 验证文件名调用默认应用、位置调用 Finder 并定位父目录；覆盖空格/Unicode、不存在文件、符号链接逃逸、跨空间路径和无上传按钮。
6. **积分恢复**：注入稳定 `insufficient_credit`，验证 App/WebView 不卸载；点击“去充值”只打开当前 ProductSpace 支付中心；无轮询；每次用户点击只调用一次查询；恢复后只解除 banner，不重试原任务。企业 Owner 与 Manager/Member 动作分别验收。
7. **视觉 parity**：用 POO-41 shell 与 POL-94 第二轮客户端原型作为只读基准，在 1440×900、1024×768、390×844 截图；1440/1024 核对 App Tab、运行中心、任务结果、文件、积分 banner/dialog，390 核对冻结窄窗保护且无旧空间内容。记录差异阈值、截图路径和人工视觉结论。
8. **交付证明**：在实现/Review/Acceptance 分别记录 commit、测试日志、截图、当前 HEAD；合并前证明分支基于已集成 POO-43，合并后再证明目标分支与远端状态。`Coding Pass` 不等同于交付完成。

### 5. 风险与缓解

- **POO-43 未集成且工作树仍有未提交改动**：直接编码会复制、遗漏或冲突其安全修复。缓解：只把最终集成提交作为硬前置，更新基线后重新核对文件清单。
- **活动状态与历史双写漂移**：renderer 自建状态会使运行中心和任务结果不一致。缓解：单一 Main/server-core projection + revision/reconnect 全量刷新。
- **版本身份被旧 scope 降级**：当前 local-app 注册代码仍以 catalog app/name 代填版本。缓解：启动请求携带完整受信 identity，测试断言 versionId/version 不可从 display 字段推导。
- **loopback API capability 泄漏或重放**：恶意本机进程可能伪造空间、文件路径或结果归属。缓解：随机端口 + per-launch 高熵短期 capability、Main 重派生 scope、进程/epoch 绑定撤销、路径 canonicalization、受信根目录 allowlist，并测试跨运行重放必拒绝。
- **终止竞态**：等待 stop 时发生切换或 execution replacement，可能错误关 Tab。缓解：复用 generation CAS 和终态 drain；任何不确定都保留 Tab/记录并显示可重试失败。
- **积分恢复变成隐式轮询/重试**：window focus、定时器或查询成功回调可能触发额外动作。缓解：recovery reducer 只有按钮事件发请求，测试 fake timers + 调用计数，并断言不调用 App Run start。
- **390 视觉权威冲突**：POL-94 提供 390 App 场景，而 POO-41 冻结 390 为窄窗保护。缓解：保留 POO-41 外壳行为；只有明确批准改变冻结交互后才在 390 渲染 App 工作面。

### 6. 非范围与不采用方案

- 不修改 Catalog 来源、安装授权、首页快捷入口规则、FDE 内部任务 UI、Polo 助手会话/Skills/执行上下文、固定报价或支付下单。
- 不把 `workspaceId` 塞入 runtime key：这会违背本卡显式键规范；它作为 execution/tab/result/file 的独立字段保留。
- 不按 App 名称或 URL 识别实例：同名和 URL 变化会碰撞或泄漏；只用受信 account/ProductSpace/artifact/version identity。
- 不让运行中心和任务结果各自轮询：会产生竞态与不一致；共享 projection，只有 transport reconnect 做一次全量刷新。
- 不在 renderer 解析通用错误文案判断积分不足：必须使用平台稳定错误码。
- 不扫描磁盘构建“文件”，不新增上传按钮，不自动保存所有 App 输出。
- 不把现有 switch-token `STOP_EXECUTION` 用作普通终止：其所有权语义不同，复用会削弱切换事务边界。

### 7. 条件确认、文件分类与 Re-pin

- 2026-09-08 已确认执行链 `POO-47 → POO-44 → POO-48 → POO-52 → POO-49`，以及 POO 基线 `integration/pol68-g5-client`；无需再次询问这两个选择。
- 该确认不是最终 `accepted`：POO-43 仍在独立 Acceptance，尚未集成。当前 POO-43 干净 HEAD 为 `76ce05228a84ae1e66f14091e97d15661423522f`，当前 POO-47 worktree 与集成基线仍是 `6cbdf573961776c4e69a9d990fd943d418a9b71d`。
- POO-43 完成并集成后，先自动 re-pin：记录新的 `integration/pol68-g5-client@sha`、POO-43 集成提交、当前 task rev；逐项检查 launch handoff、Catalog identity、Tab/WebView 与 execution API 的真实路径，再删除/合并重复候选。

| 分类 | 文件/职责 |
|---|---|
| existing | 当前基线的 `packages/shared/src/product-spaces/*`、`packages/server-core/src/runtime/product-space-executions.ts`、`packages/server-core/src/handlers/rpc/product-space.ts`、`apps/electron/src/main/local-app-runtime/*`、`apps/electron/src/renderer/components/tab-browser/*`、`apps/electron/src/renderer/App.tsx`、`openFile/showInFolder` |
| upstream-expected | POO-43 最终 `product-space-app-launch-handoff.ts`、Catalog/安装/resolve-launch、固定版本 identity 与首页/App 打开路径；re-pin 前不得按当前分支形态锁死 |
| new-by-this-task | `packages/shared/src/product-spaces/app-runtime.ts`、`packages/server-core/src/runtime/app-runtime-center.ts`、loopback `app-api-gateway.ts`、`AppRuntimeCenterContext.tsx` 与 `components/app-runtime/*`，以 re-pin 后不存在同职责实现为前提 |

### 8. 平台通知契约缺口与推荐裁决

- POL-94 权威交互要求 Manager/Member 只能“通知 Owner”，且同一限制事件跨设备幂等；通知只含成员、企业、发生时间和来源 App/Polo 助手，不含 Prompt、输入、文件、输出、余额或 payer。
- 当前探索未在 admin 支付 API 中发现专用 notify-owner command。仅在 renderer 显示“已通知”会伪造交付，不能接受。
- 推荐把通知作为 POO-47 平台阻断的共享动作契约：服务端根据 business session、ProductSpace 和受信 `restrictionEventId` 解析唯一 Owner，提供幂等 command；客户端只提交 eventId/当前 ProductSpace，不提交收件人。App 和后续 POO-49 助手恢复复用同一 API。
- 若 POO-43 re-pin 后该 API 仍不存在，需由 POL-94/POL-103 的 API owner确认落点或建立明确上游任务；在契约落地前，POO-47 Plan 保持 `awaiting-upstream-repin`，不得用本地 toast、邮件链接或无送达证明的按钮替代。
- 在共享契约/文件清单中补充 notify-owner request/result schema、Admin client/RPC/preload 通道；在 `product-space.isolated.ts` 与 `CreditRecovery.interaction.isolated.tsx` 增加同 event 幂等、跨空间拒绝、迟到 scope 拒绝和敏感字段 canary 测试。

### 9. 最终接受清单

- [ ] POO-43 已 Acceptance、commit/push 并集成到 `integration/pol68-g5-client`。
- [ ] POO-47 分支已 fast-forward/rebase 到新的集成 SHA，工作树干净。
- [ ] 所有 `upstream-expected` 已解析为实际 `existing` 路径；不存在与上游重复的 runtime/Tab/projection。
- [ ] notify-owner 已有真实 server owner、幂等键、最小隐私 payload 和客户端调用路径，或有明确阻塞任务/裁决。
- [ ] runtime key、workspace 独立字段、关闭状态机、文件 allowlist、单次查询与三视口视觉规则针对新基线重审。
- [ ] 负责人接受 re-pin 后的最终文件清单与风险；此时才将状态改为 `accepted` 并进入只读 `goal-autopilot`，之后另行确认 `--active`。

## 2026-09-09 Scope 拆分与执行入口

状态：`coordination-only`。本卡保留原始 Intent、Spec、条件 Plan 与历史证据，但不再拥有产品代码 commit、实现 worktree 或 Ultra 执行；以下普通子卡是唯一实现入口。

### 子任务与显式依赖

- POO-54：建立受信 ProductSpace App Runtime 基础；依赖 POO-43 Acceptance、push 并集成。
- POO-55：实现 ProductSpace App Tab 生命周期；依赖 POO-54 完成并集成。
- POO-56：实现运行中心与任务结果统一投影；依赖 POO-55 完成并集成。
- POO-57：实现 ProductSpace 最近文件入口；依赖 POO-54 完成并集成。
- POO-58：实现 App 平台积分阻断与人工恢复；依赖 POO-54 完成并集成。

### 协调完成条件

- POO-54、POO-55、POO-56、POO-57、POO-58 全部通过各自 Acceptance、commit/push、远端相等和集成证明后，本协调卡才可完成。
- POO-44 必须显式等待上述五张子卡全部集成；不得以本父卡的旧 Plan 或历史 WIP 作为实现基线。
- 每张子卡仍是 `awaiting-upstream-repin`；直接前置集成后才运行 plan-first 重锁真实路径、文件/行数上界和技术会签。

## 2026-09-09 POO-54 技术签核拆分补充

- POO-67：建立无会话无工具 Host LLM Executor；依赖 POO-43，完成并集成后解锁 POO-54 的重新 re-pin。
- POO-54 不得使用 session-scoped `call_llm`、隐藏聊天 Session 或未集成的 POO-67 分支实现冒充 Host Executor。
- 协调顺序更新为：POO-43（已集成）→ POO-67 → POO-54 → POO-55/POO-57；POO-56 仍等待 POO-55，POO-58 仍等待 POO-54。
- 本协调卡的完成条件增加 POO-67 的 Acceptance、commit/push、远端相等与 Client integration 证明。

