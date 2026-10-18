// POL-17 unit tests for the mobile conn layer (bun test, M0-2 手法:
// WebSocket/连接对象全部 mock，绝无真实网络).
//
// Coverage per the card 自检 matrix:
//   - LAN 握手成功（通道激活 → online-lan，relay 不被拨号）
//   - 探测窗口回落 relay + 60s 粘滞（LAN 不反复重试 / 低频重探 / 回切直连）
//   - 握手 close 4005 置 offline 并上抛认证失效（不重试）
//   - 断线指数退避重连（1s → 2s → 4s，封顶）
//   - replay 帧按序去重消费（relayChannel + EventSequencer 端到端）
//   - 通道切换状态事件（in-flight 请求快速失败，不静默丢弃）
//   - 状态去抖（瞬态抖动不出稳态）、pause/resume 定时器暂停

import { describe, expect, test } from 'bun:test';

import type { MessageEnvelope } from '@polo-ai/shared/protocol';
import type {
  TransportConnectionState,
  WsRpcClientOptions,
} from '@polo-ai/server-core/transport/client';
import { ConnectionManager, type FatalInfo, type StatusInfo } from '../ConnectionManager';
import { createLanChannel, type ChannelState, type ConnChannel, type WsRpcClientLike } from '../lanChannel';
import { createRelayChannel, type RelayChannelOptions, type WebSocketLike } from '../relayChannel';

// ---------------------------------------------------------------------------
// Fake clock — deterministic timers for the manager
// ---------------------------------------------------------------------------

interface FakeClock {
  now: () => number;
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  advance: (ms: number) => Promise<void>;
  pendingCount: () => number;
}

function makeFakeClock(): FakeClock {
  let current = 0;
  let seq = 0;
  const scheduled = new Map<number, { at: number; fn: () => void }>();
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    now: () => current,
    timers: {
      set(fn, ms) {
        const id = ++seq;
        scheduled.set(id, { at: current + ms, fn });
        return id;
      },
      clear(handle) {
        scheduled.delete(handle as number);
      },
    },
    async advance(ms) {
      // A real event loop runs pending microtasks before the next timer —
      // mirror that, or channel connect() continuations would land after
      // timer callbacks and mis-order the manager's state transitions.
      await drain();
      const deadline = current + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of scheduled) {
          if (timer.at <= deadline && timer.at < nextAt) {
            nextAt = timer.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        current = nextAt;
        const timer = scheduled.get(nextId);
        scheduled.delete(nextId);
        timer?.fn();
        await drain();
      }
      current = deadline;
      await drain();
    },
    pendingCount: () => scheduled.size,
  };
}

// ---------------------------------------------------------------------------
// Fake channel — manager-level tests
// ---------------------------------------------------------------------------

class FakeChannel implements ConnChannel {
  readonly kind: 'lan' | 'relay';
  connectCalls = 0;
  destroyed = false;
  invokes: Array<{ channel: string; args: unknown[] }> = [];
  private readonly stateListeners = new Set<(state: ChannelState) => void>();
  private readonly eventListeners = new Set<(channel: string, args: unknown[]) => void>();
  private pendingConnects: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(kind: 'lan' | 'relay') {
    this.kind = kind;
  }

  connect(): Promise<void> {
    this.connectCalls += 1;
    return new Promise<void>((resolve, reject) => {
      this.pendingConnects.push({ resolve, reject });
    });
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invokes.push({ channel, args });
    return Promise.resolve({ echoed: channel });
  }

