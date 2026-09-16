父任务：POL-68
内部编号：P02

## 目标

只实现 Polo 客户端成员首页、当前 ProductSpace Catalog、安装授权和直接打开入口；确保所有可访问 App 可查找、来源可辨认、安装与首页快捷入口不混淆。本卡不再实现 App Tabs、Runtime、运行中心、结果、文件或积分阻断。

## 权威输入

- `docs/polo-client-user-flows.md`
- `docs/product-space-operation-contract.md`
- `docs/refactor-model-map.md` 的 P02
- POO-41 客户端 UI v1 冻结产物

## 前置依赖

- POL-87 Catalog 权威来源。
- POO-42 ProductSpaceContext 与安全切换。
- POO-41 UI v1 已冻结。

## 范围

- 首页只读取当前 ProductSpace Catalog，固定展示 Polo 助手，并允许最多 5 个工作 App 作为快捷入口。
- “当前空间全部 Apps”展示当前空间所有可访问 App；首页容量不会隐藏目录中的 App。
- 个人空间按圈子来源轻量分组，同名但不同 artifact instance 分别展示并标明来源；企业空间只展示当前企业向成员分发的 Apps。
- 安装、卸载、可用性、治理/授权阻断和直接打开使用当前 ProductSpace 权威上下文。
- “管理首页 Apps”只调整快捷入口，不等于安装、卸载或旁加载。
- 移除或封闭普通用户 External App 与 legacy sideload 入口。
- 企业成员管理与创作者发布只显示状态和带上下文跳转，不复制写流程。
- 用户界面统一称 App，不暴露 Web App、localhost、FDE、本地/远程或沙箱类型。

## 子任务索引

- POO-47：实现 App Tabs、Runtime、运行中心、任务结果、文件与平台积分阻断；等待 POL-87 → POO-42 → 本卡，并等待 POL-102、POL-103。

## 非目标

- App Tabs、runtime key、后台/终止、运行中心、任务结果、最近文件和平台级积分阻断由 POO-47 实现。
- FDE App 内部任务 UI 不属于 Polo。
- Polo 助手会话、附件、Skills 与积分不足恢复不在本卡。
- 不允许普通用户旁加载未知作品，不把 Skill 渲染为独立 App、首页卡片或 Tab。

## 验收标准

1. 未在当前 ProductSpace Catalog 的作品无法安装或打开，深链、旧 ID 和跨空间 artifact instance fail closed。
2. 首页最多 6 个快捷入口，但“当前空间全部 Apps”能看到并直接打开所有可访问 App。
3. personal/enterprise 的 Catalog、安装状态和首页配置不共享；同名不同来源作品不合并。
4. “管理首页 Apps”只改变快捷入口，External App/legacy sideload 不可绕过授权。
5. App 直接打开携带固定 ProductSpace、artifact instance 和版本上下文，并交给 POO-47 Runtime，不在本卡重复实现运行状态。
6. 页面结构、文案、空/加载/失败/受限状态符合 POO-41 UI v1。

## 视觉验收

- 按 POO-41 UI v1 执行 1440×900、1024×768、390×844 parity 验收；只引用冻结设计，不复制设计产物。

## 自动继续与暂停规则

Catalog 查询、安装缓存和首页配置存储由研发决定。只有 ProductSpace/Catalog 所有权、安装权限或冻结页面结构需要改变时暂停裁决。
