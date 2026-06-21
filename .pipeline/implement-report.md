# POL-32 实现报告

## 变更摘要
- 左侧边栏底部新增登录用户菜单：头像首字母渐变、显示名、向上弹出菜单、用户信息、月度用量进度条、个人信息、Settings、What's New、登出。
- Settings 与 What's New 从侧边栏导航项移入用户菜单；键盘导航列表同步移除这两个 nav item。
- 登出走 `admin:logout`，成功后清理前端会话/工作区/模型状态并回到 Admin 登录流程。
- 模型选择器增加管理员锁定表现：触发按钮显示锁图标，多连接模型列表改为扁平管理员模型列表，行内展示 provider 图标、模型名、provider/connection 名，选中项打勾；选择模型时同步更新默认 connection 和该 connection 的 defaultModel。

## 关键文件列表
- `apps/electron/src/renderer/App.tsx`
- `apps/electron/src/renderer/context/AppShellContext.tsx`
- `apps/electron/src/renderer/components/app-shell/AppShell.tsx`
- `apps/electron/src/renderer/components/app-shell/LeftSidebar.tsx`
- `apps/electron/src/renderer/components/app-shell/input/FreeFormInput.tsx`
- `apps/electron/src/renderer/components/app-shell/input/CompactModelSelector.tsx`

## 自测结果
- `bun install --frozen-lockfile`：通过，用于补齐本地缺失的 `tsc`/类型依赖，未修改 lockfile。
- `bun run typecheck:all`：通过。
- 先前在依赖缺失时执行过 `bun run typecheck:all` / `bun run typecheck:electron`，失败原因是本地没有可用 `tsc`，安装依赖后已通过完整类型检查。

## 遗留问题
- 当前仓库未发现真实月度 quota/usage RPC 字段，用户菜单的用量组件已按 `used/total/resetDate` 数据结构实现状态色和文案，并提供默认展示数据；后续接入真实 Admin quota 数据时只需传入 `quota`。
