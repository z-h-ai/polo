// Session store (POL-243 card step 1) — the phone's single-session message
// state layer on zustand.
//
// Scope: one bound Mac = one session (M1 MVP). The store owns:
//   - the chat entries (user bubbles + assistant bubbles) and, per user
//     message, the event-card state machine queued/sent/delivered/running/
//     done/failed (card: 失败含原因与时间戳);
//   - local echo: a sent message appears immediately as `sent`; every LATER
//     transition is driven ONLY by the wire — the send-message RPC ack
//     (delivered) and the session:event push stream (running/done/failed).
//     No local guessing (card: 后续状态只由事件回推驱动);
//   - connection surface for P05: the four ConnectionManager steady states,
//     the Mac-offline flag (relay:peerDisconnected) and the auth fatal
//     (绑定已解除 安全态);
//   - replay dedup: events may arrive twice (WsRpc replay path); a seq-guard
//     plus idempotent turn-keyed text merges keep the list stable.
//
// Event mapping (real event names, packages/shared/src/protocol/dto.ts:171):
//   sessions:sendMessage ack {accepted,messageId} → delivered (rpc layer)
//   user_message(accepted|queued)                 → bind turnId, delivered
//   user_message(processing)                      → running
//   text_delta / text_complete                    → running + assistant text
//   tool_start / tool_result / status / info /
//   task_progress                                 → running (activity proof)
//   complete                                      → done (用时 N 秒)
//   error / typed_error / interrupted             → failed (执行失败, R2 收口)
// Terminal states (done/failed) are never overwritten.

import { create } from 'zustand';
import type { ConnStatus, FatalInfo } from '../conn/ConnectionManager';
import type { SessionEvent } from '../../types/shared-protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Event-card state machine (card step 1). */
export type TurnState = 'queued' | 'sent' | 'delivered' | 'running' | 'done' | 'failed';

/**
 * Why a message failed:
 *   send — never reached the Mac (offline timeout / relay delivery receipt)
 *   exec — the Mac got it but Polo AI errored (事件流失败终态)
 */
export type FailureKind = 'send' | 'exec';

export interface TurnInfo {
  state: TurnState;
  sentAtMs: number;
  /** Local staging timestamp while queued (outbox). */
  queuedAtMs?: number;
  /** Local 5-minute fallback deadline while queued (PRD §⑥ R3). */
  expireAtMs?: number;
  deliveredAtMs?: number;
  /** P05 已送达 detail: 'Wi-Fi 直连' | '云中转' | 'LAN'. */
  channelLabel?: string;
  runningAtMs?: number;
  finishedAtMs?: number;
  durationSeconds?: number;
  failedAtMs?: number;
  failureKind?: FailureKind;
  errorText?: string;
}

export interface ChatEntry {
  /** User turns: the optimistic id we sent with sendMessage.options. */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  atMs: number;
  /** User turns only — the event card. Assistant turns leave it undefined. */
  turn?: TurnInfo;
}

export interface SessionViewState {
  sessionId: string | null;
  workspaceId: string | null;
  entries: ChatEntry[];
  /** Server turnId → local user entry id (bound via user_message/ack). */
  boundTurnIds: Record<string, string>;
  connStatus: ConnStatus;
  /** relay:peerDisconnected seen while transport is up — staging semantics. */
  macOffline: boolean;
  /** Auth-class fatal (绑定已解除 安全态) — input disabled until re-pair. */
  fatal: FatalInfo | null;
  /** Highest applied event seq (replay dedup guard). */
  lastEventSeq: number;
}

export interface SessionActions {
  sessionOpened(sessionId: string, workspaceId: string | null): void;
  resetSession(): void;
  appendUserEntry(input: { id: string; text: string; atMs: number }): void;
  markQueued(input: { id: string; queuedAtMs: number; expireAtMs: number }): void;
  /** Resend restarts the machine (card: 重发复用原消息体并重新计时). */
  resetTurnToSent(input: { id: string; sentAtMs: number }): void;
  markDelivered(input: { id: string; atMs: number; channelLabel?: string }): void;
  markRunning(input: { id: string; atMs: number }): void;
  markDone(input: { id: string; atMs: number }): void;
  markFailed(input: { id: string; atMs: number; kind: FailureKind; errorText?: string }): void;
  applySessionEvent(event: SessionEvent, seq?: number, nowMs?: number): void;
  setConnStatus(status: ConnStatus): void;
  setMacOffline(offline: boolean): void;
  setFatal(info: FatalInfo | null): void;
}

export type SessionStore = SessionViewState & SessionActions;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const TERMINAL: ReadonlySet<TurnState> = new Set(['done', 'failed']);

function patchTurn(
  entries: ChatEntry[],
  id: string,
  patch: (turn: TurnInfo) => TurnInfo | null,
): ChatEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.id !== id || !entry.turn) return entry;
    const updated = patch(entry.turn);
    if (!updated) return entry;
    changed = true;
    return { ...entry, turn: updated };
  });
  return changed ? next : entries;
}

