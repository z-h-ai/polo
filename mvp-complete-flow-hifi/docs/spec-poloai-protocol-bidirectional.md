---
title: poloai:// 协议双向化——Web App 调用 Polo AI 能力
task_id: POO-1
created: 2026-07-07
---

# poloai:// 协议双向化 Spec

## 1. 背景与目标

### 1.1 现状

`poloai://` 是 Polo AI 桌面端的自定义 URL Scheme，目前是**单向**的：

- Web App（标签页浏览器中通过 `<webview>` 标签加载的外部网页）可以通过导航到 `poloai://action/new-session?input=...&send=true` 触发创建会话并发送消息；
- `<webview>` 处于严格沙箱（`webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"`、无 preload 脚本、`partition="persist:browser-pane"`），除了 `poloai://` URL 导航外没有任何与宿主通信的通道；
- 请求发出后，Web App **无法得知结果**：不知道会话是否创建成功、sessionId 是什么，更收不到 AI 的流式回复。

### 1.2 目标

把 `poloai://` 协议改造成**双向**协议：

- **请求方向不变**：Web App 仍通过 `poloai://` URL 发起请求（`will-navigate` / `window.open` 拦截），零依赖、零 SDK；
- **新增响应通道**：主进程通过 `webContents.fromId(webContentsId).executeJavaScript()` 向 `<webview>` 页面派发 `window.postMessage()`，把执行结果（ack）和会话流式事件（text_delta / complete / error 等）回传给 Web App；
- 请求与响应通过 Web App 自己生成的 `callbackId` 关联；
- **完全向后兼容**：不带 `callbackId` 的 URL 行为与现在完全一致。

### 1.3 非目标

- 不新增 preload 脚本、不暴露 `window.poloai` Bridge API（另案讨论）；
- 不改变 pageView 的沙箱与隔离配置；
- 不向 Web App 暴露会话管理类敏感操作（删除会话、改权限模式等）的回调结果之外的能力扩展；
- 不涉及 WebUI / headless server 场景（那条链路走 WsRpcClient，已有方案）。

## 2. 协议设计

### 2.1 请求：URL 格式扩展

在现有 action 路由上新增可选查询参数 `callbackId`：

```text
poloai://action/new-session?input=<encoded>&send=true&callbackId=<uuid>
poloai://action/send-message/{sessionId}?input=<encoded>&callbackId=<uuid>   ← 新增 action（多轮对话）
```

- `callbackId`：由 Web App 生成（建议 `crypto.randomUUID()`），格式校验 `^[A-Za-z0-9-]{8,64}$`，不合法则按无 callbackId 处理；
- 带 `callbackId` 的请求隐含"发起方需要回执"，主进程会登记回调并回传结果；
- 新增 action `send-message/{sessionId}`：向已有会话追加消息，支持多轮对话（仅允许操作由同一 webContents 通过本协议创建的会话，防止 Web App 干预用户的其他会话）。

### 2.2 响应：postMessage 消息格式

主进程通过 `pageView.webContents.executeJavaScript()` 在页面上下文中执行 `window.postMessage(payload, origin)` 回传。所有消息统一信封：

```typescript
interface PoloaiProtocolMessage {
  type: 'poloai:ack' | 'poloai:event' | 'poloai:error'
  callbackId: string
  // type === 'poloai:ack'：action 已受理
  result?: { sessionId?: string }
  // type === 'poloai:event'：会话流式事件（白名单过滤后）
  event?: {
    type: 'text_delta' | 'text_complete' | 'tool_start' | 'tool_result' | 'complete' | 'error' | 'interrupted'
    sessionId: string
    delta?: string        // text_delta
    text?: string         // text_complete
    toolName?: string     // tool_start / tool_result（仅名称，不含 input/result 详情）
    error?: string        // error
  }
  // type === 'poloai:error'：action 执行失败
  error?: { code: string; message: string }
}
```

错误码（`poloai:error`）：

| code | 含义 |
|------|------|
| `invalid_action` | action 不存在或参数非法 |
| `session_not_found` | send-message 指向的会话不存在或不属于该回调源 |
| `not_authorized` | 会话非本 webContents 通过协议创建，拒绝操作 |
| `internal_error` | 其余执行异常 |

### 2.3 Web App 端完整用法示例

