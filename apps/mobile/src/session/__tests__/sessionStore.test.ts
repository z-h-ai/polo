// POL-18 unit tests — session store state machine + session controller flow
// (bun test; ConnectionManager fully mocked, no network, fake clock).
//
// Card 自检 matrix:
//   - 发送 → 已送达 → 执行中 → 完成（真实事件名驱动, 用时 N 秒）
//   - 执行失败终态收口（error / typed_error / interrupted, 不滞留执行中）→ 重发
//   - 离线暂存（P05 屏2）→ 本地 5 分钟兜底超时转失败（屏3, PRD §⑥ R3）
//     → 重发复用原消息体并重新计时
//   - replay 去重合并（同一 seq 重复不重复渲染; text_complete 幂等）
//   - relay 回执（peerDisconnected / deliveryFailed）与安全态（onFatal）
//   - 文案映射（eventCard.ts, P05 逐行对照）

import { describe, expect, test } from 'bun:test';

import type { SessionEvent } from '../../../types/shared-protocol';
import { formatCountdown, conversationChipFor, deliveryFailureCopy, eventCardRow } from '../eventCard';
import { Outbox, OUTBOX_TTL_MS } from '../outbox';
import type { OutboxEntry } from '../outbox';
import { SessionController } from '../sessionRpc';
import { SESSION_RPC } from '../rpcChannels';
import { useSessionStore } from '../sessionStore';
import type { ConnStatus } from '../../conn/ConnectionManager';

// ---------------------------------------------------------------------------
// Fake clock + fake connection manager
// ---------------------------------------------------------------------------

interface FakeClock {
  now: () => number;
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
  advance: (ms: number) => Promise<void>;
}

function makeFakeClock(): FakeClock {
  let current = 1_700_000_000_000;
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
  };
}

type InvokeHandler = (channel: string, args: unknown[]) => unknown;

class FakeManager {
  status: ConnStatus = 'offline';
  invokeLog: Array<{ channel: string; args: unknown[] }> = [];
  private readonly handlers = new Set<(channel: string, args: unknown[]) => void>();
  private readonly statusHandlers = new Set<(info: { status: ConnStatus; label: string; attempt: number }) => void>();
  private readonly fatalHandlers = new Set<(info: { reason: 'auth'; channel: 'lan' | 'relay' }) => void>();
  private readonly responses = new Map<string, InvokeHandler>();
  /** Consumed once, then default ack resumes. */
  sendMessageError: Error | null = null;
  /** getWorkspaces probe failure toggle (Mac-liveness probe tests). */
  workspacesError: Error | null = null;
  /** HOLD sendMessage responses — models an RPC with no Mac ack yet. */
  holdSendMessage = false;
  private held: Array<(value: unknown) => void> = [];

  constructor() {
    this.responses.set(SESSION_RPC.GET_WORKSPACES, () => {
      if (this.workspacesError) {
        const error = this.workspacesError;
        this.workspacesError = null;
        throw error;
      }
      return [{ id: 'ws-1', name: '默认工作区' }];
    });
    this.responses.set(SESSION_RPC.CREATE, () => ({ id: 'sess-1', name: '手机会话' }));
    this.responses.set(SESSION_RPC.SEND_MESSAGE, () => {
      if (this.sendMessageError) {
        const error = this.sendMessageError;
        this.sendMessageError = null;
        throw error;
      }
      return { accepted: true, messageId: 'srv-msg-1' };
    });
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invokeLog.push({ channel, args });
    if (channel === SESSION_RPC.SEND_MESSAGE && this.holdSendMessage) {
      return new Promise((resolve) => {
        this.held.push(resolve);
      });
    }
    const handler = this.responses.get(channel);
    if (handler) return handler(channel, args);
    return { accepted: true };
  }

  /** Releases every held sendMessage with the default ack. */
  releaseSendMessage(): void {
    const pending = this.held;
    this.held = [];
    for (const resolve of pending) resolve({ accepted: true, messageId: 'srv-msg-1' });
  }

