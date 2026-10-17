/**
 * POL-7 · 24h WS 连接保持 soak 客户端（附录 B「C5 Zeabur WS 实测报告」Mac 对照组脚本）。
 * 30s 应用层 ping、RTT 采样（P50/P95 周期输出）、记录每次 onclose 的 code/时间/自动重连耗时，
 * 结束输出 soak-report.json。Bun/Node 可直跑；纯逻辑（runSoak/percentile）可被 Expo dev app
 * import 作真机组（不依赖 node:fs —— 报告对象由调用方自行持久化）。
 *
 * 用法：
 *   bun  soak-test.ts --url wss://relay.z-h-ai.com --duration 86400          # 24h 挂机
 *   bun  soak-test.ts --url ws://127.0.0.1:8080 --duration 60                # 本地冒烟
 *   node soak-test.ts --url ws://127.0.0.1:8080 --duration 60 > soak-report.json  # Node（stdout 重定向）
 * 可选参数：--ping-interval <ms>（默认 30000；0=不发心跳，用于测无心跳空闲断连阈值）、--out <path>。
 */

export interface SoakOptions {
  url: string;
  durationSec: number;
  pingIntervalMs: number;
}

export interface CloseRecord {
  at: string;
  uptimeSec: number;
  code: number;
  reason: string;
  active: boolean;
  reconnectMs: number | null;
}

export interface SoakReport {
  url: string;
  label: string;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  pingIntervalMs: number;
  connections: number;
  reconnects: number;
  pingsSent: number;
  pongsReceived: number;
  pingTimeouts: number;
  rtt: { samples: number; p50Ms: number; p95Ms: number; maxMs: number };
  closes: CloseRecord[];
  closeCodeDist: Record<string, number>;
  unexpectedDisconnects: number;
  allAutoReconnected: boolean;
}

/** 就近秩（nearest-rank）百分位；空样本返回 0。 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1;
  return Math.round(sorted[idx] ?? 0);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const OPEN = 1;

interface PendingReconnect {
  record: CloseRecord;
  closedAtMs: number;
}

function oneConnection(
  url: string,
  pingIntervalMs: number,
  endMs: number,
  state: { connections: number; reconnects: number; pingsSent: number; pongsReceived: number; pingTimeouts: number },
  rtts: number[],
  stopping: { value: boolean },
  pending: PendingReconnect[],
  log: (line: string) => void,
): Promise<{ record: CloseRecord | null }> {
  return new Promise((resolve) => {
    const openedAttemptMs = Date.now();
    let ws: WebSocket;
    try {
      ws = new globalThis.WebSocket(url);
    } catch (err) {
      log(`[error] WebSocket 构造失败：${String(err)}`);
      resolve({
        record: { at: new Date().toISOString(), uptimeSec: 0, code: 0, reason: "constructor-error", active: false, reconnectMs: null },
      });
      return;
    }
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let stopTimer: ReturnType<typeof setTimeout> | null = null;
    let outstandingPingAt: number | null = null;
    const cleanup = () => {
      if (pingTimer !== null) clearInterval(pingTimer);
      if (stopTimer !== null) clearTimeout(stopTimer);
    };
    ws.onopen = () => {
      state.connections++;
      if (pending.length > 0) {
        state.reconnects++;
        const openedMs = Date.now();
        for (const p of pending) p.record.reconnectMs = openedMs - p.closedAtMs;
        log(`[open] #${state.connections} ${url}（重连成功，距首次断开 ${openedMs - pending[0]!.closedAtMs}ms，中间失败尝试 ${pending.length - 1} 次）`);
        pending.length = 0;
      } else {
        log(`[open] #${state.connections} ${url}`);
      }
      if (pingIntervalMs > 0) {
        const sendPing = () => {
          if (ws.readyState !== OPEN) return;
          if (outstandingPingAt !== null) state.pingTimeouts++;
          outstandingPingAt = Date.now();
          state.pingsSent++;
          ws.send(JSON.stringify({ type: "ping", t: outstandingPingAt }));
        };
        sendPing(); // 连接建立即发首个 ping：即时验证 ping/pong 链路并保证短时运行也有 RTT 样本
        pingTimer = setInterval(sendPing, pingIntervalMs);
      }
      stopTimer = setTimeout(() => {
        stopping.value = true;
        try {
          ws.close(1000, "soak-end");
        } catch {
          // 已关闭则忽略
        }
      }, Math.max(0, endMs - Date.now()));
    };
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg: unknown = JSON.parse(String(ev.data));
        if (msg && typeof msg === "object" && (msg as { type?: unknown }).type === "pong") {
          if (outstandingPingAt !== null) {
            rtts.push(Date.now() - outstandingPingAt);
            outstandingPingAt = null;
          }
          state.pongsReceived++;
        }
      } catch {
        // 非 JSON 帧：PoC 服务器只会回 pong 或 echo，忽略
      }
    };
    ws.onclose = (ev: CloseEvent) => {
      cleanup();
      const active = stopping.value;
      const record: CloseRecord = {
        at: new Date().toISOString(),
        uptimeSec: Math.round((Date.now() - openedAttemptMs) / 1000),
        code: ev.code,
        reason: ev.reason || "",
        active,
        reconnectMs: null,
      };
      if (outstandingPingAt !== null) state.pingTimeouts++;
      log(`[close] code=${ev.code} reason=${record.reason || "-"} uptime=${record.uptimeSec}s ${active ? "（主动结束）" : "（非主动，待重连）"}`);
      if (!active) pending.push({ record, closedAtMs: Date.now() });
      resolve({ record });
    };
    ws.onerror = () => log(`[error] ws onerror（连接失败或协议错误）`);
  });
}

/** 运行一次 soak 测试直到 durationSec 结束；返回报告对象（不落盘，便于 Expo 真机组 import）。 */
export async function runSoak(opts: SoakOptions, log: (line: string) => void = console.log): Promise<SoakReport> {
  const { url, durationSec, pingIntervalMs } = opts;
  const startedMs = Date.now();
  const endMs = startedMs + durationSec * 1000;
  const rtts: number[] = [];
  const closes: CloseRecord[] = [];
  const state = { connections: 0, reconnects: 0, pingsSent: 0, pongsReceived: 0, pingTimeouts: 0 };
  const stopping = { value: false };
  const progressEveryMs = Math.min(300_000, Math.max(15_000, Math.round((durationSec * 1000) / 6)));
  const progress = setInterval(() => {
    log(`[progress] ${Math.round((Date.now() - startedMs) / 1000)}s conn=${state.connections} rtt n=${rtts.length} p50=${percentile(rtts, 50)}ms p95=${percentile(rtts, 95)}ms reconnects=${state.reconnects}`);
  }, progressEveryMs);
  log(`[soak] url=${url} duration=${durationSec}s ping=${pingIntervalMs}ms`);
  const pending: PendingReconnect[] = [];
  try {
    while (!stopping.value && Date.now() < endMs) {
      const { record } = await oneConnection(url, pingIntervalMs, endMs, state, rtts, stopping, pending, log);
      if (record !== null) closes.push(record);
      if (stopping.value) break;
      log(`[reconnect] 1s 后重连（第 ${state.reconnects + 1} 次）`);
      await sleep(Math.max(0, Math.min(1000, endMs - Date.now())));
    }
  } finally {
    clearInterval(progress);
  }
  const unexpected = closes.filter((c) => !c.active);
  const closeCodeDist: Record<string, number> = {};
  for (const c of closes) closeCodeDist[String(c.code)] = (closeCodeDist[String(c.code)] ?? 0) + 1;
  const report: SoakReport = {
    url,
    label: `soak-${durationSec}s`,
    startedAt: new Date(startedMs).toISOString(),
    endedAt: new Date().toISOString(),
    durationSec,
    pingIntervalMs,
    connections: state.connections,
    reconnects: state.reconnects,
    pingsSent: state.pingsSent,
    pongsReceived: state.pongsReceived,
    pingTimeouts: state.pingTimeouts,
    rtt: { samples: rtts.length, p50Ms: percentile(rtts, 50), p95Ms: percentile(rtts, 95), maxMs: Math.round(rtts.length ? Math.max(...rtts) : 0) },
    closes,
    closeCodeDist,
    unexpectedDisconnects: unexpected.length,
    allAutoReconnected: unexpected.every((c, i) => {
      if (c.reconnectMs !== null) return true;
      return i === unexpected.length - 1 && Date.parse(c.at) >= endMs - 5000; // 仅容忍恰在结束时刻的最后一次
    }),
  };
  log(`[done] conn=${report.connections} 非主动断连=${report.unexpectedDisconnects} 全部自动重连=${report.allAutoReconnected} rtt p50=${report.rtt.p50Ms}ms p95=${report.rtt.p95Ms}ms closeCodes=${JSON.stringify(closeCodeDist)}`);
  return report;
}