  on(cb: (channel: string, args: unknown[]) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  onState(cb: (state: ChannelState) => void): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  destroy(): void {
    this.destroyed = true;
    for (const pending of this.pendingConnects) pending.reject(new Error('destroyed'));
    this.pendingConnects = [];
  }

  /** Probe/handshake succeeds. */
  succeed(): void {
    const pending = this.pendingConnects.shift();
    this.emit({ phase: 'online' });
    pending?.resolve();
  }

  /** Probe/handshake fails (never reached online). */
  fail(fields: { closeCode?: number; errorKind?: string; errorMessage?: string }): void {
    const pending = this.pendingConnects.shift();
    this.emit({ phase: 'offline', ...fields });
    pending?.reject(
      Object.assign(new Error(fields.errorMessage ?? `${this.kind} connect failed`), fields),
    );
  }

  /** Loss AFTER being online (drives the manager's reconnect path). */
  lose(fields: { closeCode?: number; errorKind?: string; errorMessage?: string }): void {
    this.emit({ phase: 'offline', ...fields });
  }

  private emit(state: ChannelState): void {
    for (const cb of this.stateListeners) cb(state);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOptions {
  wsUrl?: string | null;
  token?: string | null;
  relayUrl?: string;
  stateDebounceMs?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const clock = makeFakeClock();
  const lan = new FakeChannel('lan');
  const relay = new FakeChannel('relay');
  const manager = new ConnectionManager({
    target: () => ({
      phoneDeviceId: 'p1',
      macDeviceId: 'm1',
      wsUrl: options.wsUrl === undefined ? 'ws://192.168.31.42:9100' : options.wsUrl,
    }),
    token: () => (options.token === undefined ? 'jwt-1' : options.token),
    relayUrl: () => options.relayUrl ?? 'wss://relay.test',
    random: () => 0.5, // jitter factor exactly 1.0 — deterministic backoff
    now: clock.now,
    timers: clock.timers,
    stateDebounceMs: options.stateDebounceMs ?? 100,
    probeWindowMs: 60_000,
    lanReprobeIntervalMs: 60_000,
    createLanChannel: () => lan,
    createRelayChannel: () => relay,
  });
  const statuses: StatusInfo[] = [];
  manager.onStatus((info) => statuses.push(info));
  const fatals: FatalInfo[] = [];
  manager.onFatal((info) => fatals.push(info));
  const emitted = () => statuses.map((info) => info.status);
  return { clock, lan, relay, manager, statuses, fatals, emitted };
}

// ---------------------------------------------------------------------------
// Manager — channel selection / stickiness / backoff / status
// ---------------------------------------------------------------------------

describe('ConnectionManager 通道选择与粘滞', () => {
  test('LAN 握手成功 → online-lan，relay 不被拨号', async () => {
    const { clock, lan, relay, manager, emitted } = makeHarness();
    manager.start();

    expect(lan.connectCalls).toBe(1);
    lan.succeed();
    await clock.advance(200);

    expect(manager.status).toBe('online-lan');
    expect(emitted()).toEqual(['offline', 'online-lan']);
    expect(relay.connectCalls).toBe(0);
  });

  test('LAN 探测失败回落 relay；60s 粘滞窗口内不反复重试 LAN；低频重探可达后回切直连', async () => {
    const { clock, lan, relay, manager, emitted } = makeHarness();
    manager.start();

    // probe fails (retryable) → relay fallback
    lan.fail({ errorKind: 'timeout', errorMessage: 'Connection timeout after 5000ms' });
    await clock.advance(0); // let the cycle continue onto the relay channel
    expect(relay.connectCalls).toBe(1);
    relay.succeed();
    await clock.advance(200);
    expect(manager.status).toBe('online-relay');
    expect(lan.connectCalls).toBe(1);

    // relay drops INSIDE the sticky window → relay retried, LAN stays parked
    relay.lose({ closeCode: 1006 });
    await clock.advance(1_000); // backoff(0) = 1s
    expect(lan.connectCalls).toBe(1); // sticky: no LAN probe within the window
    relay.succeed();
    await clock.advance(200);
    expect(manager.status).toBe('online-relay');

    // after the window, the low-frequency reprobe fires and LAN wins
    await clock.advance(60_000);
    expect(lan.connectCalls).toBe(2);
    lan.succeed();
    await clock.advance(200);
    expect(manager.status).toBe('online-lan');
    expect(relay.destroyed).toBe(false); // background relay socket stays warm

    // full steady-state trail: fallback produced exactly one honest reconnect
    expect(emitted()).toEqual(['offline', 'online-relay', 'reconnecting', 'online-relay', 'online-lan']);
  });

  test('relay 在线时重探 LAN 失败不掉出稳态（防抖：不出现 reconnecting/offline）', async () => {
    const { clock, lan, relay, manager, emitted } = makeHarness();
    manager.start();
    lan.fail({});
    await clock.advance(0); // let the cycle continue onto the relay channel
    relay.succeed();
    await clock.advance(200);
    expect(manager.status).toBe('online-relay');

    await clock.advance(60_000); // reprobe fires
    lan.fail({ errorKind: 'timeout' }); // probe fails again
    expect(relay.connectCalls).toBe(1); // relay untouched
    await clock.advance(1_000);
    expect(manager.status).toBe('online-relay');
    expect(emitted()).toEqual(['offline', 'online-relay']); // no flap
  });

  test('握手 close 4005 置 offline 并上抛认证失效，且不再重试', async () => {
    const { clock, lan, manager, fatals, emitted } = makeHarness({ relayUrl: '' });
    manager.start();
    lan.succeed();
    await clock.advance(200);
    expect(manager.status).toBe('online-lan');

    lan.lose({ closeCode: 4005, errorKind: 'auth' });
    await clock.advance(200);

    expect(manager.status).toBe('offline');
    expect(emitted()).toEqual(['offline', 'online-lan', 'offline']);
    expect(fatals).toEqual([
      { reason: 'auth', channel: 'lan', detail: expect.stringContaining('认证') },
    ]);

    // auth is never retried — no timers, no further connects
    await clock.advance(120_000);
    expect(lan.connectCalls).toBe(1);
  });

  test('断线指数退避重连序列 1s → 2s → 4s（封顶 30s 由纯函数测试覆盖）', async () => {
    const { clock, relay, manager, emitted } = makeHarness({ wsUrl: null });
    manager.start();
    relay.succeed();
    await clock.advance(200);
    expect(manager.status).toBe('online-relay');

    relay.lose({ closeCode: 1006 });
    // first retry (delay = base) is queued immediately after the loss
    expect(manager.failedAttempts).toBe(1);
    await clock.advance(999);
    expect(relay.connectCalls).toBe(1);
    await clock.advance(1); // backoff(0) = 1s elapsed
    expect(relay.connectCalls).toBe(2);
    relay.fail({ errorKind: 'network' }); // cycle fails → next delay 2s

    await clock.advance(1_999);
    expect(relay.connectCalls).toBe(2);
    await clock.advance(1);
    expect(relay.connectCalls).toBe(3);
    relay.fail({});

    await clock.advance(3_999);
    expect(relay.connectCalls).toBe(3);
    await clock.advance(1);
    expect(relay.connectCalls).toBe(4);

    expect(manager.status).toBe('reconnecting');
    expect(manager.failedAttempts).toBe(3); // three failed cycles queued 1s/2s/4s
    expect(emitted()).toEqual(['offline', 'online-relay', 'reconnecting']);
  });

  test('relay 升级期 401（close 无认证码）不误判 fatal：退避重试中 token 刷新 → 重建通道连上', async () => {
    // The relay rejects an expired JWT at HTTP-upgrade level — the client
    // never sees a 4401 close, just a code-less network-shaped failure, so
    // this MUST stay retryable (mid-connection 4401 token_revoked is the
    // fatal path, covered by classifyClose + the 4005 test above).
    const clock = makeFakeClock();
    let token = 'jwt-expired';
    const channels: FakeChannel[] = [];
    const manager = new ConnectionManager({
      target: () => ({ phoneDeviceId: 'p1', macDeviceId: 'm1', wsUrl: null }),
      token: () => token,
      relayUrl: () => 'wss://relay.test',
      random: () => 0.5,
      now: clock.now,
      timers: clock.timers,
      stateDebounceMs: 100,
      probeWindowMs: 60_000,
      lanReprobeIntervalMs: 60_000,
      createRelayChannel: () => {
        const channel = new FakeChannel('relay');
        channels.push(channel);
        return channel;
      },
    });
    const fatals: FatalInfo[] = [];
    manager.onFatal((info) => fatals.push(info));

    manager.start();
    // cycle 1: expired token → relay upgrade rejected (retryable shape)
    channels[0]!.fail({ errorKind: 'network', errorMessage: 'handshake rejected (401)' });
    expect(fatals).toEqual([]);

    await clock.advance(1_000); // backoff(0) → cycle 2, same token
    expect(channels.length).toBe(1); // same key → channel instance retained
    expect(channels[0]!.connectCalls).toBe(2);
    channels[0]!.fail({ errorKind: 'network' });

    // POL-14 refresh rotation lands in the session store mid-backoff
    token = 'jwt-fresh';
    await clock.advance(2_000); // backoff(1) → cycle 3 re-reads the token
    expect(channels.length).toBe(2); // fresh token → rebuilt channel
    expect(channels[0]!.destroyed).toBe(true);
    channels[1]!.succeed();
    await clock.advance(200);

    expect(manager.status).toBe('online-relay');
    expect(fatals).toEqual([]); // upgrade-401 never escalates to onFatal
  });

  test('无 token / 无 target → 稳定 offline，不拨号', async () => {
    const { clock, lan, relay, manager, emitted } = makeHarness({ token: null });
    manager.start();
    await clock.advance(200);
    expect(manager.status).toBe('offline');
    expect(emitted()).toEqual(['offline']);
    expect(lan.connectCalls).toBe(0);
    expect(relay.connectCalls).toBe(0);
  });

  test('瞬态抖动被去抖：relay 掉线→1s 内恢复不产生新稳态事件', async () => {
    // relay has no sticky window, so the quick loss→recovery flap is realistic here;
    // LAN-side stickiness is covered by the dedicated probe-window test above.
    const { clock, relay, manager, emitted } = makeHarness({ wsUrl: null, stateDebounceMs: 1_500 });
    manager.start();
    relay.succeed();
    await clock.advance(1_600);
    expect(emitted()).toEqual(['offline', 'online-relay']);

    // flap: loss then recovery inside the debounce window (retry at 1s < debounce 1.5s)
    relay.lose({ closeCode: 1006 });
    await clock.advance(1_000);
    relay.succeed();
    await clock.advance(1_600);

    expect(manager.status).toBe('online-relay');
    expect(emitted()).toEqual(['offline', 'online-relay']); // steady states only
  });
});

describe('ConnectionManager pause/resume 与请求路由', () => {
  test('invoke 路由到活动通道；切回直连后路由到 LAN', async () => {
    const { clock, lan, relay, manager } = makeHarness();
    manager.start();
    lan.fail({});
    await clock.advance(0); // let the cycle continue onto the relay channel
    relay.succeed();
    await clock.advance(200);

    await expect(manager.invoke('session:ping')).resolves.toEqual({ echoed: 'session:ping' });
    expect(relay.invokes.map((call) => call.channel)).toEqual(['session:ping']);

    await clock.advance(60_000); // reprobe → LAN wins
    lan.succeed();
    await clock.advance(200);
    await expect(manager.invoke('session:ping')).resolves.toEqual({ echoed: 'session:ping' });
    expect(lan.invokes.map((call) => call.channel)).toEqual(['session:ping']);
  });

  test('离线 invoke 快速失败', async () => {
    const { manager } = makeHarness();
    await expect(manager.invoke('session:ping')).rejects.toThrow('Not connected');
  });

  test('pause 冻结全部定时器；resume 立即触发一轮探测', async () => {
    const { clock, lan, manager, emitted } = makeHarness();
    manager.start();
    lan.succeed();
    await clock.advance(200);
    expect(manager.status).toBe('online-lan');

    manager.pause();
    lan.lose({ closeCode: 1006 }); // backgrounded device loses Wi-Fi
    await clock.advance(120_000);
    expect(manager.status).toBe('online-lan'); // no timers ran, no flap
    expect(lan.connectCalls).toBe(1);

    manager.resume(); // foreground → immediate probe cycle
    lan.succeed(); // ...same channel re-handshakes and wins
    await clock.advance(200);
    expect(lan.connectCalls).toBe(2);
    expect(manager.status).toBe('online-lan');
    expect(emitted()).toEqual(['offline', 'online-lan']);
  });
});

// ---------------------------------------------------------------------------
// relayChannel — real module over a mocked RN-style WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    const wasOpen = this.readyState === 1;
    this.readyState = 3;
    if (wasOpen) this.onclose?.({ code, reason, wasClean: true });
  }

  // test-side server behavior
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  serverMessage(text: string): void {
    this.onmessage?.({ data: text });
  }

  serverClose(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: true });
  }
}