```javascript
const callbackId = crypto.randomUUID()
let sessionId = null

window.addEventListener('message', (e) => {
  const msg = e.data
  if (!msg || msg.callbackId !== callbackId) return

  if (msg.type === 'poloai:ack') {
    sessionId = msg.result.sessionId          // 拿到会话 ID，可用于后续 send-message
  } else if (msg.type === 'poloai:event') {
    if (msg.event.type === 'text_delta')  appendText(msg.event.delta)
    if (msg.event.type === 'complete')    onDone()
    if (msg.event.type === 'error')       onError(msg.event.error)
  } else if (msg.type === 'poloai:error') {
    onError(msg.error.message)
  }
})

// 首轮：创建会话并发送
location.href = `poloai://action/new-session?input=${encodeURIComponent('帮我分析这份数据')}&send=true&callbackId=${callbackId}`

// 多轮：向同一会话追加（复用同一 callbackId 继续收流）
function followUp(text) {
  location.href = `poloai://action/send-message/${sessionId}?input=${encodeURIComponent(text)}&callbackId=${callbackId}`
}
```

### 2.4 Web App 接入指南

Web App 不需要引入 SDK，也不能依赖 Electron preload。唯一要求是：

1. 为每条会话链路生成一个 `callbackId`，建议使用 `crypto.randomUUID()`；
2. 在触发 `poloai://` URL 前注册 `window.addEventListener('message', ...)`；
3. 只处理 `e.data.type` 以 `poloai:` 开头且 `e.data.callbackId` 与当前请求一致的消息；
4. 在首轮 `poloai:ack` 中保存 `result.sessionId`，后续追问使用 `poloai://action/send-message/{sessionId}`。

消息由宿主在页面上下文中执行 `window.postMessage(payload, pageOrigin)` 派发，因此 `message` 事件中 `e.source === window`、`e.origin` 为页面自身 origin 属于预期行为。Web App 仍应校验 `callbackId`，避免处理自己页面内其他脚本产生的同名消息。

推荐封装：

```javascript
function createPoloaiConversation({ onDelta, onDone, onError }) {
  const callbackId = crypto.randomUUID()
  let sessionId = null
  let supported = false

  const off = () => window.removeEventListener('message', onMessage)

  function onMessage(e) {
    const msg = e.data
    if (!msg || typeof msg.type !== 'string') return
    if (!msg.type.startsWith('poloai:') || msg.callbackId !== callbackId) return

    supported = true
    if (msg.type === 'poloai:ack') {
      sessionId = msg.result?.sessionId ?? sessionId
      return
    }
    if (msg.type === 'poloai:error') {
      onError?.(msg.error?.message || 'Polo AI request failed')
      return
    }
    if (msg.type === 'poloai:event') {
      if (msg.event?.type === 'text_delta') onDelta?.(msg.event.delta || '')
      if (msg.event?.type === 'complete') onDone?.()
      if (msg.event?.type === 'error') onError?.(msg.event.error || 'Polo AI session failed')
    }
  }

  window.addEventListener('message', onMessage)

  return {
    callbackId,
    get sessionId() {
      return sessionId
    },
    send(text) {
      const input = encodeURIComponent(text)
      if (!sessionId) {
        location.href = `poloai://action/new-session?input=${input}&send=true&callbackId=${callbackId}`
      } else {
        location.href = `poloai://action/send-message/${sessionId}?input=${input}&callbackId=${callbackId}`
      }
    },
    off,
    isSupported() {
      return supported
    },
  }
}
```

兼容旧版本桌面端时，Web App 可以在发起首轮请求后设置超时。如果超时内没有收到 `poloai:ack` 或 `poloai:error`，说明宿主可能只支持旧的单向协议，应提示用户升级或退化为无回调体验。

桌面端内置测试页：开发模式可在标签页浏览器中打开 `http://localhost:5173/poloai-protocol-test.html`，打包后对应构建产物为 `poloai-protocol-test.html`。该页面只使用 URL 导航和 `window.postMessage`，可用于手动验证 ack、流式事件和多轮追问。

## 3. 架构与数据流

