---
title: poloai:// 双向协议——Web App 接入指南
task_id: POO-1
created: 2026-07-08
---

# poloai:// 双向协议——Web App 接入指南

本指南面向在 **Polo AI 桌面端标签页浏览器**中运行的网页（Web App）开发者。通过 `poloai://` 协议，你的网页可以在**零依赖、零 SDK** 的前提下完成：

1. 创建 Polo AI 会话并发送消息；
2. 流式接收 AI 回复（逐字增量）；
3. 向同一会话追加消息，实现多轮对话。

设计规格见 [spec-poloai-protocol-bidirectional.md](./spec-poloai-protocol-bidirectional.md)。

## 前提条件

- 页面运行在 Polo AI 桌面端的标签页浏览器（`<webview>`）中——普通浏览器里 `poloai://` 不会被拦截；
- 宿主为支持双向协议的版本（旧版本会忽略 `callbackId`，见[兼容性探测](#兼容性探测旧版本宿主)）。

只用到两个标准 Web API：`location.href` 导航（发请求）和 `window.addEventListener('message')`（收响应）。

## 5 分钟上手

```javascript
// 1. 生成 callbackId——请求与响应靠它关联
const callbackId = crypto.randomUUID()
let sessionId = null

// 2. 监听宿主回传的消息
window.addEventListener('message', (e) => {
  const msg = e.data
  if (!msg || msg.callbackId !== callbackId) return   // 过滤无关消息

  if (msg.type === 'poloai:ack') {
    // 请求已受理，拿到会话 ID（多轮对话要用）
    sessionId = msg.result?.sessionId ?? sessionId
  } else if (msg.type === 'poloai:event') {
    // 会话流式事件
    switch (msg.event.type) {
      case 'text_delta':  appendText(msg.event.delta); break   // 逐字增量
      case 'complete':    onDone(); break                      // 本轮回复结束
      case 'error':       onError(msg.event.error); break
    }
  } else if (msg.type === 'poloai:error') {
    // 请求本身失败（参数非法、无权限等）
    onError(`[${msg.error.code}] ${msg.error.message}`)
  }
})

// 3. 首轮：创建会话并发送消息
location.href = `poloai://action/new-session?input=${
  encodeURIComponent('帮我分析这份数据')}&send=true&callbackId=${callbackId}`

// 4. 多轮：向同一会话追加（复用同一 callbackId 继续收流）
function followUp(text) {
  location.href = `poloai://action/send-message/${sessionId}?input=${
    encodeURIComponent(text)}&callbackId=${callbackId}`
}
```

消息时序：`poloai:ack`（含 sessionId）→ 若干 `poloai:event`（text_delta …）→ `poloai:event`（complete）。

## 协议参考

### 请求 URL

#### `new-session` — 创建会话（可选发送首条消息）

