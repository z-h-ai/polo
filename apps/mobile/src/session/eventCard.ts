// Event-card + banner copy mapping (POL-243) — pure, no React, no conn module
// graph. Every string the P05 session page renders derives here so the 文案
// mapping is unit-testable (card step 6).
//
// Visual contract (prototype P05):
//   已送达   绿✓  「已送达」            「14:20:03 · Wi-Fi 直连」
//   执行中   转圈  「执行中」            「Polo AI 正在电脑上处理」
//   完成     绿✓  「完成」              「用时 26 秒」
//   已暂存   时钟  「已暂存」            「等待 Mac 上线 · 剩余 4:12」
//   发送失败 红✕  「发送失败」          「电脑离线超过 5 分钟，消息未送达 · 14:26」 + 重新发送
//   执行失败 红✕  「执行失败」          「电脑上处理出错，本条未产生结果 · 14:22」 + 重新发送
//   安全态        connbar「绑定已解除」 + errbar「对方已撤销本设备的连接。…」

import type { FailureKind, TurnInfo, TurnState } from './sessionStore';

export type EventTone = 'success' | 'running' | 'info' | 'destructive';

export interface EventCardRow {
  key: string;
  tone: EventTone;
  title: string;
  detail: string;
  /** Failed turns render the 重新发送 action under the card (P05). */
  resend: boolean;
}

// -- banners / composer copy -------------------------------------------------

export const STAGING_BANNER =
  'Mac 离线：消息将暂存最多 5 分钟，对方上线后自动送达；超时未送达会明确标记失败。';
export const FATAL_STATUS_LABEL = '绑定已解除';
export const FATAL_BANNER = '对方已撤销本设备的连接。如需继续使用，请重新扫码配对。';
export const FATAL_COMPOSER_PLACEHOLDER = '绑定解除后不可发送';
export const INPUT_PLACEHOLDER = '输入消息…';
export const ATTACHMENT_TOAST = '图片和文件发送即将上线';
export const RESEND_LABEL = '重新发送';
/** Outbox cap (card step 2: 暂存条数上限与最旧淘汰策略). */
export const OUTBOX_CAP = 50;
export const OUTBOX_OVERFLOW_NOTE = '暂存队列已满，最早的消息已丢弃';

// -- formatters ----------------------------------------------------------------

/** 4:12 style m:ss countdown. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** HH:mm wall clock for failure timestamps (P05 uses 14:26 form). */
export function formatClock(atMs: number): string {
  const date = new Date(atMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** HH:mm:ss wall clock for the 已送达 row (P05 uses 14:20:03 form). */
export function formatClockSeconds(atMs: number): string {
  const date = new Date(atMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** 完成 detail — 用时 N 秒 (P05), plain 已完成 when unknown. */
export function formatDuration(durationSeconds: number | undefined): string {
  return durationSeconds !== undefined ? `用时 ${durationSeconds} 秒` : '已完成';
}

// -- per-state rows ---------------------------------------------------------

export function queuedRow(turn: TurnInfo, nowMs: number): EventCardRow {
  const expireAtMs = turn.expireAtMs ?? turn.queuedAtMs ?? nowMs;
  const remaining = Math.max(0, expireAtMs - nowMs);
  return {
    key: 'queued',
    tone: 'info',
    title: '已暂存',
    detail: `等待 Mac 上线 · 剩余 ${formatCountdown(remaining)}`,
    resend: false,
  };
}

export function sentRow(): EventCardRow {
  return { key: 'sent', tone: 'info', title: '发送中…', detail: '等待电脑确认', resend: false };
}

export function deliveredRow(turn: TurnInfo): EventCardRow {
  const at = turn.deliveredAtMs ?? turn.sentAtMs;
  const channel = turn.channelLabel ?? '';
  return {
    key: 'delivered',
    tone: 'success',
    title: '已送达',
    detail: channel ? `${formatClockSeconds(at)} · ${channel}` : formatClockSeconds(at),
    resend: false,
  };
}

export function runningRow(): EventCardRow {
  return {
    key: 'running',
    tone: 'running',
    title: '执行中',
    detail: 'Polo AI 正在电脑上处理',
    resend: false,
  };
}

export function doneRow(turn: TurnInfo): EventCardRow {
  return {
    key: 'done',
    tone: 'success',
    title: '完成',
    detail: formatDuration(turn.durationSeconds),
    resend: false,
  };
}

export function failedRow(turn: TurnInfo): EventCardRow {
  const at = turn.failedAtMs;
  const suffix = at !== undefined ? ` · ${formatClock(at)}` : '';
  if (turn.failureKind === 'send') {
    return {
      key: 'failed',
      tone: 'destructive',
      title: '发送失败',
      detail: `${turn.errorText ?? '电脑离线超过 5 分钟，消息未送达'}${suffix}`,
      resend: true,
    };
  }
  return {
    key: 'failed',
    tone: 'destructive',
    title: '执行失败',
    detail: `${turn.errorText ?? '电脑上处理出错，本条未产生结果'}${suffix}`,
    resend: true,
  };
}

/** Turn state → the event card row shown under the user bubble (P05). */
export function eventCardRow(turn: TurnInfo, nowMs: number): EventCardRow {
  switch (turn.state) {
    case 'queued':
      return queuedRow(turn, nowMs);
    case 'sent':
      return sentRow();
    case 'delivered':
      return deliveredRow(turn);
    case 'running':
      return runningRow();
    case 'done':
      return doneRow(turn);
    case 'failed':
      return failedRow(turn);
  }
}

/** The staging-semantic label for a failure reason from the relay receipt. */
export function deliveryFailureCopy(reason: string): string {
  switch (reason) {
    case 'mac_offline':
      return '电脑离线超过 5 分钟，消息未送达';
    case 'queue_full':
      return '云中转暂存队列已满，消息未送达';
    case 'not_allowed':
    case 'access_check_failed':
      return '电脑已拒绝本设备的连接，消息未送达';
    case 'phone_offline':
      return '连接中断，消息未送达';
    default:
      return '消息未送达';
  }
}

/** Whether this turn reached the Mac at all (drives failure kind semantics). */
export function failureKindForTurn(turn: TurnInfo): FailureKind {
  return turn.deliveredAtMs === undefined ? 'send' : 'exec';
}

/** M01 conversation-card summary (消息 Tab): last-line + task chip. */
export function conversationChipFor(turn: TurnInfo | undefined): string | null {
  if (!turn) return null;
  if (turn.state === 'done') return `任务已完成 · ${formatDuration(turn.durationSeconds)}`;
  if (turn.state === 'failed' && turn.failureKind === 'exec') return '任务执行失败';
  if (turn.state === 'failed') return '发送失败 · 可重发';
  if (turn.state === 'running') return 'Polo AI 正在电脑上处理';
  if (turn.state === 'queued') return '已暂存 · 等待 Mac 上线';
  return null;
}