const JSON_CODEC = {
  serialize: (envelope: MessageEnvelope): string => JSON.stringify(envelope),
  deserialize: (raw: string): MessageEnvelope => JSON.parse(raw) as MessageEnvelope,
};

function makeRelayHarness(overrides: Partial<RelayChannelOptions> = {}) {
  const sockets: MockWebSocket[] = [];
  let uuidCount = 0;
  const channel = createRelayChannel({
    relayUrl: 'wss://relay.test',
    phoneDeviceId: 'p1',
    macDeviceId: 'm1',
    token: 'jwt-1',
    protocolVersion: '1.0',
    frameCodec: JSON_CODEC,
    createWebSocket: (url) => {
      const socket = new MockWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    uuid: () => `u${++uuidCount}`,
    ...overrides,
  });
  return { channel, sockets };
}

const ackFrame = (overrides: Record<string, unknown> = {}) => ({
  id: 'ack-1',
  type: 'handshake_ack',
  clientId: 'c-1',
  serverVersion: '0.0.0-test',
  ...overrides,
});

/** Mac → phone relay envelope with a raw WsRpc frame payload (POL-12 shape). */
const macFrame = (frame: unknown): string =>
  JSON.stringify({ v: 1, from: 'mac:m1', to: 'phone:p1', kind: 'rpc', payload: JSON.stringify(frame) });

const eventFrame = (seq: number): unknown => ({
  id: `e${seq}`,
  type: 'event',
  channel: 'session:event',
  args: [{ seq }],
  seq,
});

describe('relayChannel 握手 / 信封 / replay', () => {
  test('握手帧形状：query 鉴权 + 首帧 payload 为含 token 的 WsRpc handshake', async () => {
    const { channel, sockets } = makeRelayHarness();
    const connecting = channel.connect();
    const ws = sockets[0]!;

    // relay upgrade auth rides the query (RN cannot set WS headers)
    expect(ws.url).toBe('wss://relay.test?side=phone&deviceId=p1&token=jwt-1');

    ws.serverOpen();
    expect(ws.sent.length).toBe(1);
    const envelope = JSON.parse(ws.sent[0]!) as Record<string, unknown>;
    expect(envelope).toMatchObject({ v: 1, from: 'phone:p1', to: 'mac:m1', kind: 'rpc' });
    const frame = JSON.parse(envelope.payload as string) as Record<string, unknown>;
    expect(frame).toMatchObject({ type: 'handshake', token: 'jwt-1', protocolVersion: '1.0' });
    expect(frame.reconnectClientId).toBeUndefined(); // first session: no replay identity

    ws.serverMessage(macFrame(ackFrame()));
    await connecting;
  });

  test('invoke/response 关联与超时外离线快速失败', async () => {
    const { channel, sockets } = makeRelayHarness();
    await expect(channel.invoke('session:list')).rejects.toThrow('Not connected');

    const connecting = channel.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverMessage(macFrame(ackFrame()));
    await connecting;

    const pending = channel.invoke('session:list', { limit: 5 });
    const requestFrame = JSON.parse(JSON.parse(ws.sent[1]!).payload) as Record<string, unknown>;
    expect(requestFrame).toMatchObject({ type: 'request', channel: 'session:list', args: [{ limit: 5 }] });
    ws.serverMessage(macFrame({ id: requestFrame.id, type: 'response', result: { devices: [] } }));
    await expect(pending).resolves.toEqual({ devices: [] });
  });

  test('replay：reconnectClientId+lastSeq 随重连握手发送，事件帧按序去重消费', async () => {
    const { channel, sockets } = makeRelayHarness();
    const received: Array<{ channel: string; args: unknown[] }> = [];
    channel.on((name, args) => received.push({ channel: name, args }));

    // session 1: live events 1..3
    const first = channel.connect();
    const ws1 = sockets[0]!;
    ws1.serverOpen();
    ws1.serverMessage(macFrame(ackFrame({ reconnected: false })));
    await first;
    for (const seq of [1, 2, 3]) ws1.serverMessage(macFrame(eventFrame(seq)));
    expect(received.map((event) => (event.args[0] as { seq: number }).seq)).toEqual([1, 2, 3]);

    // drop → reconnect handshake carries the replay identity (in-memory per card)
    ws1.serverClose(1006);
    const second = channel.connect();
    const ws2 = sockets[1]!;
    ws2.serverOpen();
    const envelope = JSON.parse(ws2.sent[0]!) as Record<string, unknown>;
    const handshake = JSON.parse(envelope.payload as string) as Record<string, unknown>;
    expect(handshake.reconnectClientId).toBe('c-1');
    expect(handshake.lastSeq).toBe(3);
    ws2.serverMessage(macFrame(ackFrame({ reconnected: true })));
    await second;

    // replay window: dup 2 dropped, missed 4/5 delivered, live 6 delivered
    ws2.serverMessage(macFrame(eventFrame(2)));
    for (const seq of [4, 5, 6]) ws2.serverMessage(macFrame(eventFrame(seq)));
    const seqs = received.map((event) => (event.args[0] as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]); // 按序、不丢、不重
  });

  test('relay 心跳 ping → pong；control 回执转事件流', async () => {
    const { channel, sockets } = makeRelayHarness();
    const received: Array<{ channel: string; args: unknown[] }> = [];
    channel.on((name, args) => received.push({ channel: name, args }));

    const connecting = channel.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverMessage(macFrame(ackFrame()));
    await connecting;

    ws.serverMessage(JSON.stringify({ type: 'ping', t: 1 }));
    expect(ws.sent[ws.sent.length - 1]).toBe(JSON.stringify({ type: 'pong' }));

    ws.serverMessage(
      JSON.stringify({
        v: 1,
        from: 'relay',
        to: 'phone:p1',
        kind: 'control',
        payload: { type: 'peer_disconnected', peer: 'mac:m1' },
      }),
    );
    expect(received).toEqual([
      { channel: 'relay:peerDisconnected', args: [{ type: 'peer_disconnected', peer: 'mac:m1' }] },
    ]);
  });

  test('认证类关闭（4401）→ connect 拒绝携带 auth 分类；普通 1006 可重试分类', async () => {
    const { channel, sockets } = makeRelayHarness();
    const connecting = channel.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverClose(4401, 'token_revoked');
    await expect(connecting).rejects.toMatchObject({ closeCode: 4401, errorKind: 'auth' });

    const retry = channel.connect();
    const ws2 = sockets[1]!;
    ws2.serverOpen();
    ws2.serverClose(1006);
    await expect(retry).rejects.toMatchObject({ closeCode: 1006 });
  });

  test('Mac 侧握手拒绝（AUTH_FAILED error 帧）→ connect 立即拒绝 auth 分类，socket 随即关闭', async () => {
    // On the relay path the Mac's in-band AUTH_FAILED closes only its loopback
    // pipe — the phone↔relay socket would linger half-open until the connect
    // timer mislabeled it 'timeout' if the channel didn't tear it down itself.
    const { channel, sockets } = makeRelayHarness();
    const connecting = channel.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverMessage(
      macFrame({ id: 'e1', type: 'error', error: { code: 'AUTH_FAILED', message: 'token expired' } }),
    );
    await expect(connecting).rejects.toMatchObject({ errorKind: 'auth', message: 'token expired' });
    expect(ws.readyState).toBe(3); // closed immediately, not at the 5s timer
  });

  test('通道销毁 → in-flight 请求快速失败（不静默丢弃）', async () => {
    const { channel, sockets } = makeRelayHarness();
    const connecting = channel.connect();
    const ws = sockets[0]!;
    ws.serverOpen();
    ws.serverMessage(macFrame(ackFrame()));
    await connecting;

    const pending = channel.invoke('session:sendMessage', { text: 'hi' });
    channel.destroy();
    await expect(pending).rejects.toThrow('Channel switched');
    await expect(connecting).resolves.toBeUndefined();
  });

  test('连接超时（5s 探测预算的 relay 侧等价物）', async () => {
    const { channel } = makeRelayHarness({ connectTimeoutMs: 25 });
    await expect(channel.connect()).rejects.toThrow('Relay connect timeout after 25ms');
  });
});

// ---------------------------------------------------------------------------
// lanChannel — WsRpcClient parameter mapping (real handshake is proven by POL-6)
// ---------------------------------------------------------------------------

class FakeWsRpcClient implements WsRpcClientLike {
  connectCalls = 0;
  destroyed = false;
  private readonly stateListeners = new Set<(state: TransportConnectionState) => void>();
  private readonly eventListeners = new Set<(channel: string, args: unknown[]) => void>();

  connect(): void {
    this.connectCalls += 1;
  }

  invoke(channel: string): Promise<unknown> {
    return Promise.resolve({ echoed: channel });
  }

  onAnyEvent(cb: (channel: string, ...args: unknown[]) => void): () => void {
    // stored in manager-style (channel, args[]) shape; re-spread on delivery
    this.eventListeners.add((channel, args) => cb(channel, ...args));
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  onConnectionStateChanged(cb: (state: TransportConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    cb(this.state('idle')); // mirror WsRpcClient's immediate initial callback
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  reconnectNow(): void {}

  destroy(): void {
    this.destroyed = true;
  }

  private state(
    status: TransportConnectionState['status'],
    extra: Partial<TransportConnectionState> = {},
  ): TransportConnectionState {
    return { mode: 'remote', status, url: 'ws://lan', attempt: 0, updatedAt: 0, ...extra };
  }

  ack(): void {
    for (const cb of this.stateListeners) cb(this.state('connected'));
  }

  fail(closeCode: number, kind: 'auth' | 'network'): void {
    for (const cb of this.stateListeners) {
      cb(this.state('failed', { lastClose: { code: closeCode }, lastError: { kind, message: 'Auth failed' } }));
    }
  }

  emitEvent(channel: string, args: unknown[]): void {
    for (const cb of this.eventListeners) cb(channel, args);
  }
}

function makeLanHarness(options: { connectTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  const created: Array<{ url: string; opts: WsRpcClientOptions }> = [];
  const clients: FakeWsRpcClient[] = [];
  const channel = createLanChannel({
    wsUrl: 'ws://192.168.31.42:9100',
    token: 'jwt-1',
    ...options,
    createClient: (url, opts) => {
      created.push({ url, opts });
      const client = new FakeWsRpcClient();
      clients.push(client);
      return client;
    },
  });
  return { channel, created, clients };
}

describe('lanChannel WsRpcClient 参数映射与生命周期', () => {
  test('默认参数：5s 握手超时、30s 请求超时、关闭库内自动重连（由管理器统一驱动）', () => {
    const { channel, created } = makeLanHarness();
    void channel.connect(); // left pending on purpose — the fake never acks
    expect(created[0]?.url).toBe('ws://192.168.31.42:9100');
    expect(created[0]?.opts).toEqual({
      token: 'jwt-1',
      connectTimeout: 5_000,
      requestTimeout: 30_000,
      autoReconnect: false,
    });
  });

  test('自定义超时透传', () => {
    const { channel, created } = makeLanHarness({ connectTimeoutMs: 1_234, requestTimeoutMs: 4_321 });
    void channel.connect();
    expect(created[0]?.opts).toMatchObject({ connectTimeout: 1_234, requestTimeout: 4_321 });
  });

  test('connect 成功解析 / 失败携带 closeCode+errorKind（同一实例复用，保 replay 身份）', async () => {
    const { channel, clients } = makeLanHarness();
    const first = channel.connect();
    clients[0]?.ack();
    await expect(first).resolves.toBeUndefined();

    const second = channel.connect(); // manager retry — same WsRpcClient instance
    expect(clients.length).toBe(1);
    clients[0]?.fail(4005, 'auth');
    await expect(second).rejects.toMatchObject({ closeCode: 4005, errorKind: 'auth' });
  });

  test('事件流转发（replay+live 统一 onAnyEvent 入口）', async () => {
    const { channel, clients } = makeLanHarness();
    const received: Array<{ channel: string; args: unknown[] }> = [];
    channel.on((name, args) => received.push({ channel: name, args }));
    const connecting = channel.connect();
    clients[0]?.ack();
    await connecting;
    clients[0]?.emitEvent('session:event', [{ seq: 1 }]);
    expect(received).toEqual([{ channel: 'session:event', args: [{ seq: 1 }] }]);
  });

  test('destroy 透传到 WsRpcClient', async () => {
    const { channel, clients } = makeLanHarness();
    const connecting = channel.connect();
    clients[0]?.ack();
    await connecting;
    channel.destroy();
    expect(clients[0]?.destroyed).toBe(true);
  });
});
