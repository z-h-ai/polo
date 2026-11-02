# poo196-project-context（POO-196 真机体验评审 harness）

真实 Electron + 生产 renderer 模块的体验评审钉子。仿既有配方 `apps/electron/e2e/product-closure-20261027/`。

## 运行

```bash
node apps/electron/e2e/poo196-project-context/run.mjs
# 退出码 0 = 全部检查通过；证据落 /tmp/poo196-experience/evidence/
```

可调环境变量：`POO196_BUILD_DIR`（默认 /tmp/poo196-experience/build）、`POO196_EVIDENCE_DIR`（默认 /tmp/poo196-experience/evidence）。

## 夹具边界（窗口管理 / IPC / 登录态为桩，其余生产源码）

- `pages/host.tsx`：以生产 Provider 栈（Jotai / Theme / Focus / EscapeInterrupt / DismissibleLayer / Modal / Navigation / ProductSpace / AppShell / Tooltip）挂载**生产 ChatPage**——由此组合出 ProjectContextTabs / ProjectFileLibrary / AssetRow / AssetUploadDialog / AssetReplaceDialog / ProjectPinPane / ProjectTrashView / AssetMentionPopover / ProjectAssetChip / ChatDisplay / FreeFormInput。两个会话 fixture：项目会话（productSpaceId + enterprise space）与非项目会话，经生产 atom 写入路径（`replaceLoadedSessionAtom`）预置。
- `preload.ts`：electronAPI 中 15 个 `pc*` 方法转发主进程可编程 fixture（`fixture-pc`），并按生产 `build-api.ts` codedErrors 的方式桥接编码错误（code 随 message 过桥，`readRpcErrorCode` 解码）；`getSessionMessages` / `openFileDialog` / `readFileBinary` / `getHomeDir` 等按场景应答；其余 renderer 用到的 electronAPI 方法以中性值应答（不透传调用参数，避免不可克隆负载）。注意：**不能用 Proxy 兜底**——contextBridge 无法克隆 Proxy，会导致整个 preload 加载失败。
- `main.ts`：fixture 状态机（资产/能力/搜索索引/延迟/故障注入/文件对话框队列/预览授权 HTTP 服务）+ 13 个评审场景编排 + console 观测（自首个 webContents 起）+ 截图（BrowserWindow.capturePage，1440×900）+ runtime.json / pc-calls.json 留痕。
- `fixture-data.ts`：真实感中文项目内容（需求文档 v2.3、设计稿-首页、会议纪要-1030、原型演示-首页.html 等；indexed/processing/failed/unsupported 多状态、已确认/未确认、pinned、trashed、多版本、多上传者、de 长名资产）。

## 可编程通道（fixture-program）

场景运行中可注入：`setFault`（按方法注入 `pc_*` 错误码，支持 once）、`setLatency`、`setCapabilities`、`setDegraded`（搜索降级）、`queueFileDialog`、`indexAsset` / `bumpAssetVersion`（模拟他人并发变更）、`add100Assets`、`resetAssets`、`pcCallStats`。

## 驱动方式

`executeJavaScript` 探针 + `webContents.sendInputEvent`（真实 char/key/mouse 事件）+ 生产 `craft:submit-input` 事件（模拟按下发送）。Radix 触发器/菜单优先走生产键盘路径（focus + Enter，与浮层提示「↑↓ 选择 · Enter 确认」一致），合成 pointer 作备选——合成 pointerdown 在 Radix 触发器上不稳定。