  on(cb: (channel: string, args: unknown[]) => void): () => void {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
  }

  onStatus(cb: (info: { status: ConnStatus; label: string; attempt: number }) => void): () => void {
    this.statusHandlers.add(cb);
    cb({ status: this.status, label: this.status, attempt: 0 });
    return () => this.statusHandlers.delete(cb);
  }

  onFatal(cb: (info: { reason: 'auth'; channel: 'lan' | 'relay' }) => void): () => void {
    this.fatalHandlers.add(cb);
    return () => this.fatalHandlers.delete(cb);
  }

  emit(channel: string, args: unknown[]): void {
    for (const handler of this.handlers) handler(channel, args);
  }

  setStatus(status: ConnStatus): void {
    this.status = status;
    for (const handler of this.statusHandlers) handler({ status, label: status, attempt: 0 });
  }

  fatal(): void {
    for (const handler of this.fatalHandlers) handler({ reason: 'auth', channel: 'relay' });
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  clock: FakeClock;
  manager: FakeManager;
  controller: SessionController;
  expired: OutboxEntry[];
  sessionEvent(event: SessionEvent, seq?: number): void;
}

function resetStore(): void {
  useSessionStore.setState({
    sessionId: null,
    workspaceId: null,
    entries: [],
    boundTurnIds: {},
    connStatus: 'offline',
    macOffline: false,
    fatal: null,
    lastEventSeq: 0,
  });
}

function makeHarness(): Harness {
  resetStore();
  const clock = makeFakeClock();
  const manager = new FakeManager();
  const expired: OutboxEntry[] = [];
  const outbox = new Outbox({
    now: clock.now,
    timers: clock.timers,
    onExpire: (entry) => {
      expired.push(entry);
      useSessionStore.getState().markFailed({
        id: entry.key,
        atMs: clock.now(),
        kind: 'send',
        errorText: '电脑离线超过 5 分钟，消息未送达',
      });
    },
    onEvicted: (entry) => {
      useSessionStore.getState().markFailed({
        id: entry.key,
        atMs: clock.now(),
        kind: 'send',
        errorText: '暂存队列已满，消息未送达',
      });
    },
  });
  const controller = new SessionController({
    manager,
    store: useSessionStore,
    outbox,
    uuid: (() => {
      let counter = 0;
      return () => `local-${++counter}`;
    })(),
    now: clock.now,
    timers: clock.timers,
    livenessProbeIntervalMs: 10_000,
  });
  controller.attach();
  return {
    clock,
    manager,
    controller,
    expired,
    sessionEvent: (event, seq) => useSessionStore.getState().applySessionEvent(event, seq, clock.now()),
  };
}

const entries = () => useSessionStore.getState().entries;
const turnOf = (id: string) => entries().find((entry) => entry.id === id)?.turn ?? null;

// ---------------------------------------------------------------------------
// 状态机：发送 → 已送达 → 执行中 → 完成
// ---------------------------------------------------------------------------

describe('发送 → 已送达 → 执行中 → 完成（真实事件名）', () => {
  test('在线发送：sessions:create（如无会话）→ sendMessage → ack 置已送达', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('帮我把这份季度文档总结成三个要点');

    const channels = h.manager.invokeLog.map((call) => call.channel);
    expect(channels).toEqual([
      SESSION_RPC.GET_WORKSPACES,
      SESSION_RPC.CREATE,
      SESSION_RPC.SEND_MESSAGE,
    ]);
    // sendMessage(sessionId, message, attachments?, storedAttachments?, options?)
    const sendCall = h.manager.invokeLog[2];
    expect(sendCall?.channel).toBe(SESSION_RPC.SEND_MESSAGE);
    expect(sendCall?.args[0]).toBe('sess-1');
    expect(sendCall?.args[1]).toBe('帮我把这份季度文档总结成三个要点');
    expect(sendCall?.args[4]).toEqual({ optimisticMessageId: 'local-1' });

    expect(useSessionStore.getState().sessionId).toBe('sess-1');
    expect(useSessionStore.getState().workspaceId).toBe('ws-1');
    const turn = turnOf('local-1');
    expect(turn?.state).toBe('delivered');
    expect(turn?.channelLabel).toBe('Wi-Fi 直连');
  });

  test('text_delta / text_complete → 执行中 + Mac 回复气泡（不重复渲染）', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-relay');
    await h.controller.send('总结文档');
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '三个要点：1）营收' });
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '同比增长 18%' });

    expect(turnOf('local-1')?.state).toBe('running');
    const assistant = entries().filter((entry) => entry.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe('三个要点：1）营收同比增长 18%');

    h.sessionEvent({
      type: 'text_complete',
      sessionId: 'sess-1',
      text: '三个要点：1）营收同比增长 18%；2）…；3）…。',
    });
    const final = entries().filter((entry) => entry.role === 'assistant');
    expect(final).toHaveLength(1);
    expect(final[0]?.text).toBe('三个要点：1）营收同比增长 18%；2）…；3）…。');
    // Still 执行中 — only `complete` closes the turn.
    expect(turnOf('local-1')?.state).toBe('running');
  });

  test('complete → 完成·用时 N 秒（基线 = 首个执行活动）', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('总结文档');
    await h.clock.advance(2000);
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '好的' });
    await h.clock.advance(26_000);
    h.sessionEvent({ type: 'complete', sessionId: 'sess-1' });

    const turn = turnOf('local-1');
    expect(turn?.state).toBe('done');
    expect(turn?.durationSeconds).toBe(26);
    expect(turn?.finishedAtMs).toBe(h.clock.now());
  });

  test('user_message 事件：optimisticMessageId 绑定确认，processing → 执行中', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('你好');
    expect(turnOf('local-1')?.state).toBe('delivered');
    // Server echo arrives (idempotent — already delivered via the ack).
    h.sessionEvent({
      type: 'user_message',
      sessionId: 'sess-1',
      message: { id: 'srv-msg-1' },
      status: 'accepted',
      optimisticMessageId: 'local-1',
    });
    expect(turnOf('local-1')?.state).toBe('delivered');
    h.sessionEvent({
      type: 'user_message',
      sessionId: 'sess-1',
      message: { id: 'srv-msg-1' },
      status: 'processing',
      optimisticMessageId: 'local-1',
    });
    expect(turnOf('local-1')?.state).toBe('running');
    // Echo for a foreign optimistic id never touches our entries.
    h.sessionEvent({
      type: 'user_message',
      sessionId: 'sess-1',
      message: { id: 'srv-other' },
      status: 'accepted',
      optimisticMessageId: 'someone-else',
    });
    expect(entries()).toHaveLength(1);
  });

  test('其他会话的事件被忽略；未知类型安全略过', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('总结文档');
    const before = entries();
    h.sessionEvent({ type: 'complete', sessionId: 'sess-other' });
    h.sessionEvent({ type: 'title_generated', sessionId: 'sess-1', title: '季度总结' } as never);
    expect(entries()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 去重（replay）
// ---------------------------------------------------------------------------

describe('replay 去重合并', () => {
  test('同一事件 seq 重复不重复渲染', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('总结文档');
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '要点一' }, 11);
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '要点一' }, 11); // replay dup
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '；要点二' }, 12);

    const assistant = entries().filter((entry) => entry.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe('要点一；要点二');
  });

  test('乱序/旧 seq 被丢弃（seq 只前进）', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('总结文档');
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '新帧' }, 20);
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '旧帧' }, 19);
    const assistant = entries().filter((entry) => entry.role === 'assistant');
    expect(assistant[0]?.text).toBe('新帧');
  });

  test('无 seq 的重复 text_complete 幂等（不追加第二块气泡）', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('总结文档');
    const complete: SessionEvent = {
      type: 'text_complete',
      sessionId: 'sess-1',
      text: '最终回复',
    };
    h.sessionEvent(complete);
    h.sessionEvent(complete);
    const assistant = entries().filter((entry) => entry.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.text).toBe('最终回复');
  });
});