```
Web App (<webview> 标签, 沙箱隔离, partition="persist:browser-pane")
  │ location.href = "poloai://action/new-session?...&callbackId=X"
  ▼
browser-pane-manager  will-navigate / setWindowOpenHandler 拦截
  │ handleDeepLinkUrl(url, sourceWebContentsId)      ← 新增：记录 <webview> 的 webContents.id
  ▼
deep-link.ts  parseDeepLink() 解析出 callbackId       ← 新增字段
  │ handleDeepLink() 登记 CallbackRegistry[X] = { webContentsId, ... }
  │ IPC deeplink:navigate → renderer
  ▼
NavigationContext.handleActionNavigation()
  │ 执行 new-session / send-message（复用现有 API）
  │ IPC deeplink:action-result → main                ← 新增：回报 { callbackId, sessionId | error }
  ▼
main  DeepLinkCallbackBridge
  │ 1. webContents.fromId(wcId) 获取 <webview> 的 webContents
  │ 2. 向来源 <webview> 派发 poloai:ack / poloai:error
  │ 3. 订阅该 sessionId 的 session:event（server-core 在主进程内）
  │ 4. 白名单过滤后逐条 executeJavaScript → window.postMessage(poloai:event)
  ▼
Web App 收到 ack + 流式事件
```

关键点：

- **来源绑定**：拦截时即记录发起导航的 `<webview>` 的 `webContents.id`，回调通过 `webContents.fromId()` 定位到该 webview，只发给这个 webContents，其他窗口/页面收不到；
- **事件订阅在主进程**：Electron 形态下 server-core 运行在主进程内，`DeepLinkCallbackBridge` 直接挂 SessionManager 的事件广播，不经 renderer 中转，避免 renderer 关闭导致断流；
- **renderer 只多做一件事**：action 执行完把结果（sessionId 或错误）连同 callbackId 回报主进程。

## 4. 实现改动清单

### 4.1 `apps/electron/src/main/deep-link.ts`

- `parseDeepLink()`：解析并校验 `callbackId` 查询参数，加入返回结构 `DeepLinkTarget`（现有类型名）；
- `handleDeepLink()`：现有签名已含 `resolveClientId?: (webContentsId: number) => string | undefined`，可复用此参数体系传入 `sourceWebContentsId`，不需要新增参数；在函数体内，有 callbackId 且有来源时写入 CallbackRegistry；
- 支持新 action 路由 `action/send-message/{sessionId}`。

### 4.2 `apps/electron/src/main/deep-link-callback-bridge.ts`（新增）

- `CallbackRegistry`：`Map<callbackId, { webContentsId, sessionId?, createdAt, lastActiveAt }>`；
- 接收 renderer 的 `deeplink:action-result`，派发 `poloai:ack` / `poloai:error`；
- 订阅 session 事件，按白名单过滤后派发 `poloai:event`；
- 派发实现：通过 `webContents.fromId(wcId)` 获取 `<webview>` 的 webContents，再执行 `wc.executeJavaScript('window.postMessage(' + JSON.stringify(payload) + ', ' + JSON.stringify(pageOrigin) + ')')`，`pageOrigin` 取当前页面 origin；若 `webContents.fromId()` 返回 undefined（webview 已销毁）或页面已跳走则静默丢弃；
- 生命周期清理（见 §5.3）。

### 4.3 `apps/electron/src/main/browser-pane-manager.ts`

- `will-navigate` / `setWindowOpenHandler` 拦截处把 `<webview>` 的 `webContents.id` 传给 `handleDeepLinkUrl`；
- `<webview>` 主导航（`did-start-navigation` 且非 in-page）时通知 bridge 清理该 webContents 的回调。

### 4.4 `apps/electron/src/renderer/contexts/NavigationContext.tsx`

- `handleActionNavigation()`：
  - `new-session` 分支执行后，若 actionParams 带 callbackId，通过新 IPC `deeplink:action-result` 回报 `{ callbackId, sessionId }`；失败回报 error；
  - 新增 `send-message` 分支：校验后调用现有 `sendMessage` API，同样回报结果。

### 4.5 `packages/shared/src/protocol/`（channels / dto）

- 新增 IPC channel 常量 `deeplink:action-result`；
- 在 `DeepLinkNavigation` 类型（dto.ts）中新增 `callbackId?: string` 字段（注意：该类型已有 `tabType`/`tabParams` 字段用于标签页浏览器，需保持兼容）；
- 新增 `PoloaiProtocolMessage` 类型定义（放 shared，Web App 文档引用同一份定义）。

### 4.6 文档

