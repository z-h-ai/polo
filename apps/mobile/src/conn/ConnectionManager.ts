// ConnectionManager (POL-242 card step 3) — the phone's dual-channel conn core.
//
// Channels (src/conn/lanChannel.ts, src/conn/relayChannel.ts) each expose one
// WsRpc-speaking connection. The manager owns POLICY on top of them:
//
//   Channel selection — LAN direct first, cloud relay as fallback:
//     - when a target with a wsUrl exists (and the 60s probe window allows),
//       a LAN connect is attempted first (5s handshake probe);
//     - LAN unreachable → relay (wss://relay, EXPO_PUBLIC_RELAY_URL);
//     - while ONLINE over relay, a low-frequency timer (60s) re-probes LAN and
//       migrates back on success; while ONLINE over LAN, relay is never dialed;
//     - STICKINESS (card: 探测窗口 60s 内不反复切换): every LAN attempt —
//       success or failure — closes the window for probeWindowMs, so channels
//       cannot flip-flop; the in-background relay socket is kept warm so a LAN
//       loss falls back to relay with zero extra handshake.
//
//   Status surface — four steady states aligned with the P05 status bar:
//     online-lan      已连接 · Wi-Fi 直连
//     online-relay    已连接 · 经云中转
//     reconnecting    正在重连…（经云中转）
//     offline         离线
//     Status events fire only on NEW steady states; transient flaps inside
//     stateDebounceMs are collapsed (card step 3 去抖). A Mac that dropped off
//     the relay surfaces as the `relay:peerDisconnected` event — the manager
//     keeps online-relay (the phone↔relay transport is healthy) so the message
//     layer can enter its staging semantics (M1-11), per the card's "Mac 离线
//     时对外稳定呈现" requirement (no error flapping).
//
//   In-flight request migration — requests never silently drop: channel
//     switches and losses REJECT pending invokes (fast-fail, upper layer
//     retries; the WsRpc replay path re-delivers missed events).
//
//   Auth failures (close 4005 / 4401 / 4403, AUTH_FAILED) never retry:
//     status → offline and a fatal callback fires so the UI can re-prompt
//     login/pairing (card step 4).
//
//   All probe/reconnect timers pause when the app backgrounds (pause()) and a
//     fresh probe cycle fires immediately on foreground (resume()).
//
// The heavier design notes live with the card; internal machine states map to
// the card's idle/lan_connecting/lan/relay/reconnecting/offline as:
// idle→(no target/token), lan_connecting→probe in flight, lan/relay→active,
// reconnecting→retry scheduled, offline→nothing reachable / auth-blocked.

import type { ChannelKind, ChannelState, ConnChannel } from './lanChannel';
import { createLanChannel } from './lanChannel';
import { createRelayChannel, resolveRelayUrl } from './relayChannel';
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
  classifyClose,
  computeBackoffDelayMs,
} from './reconnect';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The four steady states consumed by the P05 status bar / M1-12 device card. */
export type ConnStatus = 'online-lan' | 'online-relay' | 'reconnecting' | 'offline';

/** P05 connbar copy (已连接·Wi-Fi 直连 / 已连接·经云中转 / 正在重连…（经云中转）/ 离线). */
export const STATUS_LABELS: Readonly<Record<ConnStatus, string>> = {
  'online-lan': '已连接 · Wi-Fi 直连',
  'online-relay': '已连接 · 经云中转',
  reconnecting: '正在重连…（经云中转）',
  offline: '离线',
};

export function statusLabel(status: ConnStatus): string {
  return STATUS_LABELS[status];
}

/** The selected Mac + this phone's identity. Single-device MVP. */
export interface ConnectionTarget {
  /** This phone's admin device row id (relay persona `phone:<id>`). */
  phoneDeviceId: string;
  /** Selected Mac's admin device id (relay persona `mac:<id>`). */
  macDeviceId: string;
  /** LAN hint from the pairing QR — null when the QR carried the bare code. */
  wsUrl: string | null;
}

/**
 * Holds the connection target chosen at pairing/selection time.
 *
 * POL-241 NOTE (dependency to close at integration): the admin DeviceView wire
 * (POL-241 devices.ts) carries `macDeviceId` but NOT the QR's wsUrl, and no
 * on-phone binding storage exists yet — the pairing flow only passes the
 * scanned wsUrl through the confirm screen. Until a follow-up feeds both,
 * the app layer (POL-243/POL-244 wiring) must call `connectionTarget.set()`
 * with { phoneDeviceId, macDeviceId } from devicesApi.list() and the wsUrl
 * captured at scan time. Without a wsUrl the manager runs relay-only.
 */
