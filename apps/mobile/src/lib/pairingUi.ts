// Pure mappers from pairing wire data / api errors to UI states and copy
// (POL-16). Copy follows the PRD v1.6 定稿 (prototype P03/P04):
//   过期/无效码 -> 「配对码无效或已过期，请在电脑上重新获取。」 (P03 errbar)
//   已核销      -> 「该配对码已被使用，请在电脑上重新获取。」
//   超上限      -> P04 第 3 屏整屏错误态 + 「前往设备管理」
// Countdown is informational only (P04 「配对码剩余 m:ss」): the phone never
// sees the Mac's issue moment, so the clock starts from the phone's first
// observation of the code against the admin TTL (300s). The authoritative
// validity check is always the admin bind response — expiry here merely
// prompts a re-scan before a doomed attempt.

import { ApiError, NetworkError } from '../api/client';
import { PAIRING_CODE_LENGTH, isValidPairingCode } from './pairingPayload';

/** Admin PAIRING_CODE_TTL_SECONDS (src/lib/devices/pairing.ts). */
export const PAIRING_CODE_TTL_SECONDS = 300;

/** Epoch-ms deadline for the countdown, from the phone's first observation. */
export function pairingCodeDeadline(observedAtMs: number): number {
  return observedAtMs + PAIRING_CODE_TTL_SECONDS * 1000;
}

export function remainingSeconds(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/** 192 -> '3:12' (P04 chip 「配对码剩余 3:12」). Zero renders as 0:00. */
export function formatPairingCountdown(remainingSec: number): string {
  const safe = Math.max(0, Math.floor(remainingSec));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Full chip copy: 0 hides the chip (deadline passed -> re-scan prompt). */
export function pairingCountdownCopy(remainingSec: number): string | null {
  if (remainingSec <= 0) return null;
  return `配对码剩余 ${formatPairingCountdown(remainingSec)}`;
}

/** 判断一个手动输入的配对码是否可提交（6 位数字）。 */
export function isPairingCodeReady(input: string): boolean {
  return input.length === PAIRING_CODE_LENGTH && isValidPairingCode(input);
}

export interface PairingErrorCopy {
  title: string;
  message: string;
}

/** Manual-entry error bar copy (P03: single line, no title). */
export function pairingErrorBarCopy(error: unknown): string {
  if (error instanceof NetworkError) {
    return '网络异常，请检查网络后重试。';
  }
  if (error instanceof ApiError) {
    switch (error.errorCode) {
      case 'pairing_code_invalid':
      case 'pairing_code_expired':
        return '配对码无效或已过期，请在电脑上重新获取。';
      case 'pairing_code_consumed':
        return '该配对码已被使用，请在电脑上重新获取。';
      case 'forbidden':
        return '无法绑定：该配对码由其他账号出示。';
      case 'device_already_bound':
        return '本手机已绑定这台电脑，无需重复配对。';
      case 'device_bind_limit_reached':
        return '该电脑已绑定 5 台手机，请先解绑一台。';
      case 'rate_limited':
        return '操作过于频繁，请稍后再试。';
      default:
        return `绑定失败（${error.errorCode}），请稍后再试。`;
    }
  }
  return '绑定失败，请稍后再试。';
}

/** True when the error should switch the flow to the P04 limit screen. */
export function isBindLimitError(error: unknown): boolean {
  return error instanceof ApiError && error.errorCode === 'device_bind_limit_reached';
}

/** P04 第 3 屏整屏错误态 copy. */
export function bindLimitCopy(): { title: string; message: string; action: string; back: string } {
  return {
    title: '该电脑已绑定 5 台手机',
    message: '这台电脑已达绑定上限（每台 Mac 最多 5 台）。请先在一台手机上解绑，再重新扫码配对。',
    action: '前往设备管理',
    back: '返回',
  };
}