```text
poloai://action/new-session?input=<encoded>&send=true&callbackId=<id>
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `callbackId` | 需要回执时必填 | 由页面生成，格式 `^[A-Za-z0-9-]{8,64}$`（建议 `crypto.randomUUID()`）。不合法时按不带处理（收不到任何回执） |
| `input` | 否 | 消息内容，需 `encodeURIComponent` |
| `send` | 否 | `true` 则立即发送 `input`；否则 `input` 仅预填到输入框 |
| `name` | 否 | 会话名称 |
| `mode` | 否 | 权限模式。协议来源**不放行 `allow-all`**（静默降级为 `ask`）；不传时默认 `safe` |

#### `send-message/{sessionId}` — 向已有会话追加消息（多轮）

```text
poloai://action/send-message/<sessionId>?input=<encoded>&callbackId=<id>
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `sessionId` | 是 | 路径段。**必须是本页面通过本协议创建的会话**，否则 `not_authorized` / `session_not_found` |
| `input` | 是 | 消息内容，需 `encodeURIComponent` |
| `callbackId` | 是 | 推荐复用首轮的值（同一 handler 持续收流）；换新值也可，但占用配额（见[限制](#生命周期与限制)） |

发起方式除 `location.href` 外，`window.open(url)` 同样会被宿主拦截处理。

### 响应消息信封

所有回传消息通过 `window.postMessage` 派发，统一结构：

```typescript
interface PoloaiProtocolMessage {
  type: 'poloai:ack' | 'poloai:event' | 'poloai:error'
  callbackId: string
  result?: { sessionId?: string }                  // poloai:ack
  event?: PoloaiProtocolEvent                      // poloai:event
  error?: { code: string; message: string }        // poloai:error
}
```

类型定义与宿主共用一份源码：`packages/shared/src/protocol/dto.ts`（`PoloaiProtocolMessage` / `PoloaiProtocolEvent`）。

### 事件白名单（`poloai:event`）

只转发以下 7 种事件，每条都带 `sessionId`：

| `event.type` | 载荷字段 | 说明 |
|--------------|----------|------|
| `text_delta` | `delta` | 回复文本增量，逐条追加渲染 |
| `text_complete` | `text` | 一段回复的完整文本。**用于校正而非追加**——如果你已渲染过 delta，用它整体替换该段，两者都追加会重复 |
| `tool_start` | `toolName` | AI 开始调用工具（仅工具名，不含参数） |
| `tool_result` | `toolName` | 工具调用结束（仅工具名，不含结果内容） |
| `complete` | — | 本轮回复结束 |
| `error` | `error` | 会话执行出错（字符串消息） |
| `interrupted` | — | 回复被用户在宿主 UI 中打断 |

**明确不转发**：权限/凭据交互事件（在宿主 UI 完成）、工具的输入参数与执行结果（可能含宿主敏感信息）、会话管理类事件。

### 错误码（`poloai:error`）

| `error.code` | 含义 | 常见原因 |
|--------------|------|----------|
| `invalid_action` | action 不存在或参数非法 | 缺 `input`、callbackId 超配额、action 名拼错 |
| `session_not_found` | 会话不存在或不属于当前回调源 | sessionId 错误；页面刷新后使用旧 sessionId |
| `not_authorized` | 会话归属校验失败 | 用了其他页面创建的 sessionId；callbackId 被其他页面占用 |
| `internal_error` | 其余执行异常 | 宿主内部错误，可稍后重试 |

## 生命周期与限制

- **配额**：单个页面同时活跃的 callbackId 上限 **8** 个，超出返回 `invalid_action`；
- **空闲回收**：callbackId 空闲（无任何请求/事件活动）超过 **30 分钟**自动清理。会话 `complete` 后回调保留，可继续多轮；
- **页面导航即失效**：页面刷新或跳转后，该页面名下所有回调与会话归属**全部清理**。即使你把 sessionId 存在 `localStorage`，刷新后调 `send-message` 也会得到 `session_not_found`——归属绑定的是页面的运行实例，不是 URL。需要跨刷新续聊的场景暂不支持；
- **权限模式**：协议创建的会话默认 `safe`，`mode=allow-all` 静默降级为 `ask`。会话在宿主会话列表中正常可见，用户可随时接管、审批或终止；
- **隔离**：回调消息只发给发起请求的页面；无法读取、枚举或操作用户的其他会话。

## 兼容性探测（旧版本宿主）

旧版本桌面端会忽略 `callbackId` 参数，行为退化为单向（消息照发，但收不到任何回执）。建议用超时探测：

```javascript
const ackTimeout = setTimeout(() => {
  // 3 秒未收到 ack：宿主不支持双向协议，降级到单向模式
  enterLegacyMode()
}, 3000)

window.addEventListener('message', (e) => {
  if (e.data?.callbackId !== callbackId) return
  clearTimeout(ackTimeout)
  // ...正常处理
})
```

## 安全与实现说明

- 回传消息由宿主在**页面自身上下文**中派发，因此 `e.source === window`、`e.origin` 为页面自己的 origin——这是预期行为，不要按"外部消息"的惯例把它过滤掉；
- 校验建议：`msg.type` 前缀为 `poloai:` 且 `msg.callbackId` 严格等于自己生成的值即可；
- 页面发生主导航后残留的在途消息会被宿主静默丢弃，不会串到新页面。

## 本地测试页面

仓库内置了一个测试 Web App：`apps/electron/src/renderer/poloai-protocol-test.html`（随 renderer 构建打包，Vite 入口 `poloai-protocol-test`）。在标签页浏览器中打开即可交互验证：新建会话收流、追加多轮、观察原始消息日志。
