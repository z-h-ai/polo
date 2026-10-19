# RN 兼容性清单（C6）+ 带内认证（C1）验证记录

- 卡：POL-231（WsRpcClient RN 兼容性验证）
- 依据：PRD v1.6 §⑤「关键结论：WsRpc 带内认证，天然兼容 RN」与「RN 兼容性清单（C6）」；附录 C（2026-10-17 逐项复核）
- 结论：**client.ts / server.ts / shared 三方源码零改动**，RN 兼容前提全部由可执行测试固化
- 测试：`packages/server-core/src/transport/__tests__/rn-compat.test.ts`（bun test，9 例）
- 运行：`bun test packages/server-core/src/transport/__tests__/rn-compat.test.ts`
- 状态标记：**测试证明** = 本仓库 bun 测试已覆盖；**真机待核** = 属 M0-ACC 真机演示人工项，本卡不执行

前置说明：RN 侧运行环境 = Hermes 引擎 + Metro 打包；App 侧共 3 处适配（均不改 polo 源码，属 M0-1/M1-10 范围）：
① `metro.config.js` resolver.resolveRequest 把 `'ws'` 映射到空 stub；② 入口首行 `import 'react-native-get-random-values'`（必要时追加 ~5 行 randomUUID polyfill）；③ 入口 `global.Buffer = require('buffer').Buffer`（~2KB）。

## C1 带内认证（token 不经 HTTP header）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| token 在 WS 建立后首条 handshake 消息内传输（client.ts:412 `token: this.token`） | ✅ 测试证明 | rn-compat「connects through the global WebSocket…」：服务端 validateToken 仅收到 handshake envelope 内的 token（`tokensSeen === [TEST_TOKEN]`）；测试挂钩服务端 ws `connection` 事件捕获 HTTP upgrade 请求，直接断言无 `authorization` header、URL 无 `token` query 参数 |
| 服务端校验 envelope.token（server.ts:441），cookie 仅 web UI fallback（server.ts:446） | ✅ 测试证明 | 同上例握手成功；server-lifecycle.test.ts 覆盖无 token → 4005 |
| 错误 token → AUTH_FAILED error 信封 + close 4005（server.ts:450-454） | ✅ 测试证明 | raw socket 收到 `error.code='AUTH_FAILED'` 后 close code=4005 reason='Auth failed'；客户端 API 侧 rejects kind='auth'、`lastClose.code=4005` |
| 5s 握手超时 → close 4001（server.ts:393-397） | ✅ 测试证明 | 连接后不发握手，5.005s 收到 close 4001 'Handshake timeout' |
| 首帧必须 handshake + 协议 major 检查（server.ts:408-434，4003/4004） | ✅ 既有测试 | server-lifecycle.test.ts「rejects wrong protocol major version」= 4004 |
| RN 全局环境下走全局 WebSocket 分支完成握手 | ✅ 测试证明 | 测试临时删除 `process.versions.node`、挂全局 WebSocket/Buffer、stub crypto.randomUUID，客户端经插桩的全局 WebSocket 完成握手+RPC（`instrumentedSockets.length===1`，未触发 `require('ws')` 分支） |

## C6 六项清单