// ---------------------------------------------------------------------------
// 执行失败终态收口 + 重发
// ---------------------------------------------------------------------------

describe('执行失败终态（不滞留执行中）→ 重发', () => {
  test('error 事件 → 执行失败 + 原因 + 重新发送；重发复用原消息体', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('跑一次部署');
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '开始' });
    h.sessionEvent({ type: 'error', sessionId: 'sess-1', error: 'SDK 子进程崩溃' });

    const turn = turnOf('local-1');
    expect(turn?.state).toBe('failed');
    expect(turn?.failureKind).toBe('exec');
    expect(turn?.errorText).toBe('SDK 子进程崩溃');

    // 终态不被后续事件覆盖（不复活）。
    h.sessionEvent({ type: 'complete', sessionId: 'sess-1' });
    expect(turnOf('local-1')?.state).toBe('failed');

    // 重新发送 → 复用原消息体 → 新一轮 已送达。
    await h.controller.resend('local-1');
    const sendCalls = h.manager.invokeLog.filter((call) => call.channel === SESSION_RPC.SEND_MESSAGE);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1]?.args[1]).toBe('跑一次部署');
    expect(turnOf('local-1')?.state).toBe('delivered');
    expect(turnOf('local-1')?.errorText).toBeUndefined();
  });

  test('typed_error 用 message 作为失败原因；interrupted 以失败收口', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('总结文档');
    h.sessionEvent({
      type: 'typed_error',
      sessionId: 'sess-1',
      error: { code: 'unknown_error', title: '出错了', message: '电脑上处理出错', canRetry: true },
    });
    expect(turnOf('local-1')?.state).toBe('failed');
    expect(turnOf('local-1')?.errorText).toBe('电脑上处理出错');

    await h.controller.resend('local-1');
    h.sessionEvent({ type: 'interrupted', sessionId: 'sess-1' });
    expect(turnOf('local-1')?.state).toBe('failed');
    expect(turnOf('local-1')?.failureKind).toBe('exec');
  });

  test('done 后迟到 error / complete 幂等（终态不复活、不串扰）', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    await h.controller.send('总结文档');
    h.sessionEvent({ type: 'text_delta', sessionId: 'sess-1', delta: '处理中' });
    h.sessionEvent({ type: 'complete', sessionId: 'sess-1' });
    expect(turnOf('local-1')?.state).toBe('done');

    // replay / 乱序迟到的终态前事件 — done 不可被覆盖。
    h.sessionEvent({ type: 'error', sessionId: 'sess-1', error: '迟到错误' });
    h.sessionEvent({ type: 'typed_error', sessionId: 'sess-1', error: { code: 'x', title: 'x', message: '迟到', canRetry: false } });
    h.sessionEvent({ type: 'interrupted', sessionId: 'sess-1' });
    h.sessionEvent({ type: 'complete', sessionId: 'sess-1' });

    const turn = turnOf('local-1');
    expect(turn?.state).toBe('done');
    expect(turn?.errorText).toBeUndefined();
    expect(turn?.failedAtMs).toBeUndefined();
  });

  test('仍在线时的发送业务错误 → 发送失败·可重发', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-lan');
    h.manager.sendMessageError = new Error('会话不存在');
    await h.controller.send('你好');
    const turn = turnOf('local-1');
    expect(turn?.state).toBe('failed');
    expect(turn?.failureKind).toBe('send');
    expect(turn?.errorText).toBe('会话不存在');
  });
});