function turnOf(entries: ChatEntry[], id: string): TurnInfo | null {
  return entries.find((entry) => entry.id === id)?.turn ?? null;
}

/** Oldest user turn that can still receive wire progress.
 *
 * Oldest-first: the Mac executes staged messages in order, so while one turn
 * is still running, a newly echoed local bubble must not steal its events.
 * Queued (offline-staged) turns are excluded — the wire cannot be talking
 * about a message the Mac has not received yet. */
function activeTurnId(entries: ChatEntry[]): string | null {
  for (const entry of entries) {
    if (
      entry.role === 'user' &&
      entry.turn &&
      entry.turn.state !== 'queued' &&
      !TERMINAL.has(entry.turn.state)
    ) {
      return entry.id;
    }
  }
  return null;
}

function startRunning(turn: TurnInfo, atMs: number): TurnInfo {
  if (TERMINAL.has(turn.state) || turn.state === 'queued') return turn;
  if (turn.state === 'running') return turn;
  return { ...turn, state: 'running', runningAtMs: turn.runningAtMs ?? atMs };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessionId: null,
  workspaceId: null,
  entries: [],
  boundTurnIds: {},
  connStatus: 'offline',
  macOffline: false,
  fatal: null,
  lastEventSeq: 0,

  sessionOpened(sessionId, workspaceId) {
    set({ sessionId, ...(workspaceId !== null ? { workspaceId } : {}) });
  },

  resetSession() {
    set({
      sessionId: null,
      workspaceId: null,
      entries: [],
      boundTurnIds: {},
      macOffline: false,
      lastEventSeq: 0,
    });
  },

  appendUserEntry({ id, text, atMs }) {
    const entry: ChatEntry = {
      id,
      role: 'user',
      text,
      atMs,
      turn: { state: 'sent', sentAtMs: atMs },
    };
    set({ entries: [...get().entries, entry] });
  },

  markQueued({ id, queuedAtMs, expireAtMs }) {
    set({
      entries: patchTurn(get().entries, id, (turn) =>
        turn.state === 'sent' ? { ...turn, state: 'queued', queuedAtMs, expireAtMs } : null,
      ),
    });
  },

  resetTurnToSent({ id, sentAtMs }) {
    set({
      entries: patchTurn(get().entries, id, (turn) => ({
        ...turn,
        state: 'sent',
        sentAtMs,
        queuedAtMs: undefined,
        expireAtMs: undefined,
        deliveredAtMs: undefined,
        channelLabel: undefined,
        runningAtMs: undefined,
        finishedAtMs: undefined,
        durationSeconds: undefined,
        failedAtMs: undefined,
        failureKind: undefined,
        errorText: undefined,
      })),
    });
  },

  markDelivered({ id, atMs, channelLabel }) {
    set({
      entries: patchTurn(get().entries, id, (turn) =>
        turn.state === 'sent' || turn.state === 'queued'
          ? {
              ...turn,
              state: 'delivered',
              deliveredAtMs: turn.deliveredAtMs ?? atMs,
              ...(channelLabel !== undefined ? { channelLabel } : {}),
              queuedAtMs: undefined,
              expireAtMs: undefined,
            }
          : null,
      ),
    });
  },

  markRunning({ id, atMs }) {
    set({ entries: patchTurn(get().entries, id, (turn) => startRunning(turn, atMs)) });
  },

  markDone({ id, atMs }) {
    set({
      entries: patchTurn(get().entries, id, (turn) => {
        if (TERMINAL.has(turn.state) || turn.state === 'queued') return null;
        const baseMs = turn.runningAtMs ?? turn.deliveredAtMs ?? turn.sentAtMs;
        const durationSeconds = Math.max(0, Math.round((atMs - baseMs) / 1000));
        return { ...turn, state: 'done', finishedAtMs: atMs, durationSeconds };
      }),
    });
  },

  markFailed({ id, atMs, kind, errorText }) {
    set({
      entries: patchTurn(get().entries, id, (turn) => {
        if (TERMINAL.has(turn.state)) return null;
        return {
          ...turn,
          state: 'failed',
          failedAtMs: atMs,
          failureKind: kind,
          ...(errorText !== undefined ? { errorText } : {}),
        };
      }),
    });
  },

  applySessionEvent(event, seq, nowMs) {
    const state = get();
    // Session scoping: ignore events for other sessions (workspace broadcast).
    if (state.sessionId && event.sessionId && event.sessionId !== state.sessionId) return;
    // Replay dedup (card test: 同一事件 seq 重复不重复渲染).
    if (typeof seq === 'number') {
      if (seq <= state.lastEventSeq) return;
      set({ lastEventSeq: seq });
    }
    const atMs = nowMs ?? Date.now();
    const entries = get().entries;

    // Resolve the target user turn: server turnId binding → active turn.
    const eventTurnId =
      'turnId' in event && typeof event.turnId === 'string' ? event.turnId : null;
    const boundId = eventTurnId !== null ? state.boundTurnIds[eventTurnId] : undefined;
    const targetId = boundId ?? activeTurnId(entries);
    const bindTurn = (): Record<string, string> => {
      if (eventTurnId === null || targetId === null || boundId) return get().boundTurnIds;
      return { ...get().boundTurnIds, [eventTurnId]: targetId };
    };

    switch (event.type) {
      case 'user_message': {
        // Server echo of our own message — bind ids and confirm delivery.
        // queued 也收口：Mac 回显即证明消息已达（relay 离线队列竞态下，副本
        // 可能先于本机 flush 被 Mac 收到），暂存卡应翻转为已送达。
        const optimisticId =
          typeof event.optimisticMessageId === 'string' ? event.optimisticMessageId : null;
        if (optimisticId === null) return;
        const turn = turnOf(entries, optimisticId);
        if (!turn) return; // not our optimistic entry (history echo) — ignore
        if (turn.state === 'sent' || turn.state === 'queued') {
          get().markDelivered({ id: optimisticId, atMs });
        }
        if (event.status === 'processing') {
          get().markRunning({ id: optimisticId, atMs });
        }
        return;
      }
      case 'text_delta':
      case 'text_complete': {
        if (targetId === null) return;
        get().markRunning({ id: targetId, atMs });
        set({ boundTurnIds: bindTurn() });
        appendAssistantText(set, get, {
          key: eventTurnId !== null ? `assistant:${eventTurnId}` : `assistant:${targetId}`,
          text: event.type === 'text_delta' ? event.delta : event.text,
          complete: event.type === 'text_complete',
          atMs,
        });
        return;
      }
      case 'tool_start':
      case 'tool_result':
      case 'status':
      case 'task_progress':
      case 'info': {
        if (targetId === null) return;
        get().markRunning({ id: targetId, atMs });
        set({ boundTurnIds: bindTurn() });
        return;
      }
      case 'complete': {
        // 完成收口: prefer the still-active latest turn, else the bound one.
        const doneId = activeTurnId(get().entries) ?? targetId;
        if (doneId === null) return;
        get().markDone({ id: doneId, atMs });
        return;
      }
      case 'error': {
        const failedId = targetId ?? activeTurnId(get().entries);
        if (failedId === null) return;
        get().markFailed({ id: failedId, atMs, kind: 'exec', errorText: event.error });
        return;
      }
      case 'typed_error': {
        const failedId = targetId ?? activeTurnId(get().entries);
        if (failedId === null) return;
        get().markFailed({
          id: failedId,
          atMs,
          kind: 'exec',
          errorText: event.error.message || event.error.title,
        });
        return;
      }
      case 'interrupted': {
        // R2: 事件流含失败终态，不滞留「执行中」— interruption closes as failed.
        // dto.ts carries `message` as a full Message OBJECT (SessionManager
        // pushes one) — never interpolate it into display text.
        const failedId = targetId ?? activeTurnId(get().entries);
        if (failedId === null) return;
        get().markFailed({
          id: failedId,
          atMs,
          kind: 'exec',
          errorText: '执行已中断',
        });
        return;
      }
      default:
        return; // title_generated / permission_* / … — not on the phone MVP
    }
  },

  setConnStatus(status) {
    set({ connStatus: status });
  },

  setMacOffline(offline) {
    set({ macOffline: offline });
  },

  setFatal(info) {
    set({ fatal: info });
  },
}));

