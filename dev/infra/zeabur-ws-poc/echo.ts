// POL-7 · Zeabur WS echo PoC（<50 行）——PRD v1.6 §⑧ D2/D3 与附录 B「C5 Zeabur WS 实测报告」。
// 非生产 relay（生产实现在 M1-4 apps/relay）；仅验证 Zeabur WS 部署形态与 24h 连接保持基线。
const PORT = Number(process.env.PORT ?? 8787);

interface WsData { ip: string; openedAt: number; pings: number; echoes: number }

/** 纯函数：识别 {"type":"ping"} 心跳 → pong（附服务器时间戳）；其余消息原样回发（echo）。 */
export function handleMessage(raw: string, now: number = Date.now()): string {
  try {
    const msg: unknown = JSON.parse(raw);
    if (msg !== null && typeof msg === "object" && (msg as { type?: unknown }).type === "ping") {
      return JSON.stringify({ type: "pong", t: now });
    }
  } catch {
    // 非 JSON 文本：按原文 echo
  }
  return raw;
}

if (import.meta.main) {
  Bun.serve<WsData>({
    port: PORT,
    fetch(req, server) {
      const ip = server.requestIP(req)?.address ?? "unknown";
      if (server.upgrade(req, { data: { ip, openedAt: Date.now(), pings: 0, echoes: 0 } })) return undefined;
      return new Response("this endpoint speaks websocket only", { status: 426 });
    },
    websocket: {
      open(ws) {
        console.log(`[open] ${ws.data.ip} remote=${ws.remoteAddress} at ${new Date().toISOString()}`);
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
        const out = handleMessage(text);
        if (out === text) ws.data.echoes++;
        else ws.data.pings++;
        ws.send(out);
      },
      close(ws, code, reason) {
        const uptimeSec = Math.round((Date.now() - ws.data.openedAt) / 1000);
        console.log(`[close] ${ws.data.ip} code=${code} reason=${reason || "-"} uptime=${uptimeSec}s pings=${ws.data.pings} echoes=${ws.data.echoes}`);
      },
    },
  });
  console.log(`[echo-poc] ${new Date().toISOString()} listening on ws://0.0.0.0:${PORT}（PORT 环境变量可覆盖）`);
}