// ---------------------------------------------------------------------------
// 离线暂存（P05 屏2/屏3, PRD §⑥ R3）
// ---------------------------------------------------------------------------

describe('离线暂存 → 兜底超时失败 → 重发', () => {
  test('Mac 离线发送 → 已暂存卡（剩余 5:00）', async () => {
    const h = makeHarness();
    await h.controller.send('好，那重新跑一次部署');
    expect(h.manager.invokeLog).toHaveLength(0); // nothing dialed while offline

    const turn = turnOf('local-1');
    expect(turn?.state).toBe('queued');
    expect(turn?.expireAtMs).toBe(turn!.queuedAtMs! + OUTBOX_TTL_MS);
    const row = eventCardRow(turn!, h.clock.now());
    expect(row.title).toBe('已暂存');
    expect(row.detail).toBe(`等待 Mac 上线 · 剩余 ${formatCountdown(OUTBOX_TTL_MS)}`);
    expect(row.detail).toContain('剩余 5:00');
  });

  test('本地 5 分钟兜底超时 → 发送失败·可重发（不依赖 relay 回执）', async () => {
    const h = makeHarness();
    await h.controller.send('重新跑部署');
    await h.clock.advance(OUTBOX_TTL_MS + 1000);

    const turn = turnOf('local-1');
    expect(turn?.state).toBe('failed');
    expect(turn?.failureKind).toBe('send');
    expect(turn?.errorText).toBe('电脑离线超过 5 分钟，消息未送达');
    const row = eventCardRow(turn!, h.clock.now());
    expect(row.title).toBe('发送失败');
    expect(row.resend).toBe(true);
  });

  test('重连 flush：暂存按序投递（复用原消息体, re-计时语义）', async () => {
    const h = makeHarness();
    await h.controller.send('第一条');
    h.clock.advance(1000);
    await h.controller.send('第二条');
    h.manager.invokeLog.length = 0;

    h.manager.setStatus('online-relay');
    await h.clock.advance(0); // flush is async — drain microtasks

    const sendCalls = h.manager.invokeLog.filter((call) => call.channel === SESSION_RPC.SEND_MESSAGE);
    expect(sendCalls.map((call) => call.args[1])).toEqual(['第一条', '第二条']);
    expect(turnOf('local-1')?.state).toBe('delivered');
    expect(turnOf('local-1')?.channelLabel).toBe('云中转');
    expect(turnOf('local-2')?.state).toBe('delivered');
  });

  test('重发在离线时再暂存并重新计时', async () => {
    const h = makeHarness();
    await h.controller.send('重新跑部署');
    await h.clock.advance(OUTBOX_TTL_MS + 1000); // 兜底超时 → failed
    expect(turnOf('local-1')?.state).toBe('failed');

    // Still offline — resend re-stages with a FRESH 5-minute window.
    await h.controller.resend('local-1');
    const turn = turnOf('local-1');
    expect(turn?.state).toBe('queued');
    expect(turn?.queuedAtMs).toBe(h.clock.now());
    expect(turn?.expireAtMs).toBe(h.clock.now() + OUTBOX_TTL_MS);
  });

  test('relay:deliveryFailed 回执：只归因在途 relay 发送，不误伤本地暂存', async () => {
    const h = makeHarness();
    // 在途：经云中转发送、Mac 无 ack（回执先于响应到达）→ 归因该在途消息。
    h.manager.setStatus('online-relay');
    h.manager.holdSendMessage = true;
    const inFlight = h.controller.send('第一条');
    await h.clock.advance(0); // drain microtasks — sendMessage is now in flight
    h.manager.emit('relay:deliveryFailed', [{ type: 'delivery_failed', reason: 'mac_offline' }]);
    expect(turnOf('local-1')?.state).toBe('failed');
    expect(turnOf('local-1')?.errorText).toBe('电脑离线超过 5 分钟，消息未送达');
    h.manager.releaseSendMessage();
    await inFlight;
    expect(turnOf('local-1')?.state).toBe('failed'); // 终态不被迟到 ack 覆盖

    // 在途集合已随 settle 清空：迟到回执 no-op，不复活已终态轮次。
    h.manager.emit('relay:deliveryFailed', [{ type: 'delivery_failed', reason: 'not_allowed' }]);
    expect(turnOf('local-1')?.state).toBe('failed');

    // 本地暂存从未触达 relay —— 回执不得盲 FIFO 误伤（回归：归因错到新消息）。
    h.manager.setStatus('offline');
    await h.controller.send('第二条');
    expect(turnOf('local-2')?.state).toBe('queued');
    h.manager.emit('relay:deliveryFailed', [{ type: 'delivery_failed', reason: 'queue_full' }]);
    expect(turnOf('local-2')?.state).toBe('queued');
  });

  test('Mac 离线（经云中转在线）→ 发送走本地暂存，不拨 relay（防 relay 排队后双执行）', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-relay');
    h.manager.emit('relay:peerDisconnected', [{ type: 'peer_disconnected', peer: 'mac:abc' }]);
    await h.controller.send('总结文档');

    expect(h.manager.invokeLog).toHaveLength(0); // 消息体绝不进 relay 离线队列
    const turn = turnOf('local-1');
    expect(turn?.state).toBe('queued');
  });

  test('Mac 静默回归 relay：活性探测清横幅并 flush 暂存（relay 无回连通知）', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-relay');
    h.manager.emit('relay:peerDisconnected', [{ type: 'peer_disconnected', peer: 'mac:abc' }]);
    await h.controller.send('总结文档'); // macOffline → staged
    expect(turnOf('local-1')?.state).toBe('queued');

    // Mac 重新接上 relay —— 无任何状态事件，探测到期后证明活性。
    await h.clock.advance(10_000);
    expect(useSessionStore.getState().macOffline).toBe(false);

    await h.clock.advance(0); // flush is async — drain microtasks
    const sends = h.manager.invokeLog.filter((call) => call.channel === SESSION_RPC.SEND_MESSAGE);
    expect(sends.map((call) => call.args[1])).toEqual(['总结文档']);
    expect(turnOf('local-1')?.state).toBe('delivered');
    expect(turnOf('local-1')?.channelLabel).toBe('云中转');
  });

  test('探测失败（Mac 仍未上线）→ 保持暂存与横幅，下个周期重试', async () => {
    const h = makeHarness();
    h.manager.setStatus('online-relay');
    h.manager.emit('relay:peerDisconnected', [{ type: 'peer_disconnected', peer: 'mac:abc' }]);
    await h.controller.send('总结文档');

    h.manager.workspacesError = new Error('Request timeout');
    await h.clock.advance(10_000);
    expect(useSessionStore.getState().macOffline).toBe(true);
    expect(turnOf('local-1')?.state).toBe('queued');

    await h.clock.advance(10_000); // error 已消费，本次探测成功
    expect(useSessionStore.getState().macOffline).toBe(false);
    await h.clock.advance(0);
    expect(turnOf('local-1')?.state).toBe('delivered');
  });

  test('Mac echo（user_message）清暂存：queued 翻转已送达，本地 TTL 不再误杀', async () => {
    const h = makeHarness();
    await h.controller.send('离线消息'); // staged
    // relay 离线队列竞态：副本先被 Mac 收到并回显（无状态事件、无 flush）。
    h.manager.emit(SESSION_RPC.EVENT, [
      {
        type: 'user_message',
        sessionId: 'sess-1',
        message: { id: 'srv-1' },
        status: 'accepted',
        optimisticMessageId: 'local-1',
      },
    ]);
    expect(turnOf('local-1')?.state).toBe('delivered');
    await h.clock.advance(OUTBOX_TTL_MS + 1000);
    expect(turnOf('local-1')?.state).toBe('delivered'); // TTL 不打成发送失败
  });

  test('relay:peerDisconnected → Mac 离线（暂存横幅语义）', () => {
    const h = makeHarness();
    expect(useSessionStore.getState().macOffline).toBe(false);
    h.manager.emit('relay:peerDisconnected', [{ type: 'peer_disconnected', peer: 'mac:abc' }]);
    expect(useSessionStore.getState().macOffline).toBe(true);
  });

  test('重连上线清除 macOffline 与 fatal（恢复语义）', () => {
    const h = makeHarness();
    h.manager.emit('relay:peerDisconnected', [{ type: 'peer_disconnected', peer: 'mac:abc' }]);
    h.manager.fatal();
    expect(useSessionStore.getState().fatal).not.toBeNull();
    h.manager.setStatus('online-lan');
    expect(useSessionStore.getState().macOffline).toBe(false);
    expect(useSessionStore.getState().fatal).toBeNull();
  });

  test('onFatal 安全态：暂存消息全部转失败（绑定已解除，不可送达）', async () => {
    const h = makeHarness();
    await h.controller.send('离线消息');
    h.manager.fatal();
    expect(useSessionStore.getState().fatal?.reason).toBe('auth');
    expect(turnOf('local-1')?.state).toBe('failed');
    expect(turnOf('local-1')?.errorText).toBe('绑定已解除，消息未送达');
  });
});

