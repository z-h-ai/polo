# Zeabur WS echo PoC（POL-7）

PRD v1.6 §⑧ D2/D3 + 附录 B「C5 Zeabur WS 实测报告（P0 回填）」：<50 行 `Bun.serve({ websocket })` echo 服务，部署 Zeabur 并绑定 `wss://relay.z-h-ai.com`（兼作域名接入与自动证书验证）。目的是用 24h 挂机实测回答「跨网络 WS 连接保持」问题，结论决定 M1-4 relay 心跳间隔与部署形态。非生产 relay（生产实现在 M1-4 `apps/relay`）。

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `echo.ts` | PoC 服务：message 原样回发（echo）、识别 `{"type":"ping"}` 回 pong（附服务器时间戳）、open/close 日志（含 close code / uptime / ping·echo 计数）。监听 `PORT`（默认 8787） |
| `soak-test.ts` | 24h 连接保持测试客户端（Mac 对照组直跑；`runSoak`/`percentile` 纯逻辑可被 Expo dev app import 作真机组）。30s 应用层 ping、RTT P50/P95 周期输出、记录每次 onclose 的 code/时间/自动重连耗时，结束写 `soak-report.json` |
| `zbpack.json` + `Dockerfile` | Zeabur 部署配置（启动命令 `bun run echo.ts`，监听 8787）。**偏差说明**：卡体写 `zeabur.json`，经对照 Zeabur 当前 schema 与本仓既有部署物（`infra/updates-static/zbpack.json`），Zeabur 现行构建配置文件为 `zbpack.json`（`zeabur.json` 为遗留格式、仓库无先例），故按仓库既有形态落 `zbpack.json` + Dockerfile |
| `echo.test.ts` | bun test 单测：echo/心跳消息分发与百分位函数 |
| `soak-report.json` | 本地 60s 冒烟产出的样例报告（24h 实测后会被覆盖，注意另存） |

## 本地冒烟

```bash
cd /Users/oudouglas/project/z-h-ai/polo-dir/polo
bun dev/infra/zeabur-ws-poc/echo.ts &            # 服务默认 ws://0.0.0.0:8787
bun dev/infra/zeabur-ws-poc/soak-test.ts --url ws://127.0.0.1:8787 --duration 60
cat dev/infra/zeabur-ws-poc/soak-report.json
bun test dev/infra/zeabur-ws-poc/                 # 单测
```

soak 参数：`--url`（默认 ws://127.0.0.1:8787）、`--duration` 秒（默认 60，24h 传 86400）、`--ping-interval` 毫秒（默认 30000；**0=不发心跳**，用于测无心跳空闲断连阈值）、`--out` 报告路径。非 Bun 运行时（Node 直跑）报告走 stdout，`> soak-report.json` 重定向保存；Expo 真机组 `import { runSoak } from "@/../dev/infra/zeabur-ws-poc/soak-test"` 自行持久化返回对象。

## Zeabur 部署步骤（人工前置，本卡不执行）

1. Zeabur 控制台 → 项目（z-h-ai）→ New Service → Git repo `polo`，Root Directory 设为 `dev/infra/zeabur-ws-poc`（zbpack 读取该目录 `zbpack.json` → 按 Dockerfile 构建）。
2. Networking：暴露 Port `8787`，类型 HTTP；绑定自定义域名 `relay.z-h-ai.com`，Zeabur 自动签发证书（平台终结 TLS，对外 `wss://relay.z-h-ai.com`，容器内纯 WS）。
3. 验证连通：`bun soak-test.ts --url wss://relay.z-h-ai.com --duration 300`。
4. 实例规格：共享容器起步；若断连异常再评估独享实例（见预案）。

## 附录 B · C5 验收指标（5 项，实测后回填）

| # | 指标 | 判定 | 实测回填 |
| --- | --- | --- | --- |
| 1 | 无心跳空闲断连阈值 | 记录实测值（`--ping-interval 0 --duration 86400`，取首次非主动 close 的 uptime） | ＿ |
| 2 | 30s 心跳 24h 非主动断连 ≤5 次，且全部自动重连 | `unexpectedDisconnects ≤ 5` 且 `allAutoReconnected = true` | ＿ |
| 3 | close code 分布（1006 vs 1000/1001） | `closeCodeDist`，1000/1001 应仅出现在主动结束；非主动应主要为 1006 | ＿ |
| 4 | 国内单程 P95 < 500ms | `rtt.p95Ms / 2`（客户端测的是往返 RTT） | ＿ |
| 5 | 心跳参数与实例规格建议 | 人工依 1–4 结论给出（如 30s 维持 / 降 20s / 独享实例） | ＿ |

报告字段→指标映射：`unexpectedDisconnects`/`allAutoReconnected`→②；`closes[].code` + `closeCodeDist`→③；`rtt.p50Ms`/`rtt.p95Ms`→④；`closes[].uptimeSec`→①。

## 不通过预案（按序）

心跳 30s → 20s（M1-4 relay 参数）→ Zeabur 独享实例（避免共享宿主空闲回收）→ relay 迁国内云。

## 24h 挂机操作清单（人工执行）

1. 真机（Expo dev app）：插电充电、设置不息屏（或开发者选项「充电时保持唤醒」）、App 保前台（必要时关闭电池优化）；`runSoak({ url: "wss://relay.z-h-ai.com", durationSec: 86400, pingIntervalMs: 30000 })` 并持久化报告。
2. Mac 对照组同起：`bun soak-test.ts --url wss://relay.z-h-ai.com --duration 86400`（不同网络出口更有对照价值，如有条件走手机热点）。
3. 期间不要动 Zeabur 控制台（避免 redeploy 制造主动断连）；服务端 `echo.ts` 日志留存。
4. 结束：双端 `soak-report.json` + 服务端 close 日志回填 PRD 附录 B（PRD 版本递增），并按上表给指标 5 结论。