- `docs/` 新增（或扩写现有协议文档）"poloai:// 双向协议——Web App 接入指南"，含完整示例、事件白名单、错误码表。

## 5. 安全设计

### 5.1 来源与会话隔离

- 回调消息只发给发起请求的 `webContents`；
- `send-message` 只能操作**同一 webContents 通过本协议创建**的会话（CallbackRegistry 中有绑定记录），否则 `not_authorized`；
- Web App 无法通过协议读取、枚举或操作用户的其他会话。

### 5.2 事件白名单

只转发 §2.2 列出的 7 种事件类型；明确**不转发**：

- `permission_request` / `credential_request`（权限与凭据交互只在宿主 UI 完成）；
- `tool_start` / `tool_result` 只带 `toolName`，剥离 `toolInput` / `result` 详情（可能含文件路径、命令输出等宿主敏感信息）。

### 5.3 生命周期与资源清理

- `<webview>` 发生主导航或销毁 → 清理该 webContents 名下所有回调与事件订阅；
- 会话收到 `complete` 后回调保留（支持多轮），但空闲超过 **30 分钟**（`lastActiveAt`）自动清理；
- 单个 webContents 同时活跃的 callbackId 上限 **8** 个，超出返回 `poloai:error`（`invalid_action`，message 说明超限）。

### 5.4 权限模式

- 通过协议创建的会话默认 `permissionMode: 'safe'`；URL 里的 `mode=` 参数对协议来源**不放行 `allow-all`**（静默降级为 `ask`），避免网页诱导执行任意命令；
- 会话在宿主 UI 中正常可见（不使用 `hidden`），用户可随时接管、审批或终止。

### 5.5 Web App 侧校验建议（写入文档）

- 校验 `e.data.type` 前缀为 `poloai:` 且 `callbackId` 匹配自己生成的值；
- 由于消息经页面上下文派发，`e.source === window`、`e.origin` 为页面自身 origin，属预期行为，文档中说明。

## 6. 兼容性

- 不带 `callbackId`：解析、路由、执行全部走现有路径，行为零变化；
- 旧版本桌面端收到带 `callbackId` 的 URL：多余查询参数被忽略，退化为单向（Web App 收不到回调即知宿主不支持，文档建议加超时探测）；
- `POLO_AI_DEEPLINK_SCHEME` 环境变量多实例机制不受影响。

## 7. 测试计划

- **单元测试**
  - `parseDeepLink()`：callbackId 提取、非法格式忽略、`send-message/{id}` 路由解析；
  - `DeepLinkCallbackBridge`：ack/error/event 派发、白名单过滤、导航清理、TTL 清理、上限控制、`not_authorized` 判定；
  - 存量 deep-link 测试（`deep-link-routing.test.ts`）全部保持通过。
- **集成/手动验收**（Electron 内建一个测试 Web App 页面）
  1. Web App 发起 `new-session?...&callbackId=X` → 收到 ack（含 sessionId）→ 持续收到 text_delta → 收到 complete；宿主会话列表中出现该会话；
  2. 用 `send-message` 追加第二轮 → 继续收流；
  3. 另开一个 Web App 用他人 sessionId 调 `send-message` → 收到 `not_authorized`；
  4. 流式过程中刷新/跳转页面 → 主进程无报错，订阅被清理；
  5. 不带 callbackId 的老 URL → 行为与现在一致；
  6. URL 带 `mode=allow-all` → 实际会话为 `ask` 模式。

## 8. 验收标准

- [ ] Web App 仅靠标准 Web API（URL 导航 + postMessage 监听）即可完成"发消息 → 流式收 AI 回复 → 多轮追问"闭环；
- [ ] 事件白名单、来源绑定、会话隔离、permissionMode 限制全部生效；
- [ ] 无 callbackId 的存量用法（EditPopover、OAuth 回跳、内部新窗口打开等）行为不变，存量测试全绿；
- [ ] 接入文档随代码合入。

## 9. 里程碑拆分建议

| 阶段 | 内容 | 依赖 |
|------|------|------|
| P0 | callbackId 解析 + CallbackRegistry + ack/error 回传（new-session） | 无 |
| P1 | session:event 订阅转发（流式回复闭环） | P0 |
| P2 | `send-message` action（多轮对话）+ 会话归属校验 | P1 |
| P3 | 接入文档 + 内置测试 Web App 页面 | P1 |