// ---------------------------------------------------------------------------
// 文案映射（P05 逐行）
// ---------------------------------------------------------------------------

describe('事件卡文案映射', () => {
  const base = {
    state: 'sent' as const,
    sentAtMs: 0,
  };

  test('已送达：HH:mm:ss · 通道', () => {
    const atMs = new Date('2026-10-18T14:20:03').getTime();
    const row = eventCardRow({ ...base, state: 'delivered', deliveredAtMs: atMs, channelLabel: 'Wi-Fi 直连' }, 0);
    expect(row.title).toBe('已送达');
    expect(row.detail).toBe('14:20:03 · Wi-Fi 直连');
    expect(row.resend).toBe(false);
  });

  test('执行中：Polo AI 正在电脑上处理', () => {
    const row = eventCardRow({ ...base, state: 'running' }, 0);
    expect(row.title).toBe('执行中');
    expect(row.detail).toBe('Polo AI 正在电脑上处理');
  });

  test('完成：用时 26 秒', () => {
    const row = eventCardRow({ ...base, state: 'done', durationSeconds: 26 }, 0);
    expect(row.title).toBe('完成');
    expect(row.detail).toBe('用时 26 秒');
  });

  test('发送失败 / 执行失败：带时间戳 + 重新发送', () => {
    const atMs = new Date('2026-10-18T14:26').getTime();
    const send = eventCardRow(
      { ...base, state: 'failed', failureKind: 'send', failedAtMs: atMs },
      0,
    );
    expect(send.title).toBe('发送失败');
    expect(send.detail).toContain('电脑离线超过 5 分钟，消息未送达');
    expect(send.detail).toContain('14:26');
    expect(send.resend).toBe(true);

    const exec = eventCardRow(
      { ...base, state: 'failed', failureKind: 'exec', failedAtMs: atMs, errorText: 'SDK 子进程崩溃' },
      0,
    );
    expect(exec.title).toBe('执行失败');
    expect(exec.detail).toContain('SDK 子进程崩溃');
    expect(exec.resend).toBe(true);
  });

  test('deliveryFailureCopy / conversationChipFor', () => {
    expect(deliveryFailureCopy('mac_offline')).toBe('电脑离线超过 5 分钟，消息未送达');
    expect(deliveryFailureCopy('not_allowed')).toContain('拒绝');
    expect(conversationChipFor({ ...base, state: 'done', durationSeconds: 26 })).toBe(
      '任务已完成 · 用时 26 秒',
    );
    expect(conversationChipFor({ ...base, state: 'queued' })).toContain('已暂存');
    expect(conversationChipFor(undefined)).toBeNull();
  });

  test('formatCountdown m:ss', () => {
    expect(formatCountdown(252_000)).toBe('4:12');
    expect(formatCountdown(0)).toBe('0:00');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});
