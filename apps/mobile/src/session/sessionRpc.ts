// Session RPC controller (POL-243 card step 3) — the message layer over the
// POL-242 ConnectionManager.
//
//   send(text):
//     local echo (sent) → Mac online?  yes → sessions:create (first time only)
//         → sessions:sendMessage → ack {accepted,messageId} marks 已送达;
//                            no  → outbox stage (已暂存, local 5-min 兜底计时).
//     Deliver failure: transport-down re-stages (P05 暂存语义); a business
//     error while still online closes as 发送失败·可重发.
//
//   flush(): on every transition to an online steady state, staged messages
//     are delivered oldest-first (relay drains by queuedAt — we mirror it);
//     each reuse of the original body re-arms its local window (card: 重新计时).
//     Staging gates on Mac-offline too: while the Mac is away from the relay
//     (relay:peerDisconnected) the manager intentionally keeps online-relay,
//     so sends must stage locally — dialing the relay would queue the envelope
//     THERE (the Mac then executes a message the phone shows as failed, and a
//     resend executes it twice).
//
//   Mac liveness: the relay announces only DISconnects (verified against
//     packages/relay/src/server.ts — no reconnect receipt exists). While
//     staged messages wait on macOffline, a read-only RPC is polled; the
//     first answered probe proves the Mac is back → lift the banner + flush.
//
//   Event surface (manager.on): 'session:event' → store state machine (a
//     user_message echo also drops the local staged copy — the Mac holds the
//     body, the local TTL must not fail it later); 'relay:peerDisconnected' →
//     staging banner; 'relay:deliveryFailed' → receipt carries NO correlation
//     id (relay envelope.ts), so it is attributed only to this session's
//     in-flight relay sends, oldest first — never blindly FIFO over the
//     outbox, which would mis-fail newer staged messages that never touched
//     the wire.
//
//   Auth fatal (close 4005/4401/4403) → P05 屏5 安全态: banner + input
//     disabled; recovery (online again after re-pair/start) clears it.

import type { ConnStatus, ConnTimers, ConnectionManager } from '../conn/ConnectionManager';
import type { DeliveryFailedPayload, PeerDisconnectedPayload } from './rpcChannels';
import { RELAY_CONTROL, SESSION_RPC } from './rpcChannels';
import { Outbox } from './outbox';
import { defaultOutboxTimers } from './outbox';
import type { OutboxEntry } from './outbox';
import { deliveryFailureCopy } from './eventCard';
import { useSessionStore } from './sessionStore';
import type { SessionStore } from './sessionStore';
import type { SessionEvent, SessionInfo, WorkspaceInfo } from '../../types/shared-protocol';

/** Structural surface of ConnectionManager consumed here (tests inject fakes). */
export interface SessionConnectionLike {
  readonly status: ConnStatus;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(cb: (channel: string, args: unknown[]) => void): () => void;
  onStatus(cb: (info: { status: ConnStatus; label: string; attempt: number; detail?: string }) => void): () => void;
  onFatal(cb: (info: { reason: 'auth'; channel: 'lan' | 'relay'; detail?: string }) => void): () => void;
}

/** The zustand hook surface (state via getState(); actions live in state). */
export type SessionStoreHook = typeof useSessionStore;

export interface SessionControllerOptions {
  manager: SessionConnectionLike;
  store?: SessionStoreHook;
  outbox?: Outbox;
  uuid?: () => string;
  now?: () => number;
  /** Injectable timers (fake clock in tests; real setTimeout in the app). */
  timers?: ConnTimers;
  /** Mac-liveness probe cadence while staged messages wait out a Mac outage. */
  livenessProbeIntervalMs?: number;
}

/** Poll cadence for the Mac-back-on-relay probe (no reconnect receipt exists). */
export const DEFAULT_LIVENESS_PROBE_INTERVAL_MS = 10_000;

function defaultUuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export const SESSION_NAME = '手机会话';

export class SessionController {
  private readonly manager: SessionConnectionLike;
  private readonly outbox: Outbox;
  private store: SessionStoreHook;
  private readonly uuid: () => string;
  private readonly now: () => number;
  private readonly timers: ConnTimers;
  private readonly probeIntervalMs: number;
  private detachFns: Array<() => void> = [];
  private flushing = false;
  /** EntryIds handed to the relay transport and not settled yet (FIFO). */
  private readonly pendingRelaySends: string[] = [];
  private probeTimer: unknown = null;
  private probeInFlight = false;

