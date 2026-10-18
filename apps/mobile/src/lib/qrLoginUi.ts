// Pure mappers from qr-login wire states / api errors to UI states and copy
// (POL-15). Copy follows the PRD v1.6 定稿 (prototype P10/P11):
//   过期     -> 「二维码已过期」+ 请让电脑或网页端刷新二维码后重新扫码 + 一键重新扫码
//   非 Polo  -> 「这不是 Polo 登录二维码，请核对后再试」
//   failCount ≥ 5 -> 票据作废（admin 回 qr_login_attempts_exceeded），同过期弹层语义
// Every alert offers 重新扫码 + 返回 (P10 错误弹层收口在 QrScanScreen 语义).

import { ApiError, NetworkError } from '../api/client';
import type { QrRequesterView, QrScanRequesterView, QrTicketStatus } from '../api/qrLogin';

/** Confirm-page states derived from the ticket status machine. */
export type QrConfirmUiState =
  /** pending / scanned — the ticket is live and this phone may decide. */
  | 'ready'
  /** confirmed — already authorized (idempotent re-open shows this too). */
  | 'success'
  /** rejected — 「不是我，拒绝」 landed. */
  | 'rejected'
  | 'expired'
  /** consumed — the waiting device already exchanged the ticket. */
  | 'used';

export function statusToUiState(status: QrTicketStatus): QrConfirmUiState {
  switch (status) {
    case 'pending':
    case 'scanned':
      return 'ready';
    case 'confirmed':
      return 'success';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    case 'consumed':
      return 'used';
  }
}

export interface QrErrorAlertCopy {
  title: string;
  message: string;
}

export function qrInvalidPayloadCopy(): QrErrorAlertCopy {
  // P10 非 Polo 码文案（解析失败统一落此提示，含畸形/缺参）。
  return {
    title: '不是 Polo 登录二维码',
    message: '这不是 Polo 登录二维码，请核对后再试',
  };
}

/**
 * Copy for terminal ticket states observed while polling status (P11 falls
 * back to the P10 alert for these). Null for live states (pending/scanned/
 * confirmed) — those render the confirm/success UI, not an alert.
 */
export function ticketStatusAlertCopy(status: QrTicketStatus): QrErrorAlertCopy | null {
  switch (status) {
    case 'expired':
      return { title: '二维码已过期', message: '请让电脑或网页端刷新二维码后重新扫码' };
    case 'rejected':
      return { title: '二维码已失效', message: '该二维码已被拒绝，请让电脑或网页端刷新二维码后重新扫码' };
    case 'consumed':
      return { title: '二维码已使用', message: '该二维码已完成登录，请让电脑或网页端刷新二维码后重新扫码' };
    default:
      return null;
  }
}

/**
 * Maps any error thrown by the qr api to alert copy. Returns null only for
 * non-Error garbage (defensive); callers fall back to the generic copy then.
 */