| # | 平台 API | 位置 | RN 内置 | 处置 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 1 | 全局 WebSocket | client.ts:347（`return new WebSocket(url)`）；Node 分支条件 `process.versions?.node`（:335） | ✅ | 零改动。RN 无 `process.versions` → Node/`ws` 分支不可达，自动走全局 WebSocket | ✅ 测试证明（差分法：唯一能到达 Node 分支的输入 `wss://`+`tlsRejectUnauthorized:false`，在 Node 环境下确实产出 ws 库 socket（`.on` API），同输入在 RN 全局模拟下只经插桩全局 ctor 实例化——证明是「RN 无 process.versions.node」而非 URL 形状挡住了 `require('ws')`）；真机待核：RN 原生 WebSocket 对 `ws.onopen/onmessage/onclose` 属性式 API 与 CloseEvent.code 的行为 |
| 2 | `require('ws')` | client.ts:339（仅 wss + `tlsRejectUnauthorized:false` + Node 环境才执行） | ❌ | 运行时在 RN 不可达（差分测试证明，见第 1 项），但 Metro 静态解析会尝试打包（ws 依赖 Node 内置 → 构建报错）。处置：M0-1 在 metro.config.js 把 `'ws'` 映射为空 stub | ⚠️ 测试证明「运行时不执行」（含 Node 环境对照用例）；Metro 打包验证属 M0-1 |
| 3 | `crypto.randomUUID()` | client.ts:187, 407, 832 | ❌ | App 入口 polyfill（`react-native-get-random-values` + 必要时 5 行 randomUUID） | ✅ 测试证明：stub 掉原生 randomUUID（计数器实现）后握手 id、request id、sequence_ack id 全链路正常 |
| 4 | Buffer（base64） | codec.ts:23-24, 36-37；探测回退 btoa（:32）/ atob（:40） | ❌ | codec 自带双路径；双保险：入口挂 `global.Buffer = require('buffer').Buffer` | ✅ 测试证明双路径：无全局 Buffer 时序列化/反序列化 Uint8Array 走 btoa/atob（插桩计数 >0）；挂 `require('buffer').Buffer` 后走 Buffer 路径（btoa 计数 =0）。⚠️ 真机待核：**Hermes 的 btoa/atob 行为（Unicode/大 payload 边界）列入 M0-ACC 真机演示核实** |
| 5 | setTimeout / setInterval / Date.now | client.ts 多处（:189, :383, :800-812, :829 等；类型仅 `ReturnType<typeof setTimeout>`，无 `node:timers` import） | ✅ | 零改动 | ✅ 测试证明：replay 测试全程依赖 client 的重连 setTimeout 与 ack 逻辑；无 Node 定时器引用（静态审计） |
| 6 | `@polo-ai/shared/protocol` 整包 | client.ts:12 引入 | ✅ | 零改动 | ✅ 测试证明+静态审计：protocol/ 7 个源文件无 `process.env`、无 Node 内置 import、无 require；唯一跨包值级引用 `dto.ts:27` 再导出 `generateMessageId`（来自 `@polo-ai/core/types`），已审计 core/types 全目录**零 import**（纯类型+纯函数），依赖链干净。zod（经 admin/schemas）为纯 JS，Metro 可打包 |

## 重连 replay（切后台/弱网恢复，PRD §⑤）

| 项 | 结论 | 证据 |
| --- | --- | --- |
| RN 身份路径：不传 workspaceId/webContentsId → 服务端存 null/null，重连 `null==null` 匹配成立（server.ts:458-467） | ✅ 测试证明 | onClientConnected 回调 `workspaceId===null && webContentsId===null`；断开后携 reconnectClientId+lastSeq 重连被识别（ack `reconnected:true`，客户端 `__transport:reconnected` isStale=false） |
| ring buffer 按 seq 过滤补投（server.ts:483-516，TTL 30s / 客户端保留 60s / 上限 500 条） | ✅ 测试证明 | 在线收 seq 1-3 → 断开 → 离线期 push seq 4-5（断言断开期间零投递）→ 重连补投 4,5 → 全序列 `[1,2,3,4,5,6]` 有序、无重复、无缺口，replay 后 RPC 与实时推送恢复正常 |

## 差异记录（实测 vs PRD）

无结论性冲突。两点补充精度（不构成回写 PRD 的差异）：
1. PRD C6 第 6 行「protocol/ 7 个源文件无…无 require」成立，但 protocol/dto.ts:27 存在**值级**再导出（`generateMessageId` ← `@polo-ai/core/types`），即 protocol 的运行时依赖面不止类型导入；已追加审计 core/types 全目录零 import，结论不变。
2. Bun 的 CloseEvent 将 `code/reason` 挂在原型而非自有属性（自有键仅 `isTrusted`）；客户端 `onDisconnect` 读取 `closeEvent.code` 不受影响（测试证明 4005/4001 均正确归因）。真机 RN 的 CloseEvent 行为随第 1 项真机待核一并确认。

## 后续动作

- M0-ACC：真机演示核实 Hermes btoa/atob（清单第 4 项）与 RN CloseEvent/全局 WebSocket 行为（第 1 项）。
- M0-1：metro.config.js `'ws'` stub（第 2 项），Metro 打包验证。
- M1-10：App 连接管理器直接消费本卡结论（in-band token + reconnectClientId/lastSeq replay）。