export class ConnectionTargetHolder {
  private target: ConnectionTarget | null = null;

  set(target: ConnectionTarget): void {
    this.target = { ...target };
  }

  get(): ConnectionTarget | null {
    return this.target ? { ...this.target } : null;
  }

  clear(): void {
    this.target = null;
  }
}

export interface StatusInfo {
  status: ConnStatus;
  label: string;
  /** Failed reconnect cycles since the last successful connect. */
  attempt: number;
  /** Last failure detail (error message / close reason), when any. */
  detail?: string;
}

export interface FatalInfo {
  reason: 'auth';
  channel: ChannelKind;
  detail?: string;
}

export type ConnTimerHandle = unknown;

export interface ConnTimers {
  set: (fn: () => void, ms: number) => ConnTimerHandle
  clear: (handle: ConnTimerHandle) => void
}

export interface ConnectionManagerOptions {
  /** Connection target source. Default: the app-wide holder below. */
  target?: () => ConnectionTarget | null;
  /** Admin JWT source. Default: the session store (lazy — avoids a cycle). */
  token?: () => string | null;
  /** Relay endpoint source. Default: EXPO_PUBLIC_RELAY_URL (may be ''). */
  relayUrl?: () => string;
  /** LAN handshake probe budget. Default 5000ms. */
  lanProbeTimeoutMs?: number;
  /** Sticky window after any LAN attempt/success. Default 60_000ms. */
  probeWindowMs?: number;
  /** Background LAN re-probe cadence while on relay. Default 60_000ms. */
  lanReprobeIntervalMs?: number;
  /** Anti-flap debounce for status emissions. Default 800ms. */
  stateDebounceMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
  now?: () => number;
  timers?: ConnTimers;
  createLanChannel?: (args: { wsUrl: string; token: string; connectTimeoutMs: number }) => ConnChannel;
  createRelayChannel?: (args: {
    relayUrl: string;
    phoneDeviceId: string;
    macDeviceId: string;
    token: string;
    connectTimeoutMs: number;
  }) => ConnChannel;
}

const DEFAULT_PROBE_WINDOW_MS = 60_000;
const DEFAULT_LAN_REPROBE_INTERVAL_MS = 60_000;
const DEFAULT_STATE_DEBOUNCE_MS = 800;
const DEFAULT_LAN_PROBE_TIMEOUT_MS = 5_000;

