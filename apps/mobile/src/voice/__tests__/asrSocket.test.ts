// POL-24 评审补测：/asr 会话层握手超时必须就地关闭 socket（防 relay 侧
// prehold 悬挂到 330s 墙钟守卫 + 客户端 handlers 泄漏）。bun test 真实定时器
// （超时预算缩到毫秒级），WS 为注入的假件。

import { describe, expect, test } from 'bun:test';

import { connectAsrSession, buildAsrUrl } from '../asrSocket';
import type { AsrSessionHandlers, AsrWebSocketLike } from '../asrSocket';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeFakeWebSocket() {
  const calls: { sent: string[]; closed: number; closeCode?: number } = { sent: [], closed: 0 };
  const ws: AsrWebSocketLike = {
    readyState: 1,
    send(data) {
      if (typeof data === 'string') calls.sent.push(data);
    },
    close(code) {
      calls.closed += 1;
      calls.closeCode = code;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return { ws, calls };
}

const noopHandlers: AsrSessionHandlers = {
  onReady() {},
  onPartial() {},
  onFinal() {},
  onError() {},
  onClosed() {},
};

describe('connectAsrSession 握手超时收口', () => {
  test('asr_ready 未到 → connect 以 timeout 拒绝，且 socket 已就地关闭', async () => {
    const { ws, calls } = makeFakeWebSocket();
    const promise = connectAsrSession(
      {
        relayUrl: 'wss://relay.test',
        phoneDeviceId: 'phone-1',
        token: 'jwt-token',
        readyTimeoutMs: 5,
        createWebSocket: () => ws,
      },
      noopHandlers,
    );
    const observed: { timeoutCode: string | null } = { timeoutCode: null };
    const settled = promise.then(
      () => null,
      (error: { code?: string }) => {
        observed.timeoutCode = error.code ?? null;
        return error;
      },
    );
    await sleep(30);
    await settled;
    expect(observed.timeoutCode).toBe('timeout');
    // socket 已关：relay 不再维持一个永远等不到音频的 prehold 会话
    expect(calls.closed).toBe(1);
  });

  test('超时关闭后到达的 close 事件不再触发 onClosed（settledLocal 静默）', async () => {
    const { ws, calls } = makeFakeWebSocket();
    let onClosedCalls = 0;
    const handlers: AsrSessionHandlers = { ...noopHandlers, onClosed: () => (onClosedCalls += 1) };
    const promise = connectAsrSession(
      {
        relayUrl: 'wss://relay.test',
        phoneDeviceId: 'phone-1',
        token: 'jwt-token',
        readyTimeoutMs: 5,
        createWebSocket: () => ws,
      },
      handlers,
    );
    promise.catch(() => {}); // timeout 拒绝为预期路径
    await sleep(30);
    // 模拟迟到的底层 close 事件（handlers 已 detach，不应再派发）
    ws.onclose?.({ code: 1006 });
    expect(onClosedCalls).toBe(0);
    expect(calls.closed).toBe(1);
  });
});

describe('buildAsrUrl', () => {
  test('query 鉴权参数编码（RN 无法设 WS header）', () => {
    const url = buildAsrUrl('wss://relay.example.com/', 'phone 1', 'a/b+c');
    expect(url).toBe('wss://relay.example.com/asr?side=phone&deviceId=phone%201&token=a%2Fb%2Bc');
  });
});