  constructor(options: SessionControllerOptions) {
    this.manager = options.manager;
    this.store = options.store ?? useSessionStore;
    this.uuid = options.uuid ?? defaultUuid;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultOutboxTimers();
    this.probeIntervalMs = options.livenessProbeIntervalMs ?? DEFAULT_LIVENESS_PROBE_INTERVAL_MS;
    this.outbox =
      options.outbox ??
      new Outbox({
        onExpire: (entry) => this.expireStaged(entry),
        onEvicted: (entry) => this.evictStaged(entry),
      });
  }

  /** Subscribes to the connection manager. Idempotent; app entry points call
   * this on focus/mount — extra calls are no-ops until detach(). */
  attach(): void {
    if (this.detachFns.length > 0) return;
    this.detachFns = [
      this.manager.on((channel, args) => this.onManagerEvent(channel, args)),
      this.manager.onStatus((info) => this.onStatus(info.status)),
      this.manager.onFatal((info) => {
        this.snapshot().setFatal(info);
        this.failAllStaged('绑定已解除，消息未送达');
      }),
    ];
    this.syncLivenessProbe();
  }

  detach(): void {
    for (const detach of this.detachFns) detach();
    this.detachFns = [];
    this.clearProbeTimer();
    this.pendingRelaySends.length = 0;
  }

  /** Current store snapshot (zustand actions live on the state object). */
  private snapshot(): SessionStore {
    return this.store.getState();
  }

  // -- sending ---------------------------------------------------------------