function defaultTimers(): ConnTimers {
  return {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function defaultToken(): string | null {
  try {
    // Lazy require keeps the session store (zustand + expo-secure-store chain)
    // out of the conn layer's test module graph; the app is always logged in
    // before any connect cycle matters (AuthGate gates the UI).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useSessionStore } = require('../auth/session') as typeof import('../auth/session');
    return useSessionStore.getState().token;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class ConnectionManager {
  private readonly opts: Required<
    Pick<ConnectionManagerOptions, 'lanProbeTimeoutMs' | 'probeWindowMs' | 'lanReprobeIntervalMs' | 'stateDebounceMs' | 'backoffBaseMs' | 'backoffMaxMs'>
  > & ConnectionManagerOptions;
  private readonly targetFn: () => ConnectionTarget | null;
  private readonly tokenFn: () => string | null;
  private readonly relayUrlFn: () => string;
  private readonly timers: ConnTimers;
  private readonly now: () => number;

  private started = false;
  private paused = false;
  /** Set by an auth failure; only start()/resume() clear it (never retry auth). */
  private authBlocked = false;
  private cycling = false;
  private rerunCycle = false;
  private attempt = 0;
  private nextLanProbeAllowedAt = 0;
  private detail: string | undefined;

  private active: { channel: ConnChannel; kind: ChannelKind } | null = null;
  private lanChannel: ConnChannel | null = null;
  private lanKey: string | null = null;
  private relayChannel: ConnChannel | null = null;
  private relayKey: string | null = null;

  private emittedStatus: ConnStatus = 'offline';
  private pendingStatus: ConnStatus = 'offline';
  private statusTimer: ConnTimerHandle | null = null;
  private cycleTimers = new Set<ConnTimerHandle>();

  private readonly statusListeners = new Set<(info: StatusInfo) => void>();
  private readonly fatalListeners = new Set<(info: FatalInfo) => void>();
  private readonly eventListeners = new Set<(channel: string, args: unknown[]) => void>();

  constructor(options: ConnectionManagerOptions = {}) {
    this.opts = {
      lanProbeTimeoutMs: options.lanProbeTimeoutMs ?? DEFAULT_LAN_PROBE_TIMEOUT_MS,
      probeWindowMs: options.probeWindowMs ?? DEFAULT_PROBE_WINDOW_MS,
      lanReprobeIntervalMs: options.lanReprobeIntervalMs ?? DEFAULT_LAN_REPROBE_INTERVAL_MS,
      stateDebounceMs: options.stateDebounceMs ?? DEFAULT_STATE_DEBOUNCE_MS,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      backoffMaxMs: options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
      ...options,
    };
    this.targetFn = options.target ?? (() => connectionTarget.get());
    this.tokenFn = options.token ?? defaultToken;
    this.relayUrlFn = options.relayUrl ?? (() => resolveRelayUrl());
    this.timers = options.timers ?? defaultTimers();
    this.now = options.now ?? Date.now;
  }

  // -- lifecycle -------------------------------------------------------------

  /** Starts (or re-kicks) the connect loop. Idempotent-friendly. */
  start(): void {
    this.started = true;
    this.paused = false;
    this.authBlocked = false;
    this.pendingStatus = this.emittedStatus;
    void this.requestCycle();
  }

  /** Tears everything down (sign-out, target revoked). */
  stop(): void {
    this.started = false;
    this.paused = false;
    this.authBlocked = false;
    this.cycling = false;
    this.rerunCycle = false;
    this.attempt = 0;
    this.nextLanProbeAllowedAt = 0;
    this.clearCycleTimers();
    this.clearStatusTimer();
    this.active = null;
    this.lanChannel?.destroy();
    this.lanChannel = null;
    this.lanKey = null;
    this.relayChannel?.destroy();
    this.relayChannel = null;
    this.relayKey = null;
    this.pendingStatus = 'offline';
    this.setStatusNow('offline');
  }

  /** App backgrounded — every probe/reconnect timer stops (card: 避免后台空耗电). */
  pause(): void {
    if (!this.started || this.paused) return;
    this.paused = true;
    this.clearCycleTimers();
    // Collapse any in-flight debounce so resume() re-derives the status.
    this.pendingStatus = this.emittedStatus;
    this.clearStatusTimer();
  }

  /** App foregrounded — immediately runs one fresh probe cycle (card). */
  resume(): void {
    if (!this.started || !this.paused) return;
    this.paused = false;
    this.authBlocked = false;
    this.attempt = 0;
    this.nextLanProbeAllowedAt = 0;
    this.pendingStatus = this.emittedStatus;
    void this.requestCycle();
  }

  // -- subscriptions ----------------------------------------------------------

  get status(): ConnStatus {
    return this.emittedStatus;
  }

  get failedAttempts(): number {
    return this.attempt;
  }

  onStatus(cb: (info: StatusInfo) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.statusInfo());
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  /** Auth-class failures (4005/4401/4403/AUTH_FAILED) — re-login/re-pair. */
  onFatal(cb: (info: FatalInfo) => void): () => void {
    this.fatalListeners.add(cb);
    return () => {
      this.fatalListeners.delete(cb);
    };
  }

  /** Unified event stream (live + replayed WsRpc events, relay control receipts). */
  on(cb: (channel: string, args: unknown[]) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }

  /** WsRpc request over whichever channel is active. Rejects offline. */
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const active = this.active;
    if (!active) {
      return Promise.reject(new Error(`Not connected (status: ${this.emittedStatus}, channel: ${channel})`));
    }
    return active.channel.invoke(channel, ...args);
  }

  // -- connect cycle ----------------------------------------------------------

  private get inactive(): boolean {
    return !this.started || this.paused;
  }

  private async requestCycle(): Promise<void> {
    if (this.inactive || this.authBlocked) return;
    if (this.cycling) {
      this.rerunCycle = true;
      return;
    }
    this.cycling = true;
    try {
      await this.runCycle();
    } finally {
      this.cycling = false;
    }
    if (this.rerunCycle && !this.inactive) {
      this.rerunCycle = false;
      await this.requestCycle();
    }
  }

  private async runCycle(): Promise<void> {
    this.clearCycleTimers();
    const target = this.targetFn();
    const token = this.tokenFn();
    const relayUrl = this.relayUrlFn();

    if (!target || !token) {
      // Nothing to connect to yet (not logged in / no selected device).
      this.detail = undefined;
      this.setRaw('offline');
      return;
    }

    if (!this.active) {
      // True cold/reconnect phase — announce it (the debounce swallows this
      // when a channel lands quickly, so the status bar never flickers).
      this.setRaw('reconnecting');
    }

    // 1) LAN direct first — gated by the sticky probe window.
    if (target.wsUrl && this.now() >= this.nextLanProbeAllowedAt) {
      const lan = this.ensureLanChannel(target, token);
      const outcome = await this.tryChannel(lan, 'lan');
      if (outcome === 'online') return;
      if (this.inactive) return;
      if (outcome === 'auth') {
        this.handleAuthFatal('lan');
        return;
      }
      // Probe failed: keep the sticky window before the next LAN attempt.
      this.nextLanProbeAllowedAt = this.now() + this.opts.probeWindowMs;
      if (this.active?.kind === 'relay') {
        // A re-probe failure must NOT flip the steady status (anti-flap).
        this.scheduleLanReprobe();
        return;
      }
    }

    // 2) Cloud relay fallback.
    if (relayUrl && target.phoneDeviceId && target.macDeviceId) {
      const relay = this.ensureRelayChannel(target, token, relayUrl);
      const outcome = await this.tryChannel(relay, 'relay');
      if (outcome === 'online') return;
      if (this.inactive) return;
      if (outcome === 'auth') {
        this.handleAuthFatal('relay');
        return;
      }
    }

    // 3) Nothing reachable — steady "reconnecting", retry on exponential backoff.
    this.scheduleRetryCycle();
  }

  private scheduleRetryCycle(): void {
    if (this.inactive) return; // pause()/stop() won the race with a state event
    const delay = computeBackoffDelayMs(this.attempt, {
      baseMs: this.opts.backoffBaseMs,
      maxMs: this.opts.backoffMaxMs,
      random: this.opts.random,
    });
    this.detail = '所有通道不可达';
    this.setRaw('reconnecting');
    this.scheduleCycleTimer(() => void this.requestCycle(), delay);
    this.attempt += 1;
  }

  /** One channel connect attempt. Online → activates and reports. */
  private async tryChannel(channel: ConnChannel, kind: ChannelKind): Promise<'online' | 'auth' | 'failed'> {
    try {
      await channel.connect();
    } catch (err) {
      const thrown = err as { closeCode?: number; errorKind?: string; message?: string };
      const classification = classifyClose(thrown?.closeCode, thrown?.errorKind);
      this.detail = thrown?.message ?? this.detail;
      return classification === 'auth' ? 'auth' : 'failed';
    }
    if (this.inactive) return 'failed';
    this.attempt = 0;
    this.detail = undefined;
    this.activate(channel, kind);
    return 'online';
  }

  private activate(channel: ConnChannel, kind: ChannelKind): void {
    this.active = { channel, kind };
    if (kind === 'lan') {
      // Sticky: once on LAN, keep the window closed so nothing flip-flops.
      this.nextLanProbeAllowedAt = this.now() + this.opts.probeWindowMs;
      this.setRaw('online-lan');
    } else {
      this.setRaw('online-relay');
      this.scheduleLanReprobe();
    }
  }

  /** Active-channel loss handler (wired per cached channel). */
  private onChannelState(channel: ConnChannel, state: ChannelState): void {
    if (this.inactive) return; // paused/stopped — resume() re-derives everything
    if (this.active?.channel !== channel) return; // probe/background channel
    if (state.phase !== 'offline') return; // online/connecting handled by the cycle

    this.active = null;
    this.detail = state.errorMessage ?? state.reason ?? this.detail;
    if (classifyClose(state.closeCode, state.errorKind) === 'auth') {
      this.handleAuthFatal(channel.kind);
      return;
    }
    // Fresh backoff sequence for a fresh loss (first retry = base).
    this.attempt = 0;
    this.scheduleRetryCycle();
  }

  private handleAuthFatal(kind: ChannelKind): void {
    this.authBlocked = true;
    this.active = null;
    this.clearCycleTimers();
    this.detail = '认证已失效，请重新登录或重新配对';
    this.setRaw('offline');
    const info: FatalInfo = { reason: 'auth', channel: kind, detail: this.detail };
    for (const cb of this.fatalListeners) {
      try {
        cb(info);
      } catch {
        // Listener errors must not break the manager.
      }
    }
  }

  // -- channel cache (instances persist to preserve replay identity) ----------

  private wireChannel(channel: ConnChannel): void {
    channel.onState((state) => this.onChannelState(channel, state));
    channel.on((name, args) => {
      if (this.active?.channel !== channel) return; // route the active stream only
      for (const cb of this.eventListeners) {
        try {
          cb(name, args);
        } catch {
          // Listener errors must not break the manager.
        }
      }
    });
  }

  private ensureLanChannel(target: ConnectionTarget, token: string): ConnChannel {
    const key = `${target.wsUrl}|${token}`;
    if (this.lanChannel && this.lanKey === key) return this.lanChannel;
    this.lanChannel?.destroy();
    const channel = (this.opts.createLanChannel ?? defaultCreateLanChannel)({
      wsUrl: target.wsUrl as string,
      token,
      connectTimeoutMs: this.opts.lanProbeTimeoutMs,
    });
    this.lanChannel = channel;
    this.lanKey = key;
    this.wireChannel(channel);
    return channel;
  }

  private ensureRelayChannel(target: ConnectionTarget, token: string, relayUrl: string): ConnChannel {
    const key = `${relayUrl}|${target.phoneDeviceId}|${target.macDeviceId}|${token}`;
    if (this.relayChannel && this.relayKey === key) return this.relayChannel;
    this.relayChannel?.destroy();
    const channel = (this.opts.createRelayChannel ?? defaultCreateRelayChannel)({
      relayUrl,
      phoneDeviceId: target.phoneDeviceId,
      macDeviceId: target.macDeviceId,
      token,
      connectTimeoutMs: this.opts.lanProbeTimeoutMs,
    });
    this.relayChannel = channel;
    this.relayKey = key;
    this.wireChannel(channel);
    return channel;
  }

  // -- timers -----------------------------------------------------------------

  private scheduleLanReprobe(): void {
    this.scheduleCycleTimer(() => {
      if (this.inactive || this.authBlocked) return;
      if (this.active?.kind !== 'relay') return; // LAN already won
      void this.requestCycle();
    }, this.opts.lanReprobeIntervalMs);
  }

  private scheduleCycleTimer(fn: () => void, ms: number): void {
    const handle = this.timers.set(() => {
      this.cycleTimers.delete(handle);
      fn();
    }, ms);
    this.cycleTimers.add(handle);
  }

  private clearCycleTimers(): void {
    for (const handle of this.cycleTimers) this.timers.clear(handle);
    this.cycleTimers.clear();
  }

  // -- status emissions (debounced steady states) ------------------------------

  private statusInfo(): StatusInfo {
    return {
      status: this.emittedStatus,
      label: statusLabel(this.emittedStatus),
      attempt: this.attempt,
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }

  private setRaw(next: ConnStatus): void {
    if (this.pendingStatus === next) return; // debounce timer keeps running
    this.pendingStatus = next;
    this.clearStatusTimer();
    this.statusTimer = this.timers.set(() => {
      this.statusTimer = null;
      this.setStatusNow(this.pendingStatus);
    }, this.opts.stateDebounceMs);
  }

  private setStatusNow(status: ConnStatus): void {
    if (this.emittedStatus === status) return;
    this.emittedStatus = status;
    const info = this.statusInfo();
    for (const cb of this.statusListeners) {
      try {
        cb(info);
      } catch {
        // Listener errors must not break the manager.
      }
    }
  }

  private clearStatusTimer(): void {
    if (this.statusTimer !== null) {
      this.timers.clear(this.statusTimer);
      this.statusTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Default factories (lazy real-channel wiring; tests inject fakes)
// ---------------------------------------------------------------------------

function defaultCreateLanChannel(args: { wsUrl: string; token: string; connectTimeoutMs: number }): ConnChannel {
  return createLanChannel({
    wsUrl: args.wsUrl,
    token: args.token,
    connectTimeoutMs: args.connectTimeoutMs,
  });
}

function defaultCreateRelayChannel(args: {
  relayUrl: string;
  phoneDeviceId: string;
  macDeviceId: string;
  token: string;
  connectTimeoutMs: number;
}): ConnChannel {
  return createRelayChannel({
    relayUrl: args.relayUrl,
    phoneDeviceId: args.phoneDeviceId,
    macDeviceId: args.macDeviceId,
    token: args.token,
    connectTimeoutMs: args.connectTimeoutMs,
  });
}

// ---------------------------------------------------------------------------
// App-wide singletons (POL-243/POL-244 consume these)
// ---------------------------------------------------------------------------

/** Pairing/selection writes here (see ConnectionTargetHolder for the wsUrl gap). */
export const connectionTarget = new ConnectionTargetHolder();

/** App-wide conn manager on the default env/session wiring. */
export const connectionManager = new ConnectionManager({ target: () => connectionTarget.get() });
