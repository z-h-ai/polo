// POL-16 unit tests for the pairing UI mappers: countdown math (5-min TTL,
// m:ss chip copy) and the admin error code -> copy mapping (错误码→文案).

import { describe, expect, test } from 'bun:test';

import { ApiError, NetworkError } from '../../api/client';
import {
  bindLimitCopy,
  formatPairingCountdown,
  isBindLimitError,
  isPairingCodeReady,
  PAIRING_CODE_TTL_SECONDS,
  pairingCodeDeadline,
  pairingCountdownCopy,
  pairingErrorBarCopy,
  remainingSeconds,
} from '../pairingUi';

describe('countdown math', () => {
  test('deadline = observation + admin TTL (300s)', () => {
    expect(pairingCodeDeadline(1_000_000)).toBe(1_000_000 + PAIRING_CODE_TTL_SECONDS * 1000);
  });

  test('remainingSeconds clamps at zero', () => {
    expect(remainingSeconds(1_000_000, 999_001)).toBe(1);
    expect(remainingSeconds(1_000_000, 1_000_000)).toBe(0);
    expect(remainingSeconds(1_000_000, 2_000_000)).toBe(0);
  });

  test('formatPairingCountdown renders m:ss (P04 剩余 3:12)', () => {
    expect(formatPairingCountdown(192)).toBe('3:12');
    expect(formatPairingCountdown(300)).toBe('5:00');
    expect(formatPairingCountdown(65)).toBe('1:05');
    expect(formatPairingCountdown(5)).toBe('0:05');
    expect(formatPairingCountdown(0)).toBe('0:00');
  });

  test('pairingCountdownCopy hides the chip once the deadline passes', () => {
    expect(pairingCountdownCopy(192)).toBe('配对码剩余 3:12');
    expect(pairingCountdownCopy(0)).toBeNull();
    expect(pairingCountdownCopy(-1)).toBeNull();
  });
});

describe('isPairingCodeReady (manual submit gate)', () => {
  test('exactly six digits', () => {
    expect(isPairingCodeReady('246810')).toBe(true);
    expect(isPairingCodeReady('24681')).toBe(false);
    expect(isPairingCodeReady('2468100')).toBe(false);
    expect(isPairingCodeReady('8F3K2Q')).toBe(false);
  });
});

describe('pairingErrorBarCopy — 错误码→文案映射', () => {
  test('配对码无效/过期 -> P03 errbar copy', () => {
    const invalid = new ApiError({ status: 401, errorCode: 'pairing_code_invalid' });
    const expired = new ApiError({ status: 401, errorCode: 'pairing_code_expired' });
    expect(pairingErrorBarCopy(invalid)).toBe('配对码无效或已过期，请在电脑上重新获取。');
    expect(pairingErrorBarCopy(expired)).toBe('配对码无效或已过期，请在电脑上重新获取。');
  });

  test('已核销 -> 已被使用文案', () => {
    const consumed = new ApiError({ status: 401, errorCode: 'pairing_code_consumed' });
    expect(pairingErrorBarCopy(consumed)).toBe('该配对码已被使用，请在电脑上重新获取。');
  });

  test('跨账号 forbidden', () => {
    const forbidden = new ApiError({ status: 403, errorCode: 'forbidden' });
    expect(pairingErrorBarCopy(forbidden)).toBe('无法绑定：该配对码由其他账号出示。');
  });

  test('重复绑定 device_already_bound', () => {
    const dup = new ApiError({ status: 409, errorCode: 'device_already_bound' });
    expect(pairingErrorBarCopy(dup)).toBe('本手机已绑定这台电脑，无需重复配对。');
  });

  test('超上限 device_bind_limit_reached -> P04 屏3 文案', () => {
    const limit = new ApiError({ status: 409, errorCode: 'device_bind_limit_reached' });
    expect(pairingErrorBarCopy(limit)).toBe('该电脑已绑定 5 台手机，请先解绑一台。');
  });

  test('限流与未知码', () => {
    const rate = new ApiError({ status: 429, errorCode: 'rate_limited' });
    expect(pairingErrorBarCopy(rate)).toBe('操作过于频繁，请稍后再试。');
    const odd = new ApiError({ status: 500, errorCode: 'internal_error' });
    expect(pairingErrorBarCopy(odd)).toBe('绑定失败（internal_error），请稍后再试。');
  });

  test('网络错误与非 ApiError', () => {
    expect(pairingErrorBarCopy(new NetworkError())).toBe('网络异常，请检查网络后重试。');
    expect(pairingErrorBarCopy(new Error('boom'))).toBe('绑定失败，请稍后再试。');
  });
});

describe('bind limit helpers', () => {
  test('isBindLimitError only matches device_bind_limit_reached', () => {
    expect(isBindLimitError(new ApiError({ status: 409, errorCode: 'device_bind_limit_reached' }))).toBe(true);
    expect(isBindLimitError(new ApiError({ status: 401, errorCode: 'pairing_code_expired' }))).toBe(false);
    expect(isBindLimitError(new NetworkError())).toBe(false);
    expect(isBindLimitError(null)).toBe(false);
  });

  test('bindLimitCopy carries the P04 screen copy + 前往设备管理 action', () => {
    expect(bindLimitCopy()).toEqual({
      title: '该电脑已绑定 5 台手机',
      message: '这台电脑已达绑定上限（每台 Mac 最多 5 台）。请先在一台手机上解绑，再重新扫码配对。',
      action: '前往设备管理',
      back: '返回',
    });
  });
});