  /** May a message hit the wire right now? Gate on Mac-offline too: with the
   * Mac away from the relay the manager keeps online-relay by design, and a
   * send would park the envelope in the relay's offline queue — the Mac would
   * later execute a message the phone shows as 发送失败, and a resend would
   * execute it twice. P05 暂存语义 is keyed on the MAC, not the transport. */
  private canDeliverNow(): boolean {
    return isOnline(this.manager.status) && !this.snapshot().macOffline;
  }

  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = this.uuid();
    const atMs = this.now();
    this.snapshot().appendUserEntry({ id, text: trimmed, atMs });
    if (!this.canDeliverNow()) {
      this.stageEntry(id, trimmed);
      return;
    }
    await this.deliver(id, trimmed);
  }

  /** 失败卡「重新发送」— reuse the original body, restart the machine. */
  async resend(entryId: string): Promise<void> {
    const entry = this.snapshot().entries.find((candidate) => candidate.id === entryId);
    if (!entry || entry.role !== 'user' || !entry.turn || entry.turn.state !== 'failed') return;
    this.snapshot().resetTurnToSent({ id: entryId, sentAtMs: this.now() });
    if (!this.canDeliverNow()) {
      this.stageEntry(entryId, entry.text);
      return;
    }
    await this.deliver(entryId, entry.text);
  }

  /** Text of a staged/failed entry for composer prefill helpers. */
  entryText(entryId: string): string | null {
    return this.snapshot().entries.find((candidate) => candidate.id === entryId)?.text ?? null;
  }

  private async deliver(entryId: string, text: string): Promise<void> {
    // Receipts carry no correlation id — remember which sends are in flight
    // over the relay so a delivery_failed can be attributed without guessing.
    const overRelay = this.manager.status === 'online-relay';
    if (overRelay) this.pendingRelaySends.push(entryId);
    try {
      await this.deliverInner(entryId, text);
    } finally {
      if (overRelay) {
        const index = this.pendingRelaySends.indexOf(entryId);
        if (index >= 0) this.pendingRelaySends.splice(index, 1);
      }
    }
  }

  private async deliverInner(entryId: string, text: string): Promise<void> {
    let sessionId: string;
    try {
      sessionId = await this.ensureSession();
    } catch (error) {
      this.failDelivery(entryId, errorMessage(error));
      return;
    }
    try {
      const result = (await this.manager.invoke(
        SESSION_RPC.SEND_MESSAGE,
        sessionId,
        text,
        undefined,
        undefined,
        { optimisticMessageId: entryId },
      )) as { accepted?: boolean; messageId?: string } | undefined;
      if (!result || result.accepted !== true) {
        throw new Error('电脑未确认接收该消息');
      }
      this.snapshot().markDelivered({
        id: entryId,
        atMs: this.now(),
        channelLabel: channelLabelOf(this.manager.status),
      });
      // Off the staging queue — the local TTL sweep must not touch it anymore.
      this.outbox.remove(entryId);
    } catch (error) {
      if (!this.canDeliverNow()) {
        // Transport dropped (or the Mac left the relay) mid-send — fall back
        // to staging (P05 暂存语义).
        this.stageEntry(entryId, text);
        return;
      }
      this.failDelivery(entryId, errorMessage(error));
    }
  }

  private failDelivery(entryId: string, errorText: string): void {
    this.outbox.remove(entryId);
    this.snapshot().markFailed({
      id: entryId,
      atMs: this.now(),
      kind: 'send',
      errorText,
    });
  }

  // -- staging ----------------------------------------------------------------

  private stageEntry(entryId: string, text: string): void {
    // Terminal turns never re-enter the staging queue (a receipt-failed send
    // whose invoke rejects later must not come back as 已暂存).
    const turn = this.snapshot().entries.find((candidate) => candidate.id === entryId)?.turn;
    if (!turn || turn.state === 'done' || turn.state === 'failed') return;
    const existing = this.outbox.get(entryId);
    const staged = existing
      ? this.outbox.restage(entryId)
      : this.outbox.stage(entryId, text).entry;
    if (!staged) return;
    this.snapshot().markQueued({
      id: entryId,
      queuedAtMs: staged.queuedAtMs,
      expireAtMs: staged.expireAtMs,
    });
  }

  private expireStaged(entry: OutboxEntry): void {
    // Local 5-min 兜底 (PRD §⑥ R3): no relay receipt needed.
    this.snapshot().markFailed({
      id: entry.key,
      atMs: this.now(),
      kind: 'send',
      errorText: '电脑离线超过 5 分钟，消息未送达',
    });
  }

  private evictStaged(entry: OutboxEntry): void {
    this.snapshot().markFailed({
      id: entry.key,
      atMs: this.now(),
      kind: 'send',
      errorText: '暂存队列已满，消息未送达',
    });
  }

  private failAllStaged(errorText: string): void {
    for (const entry of this.outbox.all()) {
      this.outbox.remove(entry.key);
      this.snapshot().markFailed({
        id: entry.key,
        atMs: this.now(),
        kind: 'send',
        errorText,
      });
    }
  }

  /** Reconnect path — drain staged messages oldest-first (relay 排序语义). */
  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const entry of this.outbox.all()) {
        if (!isOnline(this.manager.status)) return; // dropped again — keep staged
        const turn = this.snapshot().entries.find((c) => c.id === entry.key)?.turn;
        if (!turn || turn.state !== 'queued') {
          this.outbox.remove(entry.key);
          continue;
        }
        this.snapshot().resetTurnToSent({ id: entry.key, sentAtMs: this.now() });
        await this.deliver(entry.key, entry.text);
      }
    } finally {
      this.flushing = false;
    }
  }

  // -- session bootstrap ------------------------------------------------------

  private async ensureSession(): Promise<string> {
    const existing = this.snapshot().sessionId;
    if (existing) return existing;
    const workspaces = (await this.manager.invoke(SESSION_RPC.GET_WORKSPACES)) as WorkspaceInfo[];
    const workspaceId = Array.isArray(workspaces) ? workspaces.find((w) => !!w?.id)?.id : undefined;
    if (!workspaceId) {
      throw new Error('电脑上没有可用的工作区，请先在 Mac 上打开 Polo');
    }
    const session = (await this.manager.invoke(
      SESSION_RPC.CREATE,
      workspaceId,
      { name: SESSION_NAME },
    )) as SessionInfo;
    if (!session || typeof session.id !== 'string') {
      throw new Error('电脑未返回会话信息');
    }
    this.snapshot().sessionOpened(session.id, workspaceId);
    return session.id;
  }

  // -- manager subscriptions ----------------------------------------------------

  private onStatus(status: ConnStatus): void {
    this.snapshot().setConnStatus(status);
    if (isOnline(status)) {
      // Online again — staging banner lifts, fatal 安全态 recovers.
      this.snapshot().setMacOffline(false);
      this.snapshot().setFatal(null);
      void this.flush();
    }
    this.syncLivenessProbe();
  }

  private onManagerEvent(channel: string, args: unknown[]): void {
    if (channel === SESSION_RPC.EVENT) {
      const event = args[0];
      if (isRecord(event) && typeof event.type === 'string') {
        this.snapshot().applySessionEvent(event as unknown as SessionEvent);
        // A Mac echo proves it holds the body — drop the local staged copy so
        // the TTL sweep can never fail a turn the Mac has (e.g. when the
        // relay's offline-queue drain echoes before our own flush resolves).
        const optimisticId =
          typeof event.optimisticMessageId === 'string' ? event.optimisticMessageId : null;
        if (optimisticId !== null) this.outbox.remove(optimisticId);
      }
      return;
    }
    if (channel === RELAY_CONTROL.peerDisconnected) {
      const payload = args[0] as PeerDisconnectedPayload | undefined;
      if (payload?.type === 'peer_disconnected') {
        this.snapshot().setMacOffline(true);
        this.syncLivenessProbe();
      }
      return;
    }
    if (channel === RELAY_CONTROL.deliveryFailed) {
      const payload = args[0] as DeliveryFailedPayload | undefined;
      if (payload?.type !== 'delivery_failed') return;
      // Metadata-only receipt (relay envelope.ts: no correlation id). The only
      // envelopes that can die at the relay are this session's IN-FLIGHT relay
      // sends, so attribute to the oldest of those whose turn is still open —
      // never blind-FIFO over the outbox, which would mis-fail newer staged
      // messages that never touched the wire (and remove them from the auto-
      // flush queue). No in-flight candidate → nothing to attribute; locally
      // staged bodies are covered by the 5-minute TTL sweep instead.
      const targetKey = this.pendingRelaySends.find((key) => {
        const turn = this.snapshot().entries.find((candidate) => candidate.id === key)?.turn;
        return turn !== undefined && turn.state !== 'done' && turn.state !== 'failed';
      });
      if (targetKey === undefined) return;
      const index = this.pendingRelaySends.indexOf(targetKey);
      if (index >= 0) this.pendingRelaySends.splice(index, 1);
      this.failDelivery(targetKey, deliveryFailureCopy(payload.reason));
    }
  }

  // -- Mac liveness probe ------------------------------------------------------
  //
  // relay:peerDisconnected latches macOffline while the phone↔relay transport
  // stays online-relay, and the relay sends NO reconnect notice (verified
  // against packages/relay/src/server.ts — receipts only announce disconnects).
  // Left alone, the staging banner and the staged queue would never clear when
  // the Mac silently rejoins. While in that state, poll a read-only RPC: the
  // first answered probe proves the Mac is reachable → lift macOffline and
  // flush. Probes carry no message bodies, so one queued at the relay during
  // the outage is harmless (answered on reconnect; queue cap 200 » probe rate).

  private syncLivenessProbe(): void {
    const needed =
      this.detachFns.length > 0 &&
      this.snapshot().macOffline &&
      isOnline(this.manager.status);
    if (needed) {
      if (this.probeTimer === null && !this.probeInFlight) {
        this.probeTimer = this.timers.set(() => void this.probeMacLiveness(), this.probeIntervalMs);
      }
      return;
    }
    this.clearProbeTimer();
  }

  private clearProbeTimer(): void {
    if (this.probeTimer !== null) {
      this.timers.clear(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private async probeMacLiveness(): Promise<void> {
    this.probeTimer = null;
    if (this.detachFns.length === 0 || this.probeInFlight) return;
    if (!this.snapshot().macOffline || !isOnline(this.manager.status)) {
      this.syncLivenessProbe();
      return;
    }
    this.probeInFlight = true;
    try {
      await this.manager.invoke(SESSION_RPC.GET_WORKSPACES);
      // Answered — the Mac is back.
      if (this.snapshot().macOffline) {
        this.snapshot().setMacOffline(false);
        void this.flush();
      }
    } catch {
      // Still unreachable (or the probe was queued at the relay) — re-arm.
    } finally {
      this.probeInFlight = false;
    }
    this.syncLivenessProbe();
  }
}

// ---------------------------------------------------------------------------
// App-wide singleton + wiring entry points
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isOnline(status: ConnStatus): boolean {
  return status === 'online-lan' || status === 'online-relay';
}

function channelLabelOf(status: ConnStatus): string {
  return status === 'online-lan' ? 'Wi-Fi 直连' : '云中转';
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '发送失败，请重试';
}

/** App controller over the real POL-242 connection manager. */
export const sessionController = new SessionController({
  manager: connectionManagerRef(),
});

function connectionManagerRef(): ConnectionManager {
  // Lazy require keeps the test module graph free of the real channel chain
  // (tests construct SessionController with fakes; the app uses the singleton).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { connectionManager } = require('../conn/ConnectionManager') as typeof import('../conn/ConnectionManager');
  return connectionManager;
}

let wired = false;

/** Idempotent app entry point — call on session-screen mount / tab focus. */
export function ensureSessionWiring(): void {
  if (process.env.EXPO_PUBLIC_PREVIEW_MODE === '1') return; // 视觉验收夹具：不接真实连接
  if (wired) return;
  sessionController.attach();
  wired = true;
}