// ---------------------------------------------------------------------------
// Assistant text merge (delta accumulate / complete replace — idempotent)
// ---------------------------------------------------------------------------

function appendAssistantText(
  set: (partial: Partial<SessionStore>) => void,
  get: () => SessionStore,
  input: { key: string; text: string; complete: boolean; atMs: number },
): void {
  const entries = get().entries;
  const existing = entries.find((entry) => entry.id === input.key);
  if (existing) {
    const text = input.complete ? input.text : existing.text + input.text;
    if (text === existing.text) return; // replayed complete — no-op (去重合并)
    set({
      entries: entries.map((entry) =>
        entry.id === input.key ? { ...entry, text } : entry,
      ),
    });
    return;
  }
  const entry: ChatEntry = {
    id: input.key,
    role: 'assistant',
    text: input.text,
    atMs: input.atMs,
  };
  set({ entries: [...entries, entry] });
}

// ---------------------------------------------------------------------------
// Read helpers (pure — used by the tab card and tests)
// ---------------------------------------------------------------------------

export function lastUserEntry(state: Pick<SessionViewState, 'entries'>): ChatEntry | null {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry && entry.role === 'user') return entry;
  }
  return null;
}

export function hasStagedMessages(state: Pick<SessionViewState, 'entries'>): boolean {
  return state.entries.some((entry) => entry.turn?.state === 'queued');
}