function parseArgs(argv: string[]): SoakOptions & { out?: string } {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = get("--url") ?? "ws://127.0.0.1:8787";
  const durationSec = Math.max(5, Number(get("--duration") ?? 60));
  const pingIntervalMs = Math.max(0, Number(get("--ping-interval") ?? 30_000));
  return { url, durationSec, pingIntervalMs, out: get("--out") };
}

/** 仅在 Bun 下落盘；其它运行时报告已输出到 stdout，用重定向保存。 */
async function emitReport(report: SoakReport, out?: string): Promise<string> {
  const json = JSON.stringify(report, null, 2) + "\n";
  if (typeof Bun === "undefined") return "";
  const path = out ?? `${import.meta.dir}/soak-report.json`;
  await Bun.write(path, json);
  return path;
}

// 直跑检测：Bun 用 import.meta.main；Node 用 argv[1] 后缀。被 Expo/bun test import 时不触发落盘。
const isDirectRun =
  (typeof Bun !== "undefined" && import.meta.main === true) ||
  (typeof process !== "undefined" && Array.isArray(process.argv) && /soak-test\.(ts|js|mjs)$/.test(process.argv[1] ?? ""));

if (isDirectRun) {
  void (async () => {
    const args = parseArgs(process.argv.slice(2));
    const isBun = typeof Bun !== "undefined";
    // 非 Bun：日志走 stderr，报告 JSON 走 stdout（保证 `> soak-report.json` 重定向得到纯 JSON）
    const report = await runSoak(args, isBun ? undefined : (line) => console.error(line));
    const path = await emitReport(report, args.out);
    if (isBun) console.log(`[report] 已写入 ${path}`);
    else {
      console.log(JSON.stringify(report, null, 2));
      console.error("[report] 报告 JSON 已输出到 stdout（可 > soak-report.json 重定向保存）");
    }
  })();
}