export function qrErrorToAlertCopy(error: unknown): QrErrorAlertCopy {
  if (error instanceof NetworkError) {
    return { title: '网络连接失败', message: '网络不稳定，请检查网络后重试' };
  }
  if (!(error instanceof ApiError)) {
    return { title: '出错了', message: '操作未完成，请重试或重新扫码' };
  }

  switch (error.errorCode) {
    // admin: 票据过期（confirm 视角仍回 401，复用扫码端过期弹层语义）
    case 'qr_login_expired':
      return { title: '二维码已过期', message: '请让电脑或网页端刷新二维码后重新扫码' };
    // admin: failCount ≥ 5，票据已被作废
    case 'qr_login_attempts_exceeded':
      return {
        title: '二维码已作废',
        message: '失败次数过多，该二维码已作废。请让电脑或网页端刷新二维码后重新扫码',
      };
    // admin: qrId 不存在 / 票据不在可确认状态（404/409）
    case 'qr_login_invalid':
      return { title: '二维码无效', message: '请让电脑或网页端刷新二维码后重新扫码' };
    // admin: 票据已被「不是我，拒绝」（409）
    case 'qr_login_cancelled':
      return { title: '二维码已失效', message: '该二维码已被拒绝，请让电脑或网页端刷新二维码后重新扫码' };
    // admin: 票据已完成登录一次性消费（409）
    case 'qr_login_consumed':
      return { title: '二维码已使用', message: '该二维码已完成登录，请让电脑或网页端刷新二维码后重新扫码' };
    // admin: secret 不匹配（failCount 尚未达限，401）
    case 'invalid_credentials':
      return { title: '二维码校验失败', message: '请重新扫描电脑或网页端出示的二维码' };
    // admin: 同一票据已被其他账号确认（403）
    case 'forbidden':
      return { title: '无法授权', message: '该二维码已被其他账号确认，请让对方重新出示二维码' };
    // admin scan 端点：确认窗口已关闭（410）— 过期弹层语义
    case 'qr_confirm_window_expired':
      return { title: '二维码已过期', message: '请让电脑或网页端刷新二维码后重新扫码' };
    // admin scan 端点：票据不存在（404）— 与 qr_login_invalid 同弹层
    case 'not_found':
    case 'NOT_FOUND':
      return { title: '二维码无效', message: '请让电脑或网页端刷新二维码后重新扫码' };
    case 'rate_limited':
      return { title: '操作过于频繁', message: '请稍等片刻后再试' };
    case 'UNAUTHORIZED':
    case 'AUTH_EXPIRED':
    // admin wire codes (requireAuth): lowercase — folded into the same copy.
    case 'unauthorized':
    case 'token_revoked':
      return { title: '登录状态已过期', message: '请重新登录后再扫码授权' };
    default:
      return { title: '出错了', message: '操作未完成，请重试或重新扫码' };
  }
}

/** clientType is an admin enum ('mac' | 'web') — map to the P11 display copy. */
export function requesterDeviceLabel(clientType: string, userAgent: string | null): string {
  switch (clientType) {
    case 'mac':
      return 'Mac 客户端';
    case 'web':
      return '网页端';
    default:
      return userAgent ? userAgent.slice(0, 40) : '未知设备';
  }
}

/** P11 requester card view model — the three real rows, each degrading alone. */
export interface RequesterCardModel {
  device: string;
  ip: string;
  /** 发起时间 epoch ms — admin's createdAt, else the phone's scan time. */
  requestedAtMs: number;
}

function isoToEpochMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Builds the P11 requester card from the scan endpoint's requester view (仅
 * 核对展示，不参与授权). The scan route supplies the real values; each field
 * degrades independently so a sparse admin response still renders: unknown
 * clientType falls back to the userAgent (then 未知设备), a missing ipMasked
 * keeps the — placeholder, and a missing/unparseable createdAt falls back to
 * the phone's scan time.
 */
export function requesterCardModel(
  requester:
    | (QrRequesterView & { createdAt?: string | null })
    | null,
  fallbackTime: Date,
): RequesterCardModel {
  if (!requester) {
    return {
      device: requesterDeviceLabel('', null),
      ip: '—',
      requestedAtMs: fallbackTime.getTime(),
    };
  }
  return {
    device: requesterDeviceLabel(requester.clientType, requester.userAgent),
    ip: requester.ipMasked ?? '—',
    requestedAtMs: isoToEpochMs(requester.createdAt) ?? fallbackTime.getTime(),
  };
}

/**
 * Safe parse of the /qr-confirm route's `requester` JSON param (set by the
 * scan screen from the scan response). Returns null for absent/garbage
 * values — a deep link straight to the confirm page simply falls back to the
 * status view's requester instead of crashing.
 */
export function parseScanRequesterParam(
  value: string | string[] | undefined | null,
): QrScanRequesterView | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  return {
    clientType: typeof record.clientType === 'string' ? record.clientType : '',
    ipMasked: typeof record.ipMasked === 'string' ? record.ipMasked : null,
    userAgent: typeof record.userAgent === 'string' ? record.userAgent : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : null,
  };
}
