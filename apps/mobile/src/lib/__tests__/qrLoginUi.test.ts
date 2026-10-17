// POL-15 unit tests for the qr-login UI mappers (bun test, pure functions).
//
// Covers: the ticket status machine -> UI state mapping and the confirm
// failure 文案流转 (secret 失败计数 1..4 -> 校验失败可重试，达 5 次作废 ->
// 失败次数过多文案，其余 admin 错误码 -> 对应弹层文案).

import { describe, expect, test } from 'bun:test';

import { ApiError, NetworkError } from '../../api/client';
import type { QrTicketStatus } from '../../api/qrLogin';
import {
  qrErrorToAlertCopy,
  qrInvalidPayloadCopy,
  requesterDeviceLabel,
  statusToUiState,
  ticketStatusAlertCopy,
} from '../qrLoginUi';

describe('statusToUiState — 票据状态机映射', () => {
  test('pending / scanned -> ready（可确认）', () => {
    expect(statusToUiState('pending')).toBe('ready');
    expect(statusToUiState('scanned')).toBe('ready');
  });

  test('confirmed -> success', () => {
    expect(statusToUiState('confirmed')).toBe('success');
  });

  test('rejected -> rejected', () => {
    expect(statusToUiState('rejected')).toBe('rejected');
  });

  test('expired -> expired', () => {
    expect(statusToUiState('expired')).toBe('expired');
  });

  test('consumed -> used', () => {
    expect(statusToUiState('consumed')).toBe('used');
  });
});

describe('ticketStatusAlertCopy — 终态票据回落 P10 弹层', () => {
  test('expired 引导电脑端刷新后重扫', () => {
    expect(ticketStatusAlertCopy('expired')).toMatchObject({ title: '二维码已过期' });
    expect(ticketStatusAlertCopy('expired')?.message).toContain('刷新二维码后重新扫码');
  });

  test('live/confirmed 状态不弹层（返回 null）', () => {
    expect(ticketStatusAlertCopy('pending')).toBeNull();
    expect(ticketStatusAlertCopy('scanned')).toBeNull();
    expect(ticketStatusAlertCopy('confirmed')).toBeNull();
  });
});

describe('qrErrorToAlertCopy — confirm 失败文案流转', () => {
  test('secret 不匹配（failCount 1..4）→ 校验失败 + 重新扫码', () => {
    const copy = qrErrorToAlertCopy(new ApiError({ status: 401, errorCode: 'invalid_credentials' }));
    expect(copy.title).toBe('二维码校验失败');
    expect(copy.message).toContain('重新扫描');
  });

  test('failCount 达 5 作废（429）→ 已作废 + 引导刷新重扫', () => {
    const copy = qrErrorToAlertCopy(
      new ApiError({ status: 429, errorCode: 'qr_login_attempts_exceeded' }),
    );
    expect(copy.title).toBe('二维码已作废');
    expect(copy.message).toContain('失败次数过多');
    expect(copy.message).toContain('刷新二维码后重新扫码');
  });

  test('confirm 时票据已过期（401）→ 过期弹层语义', () => {
    const copy = qrErrorToAlertCopy(new ApiError({ status: 401, errorCode: 'qr_login_expired' }));
    expect(copy.title).toBe('二维码已过期');
    expect(copy.message).toBe('请让电脑或网页端刷新二维码后重新扫码');
  });

  test('票据无效（404/409 qr_login_invalid）→ 无效 + 刷新引导', () => {
    const copy = qrErrorToAlertCopy(new ApiError({ status: 404, errorCode: 'qr_login_invalid' }));
    expect(copy.title).toBe('二维码无效');
    expect(copy.message).toContain('刷新二维码后重新扫码');
  });

  test('已被拒绝（409 qr_login_cancelled）→ 已失效提示', () => {
    const copy = qrErrorToAlertCopy(new ApiError({ status: 409, errorCode: 'qr_login_cancelled' }));
    expect(copy.title).toBe('二维码已失效');
    expect(copy.message).toContain('已被拒绝');
  });

  test('已消费（409 qr_login_consumed）→ 已使用提示', () => {
    const copy = qrErrorToAlertCopy(new ApiError({ status: 409, errorCode: 'qr_login_consumed' }));
    expect(copy.title).toBe('二维码已使用');
  });

  test('被他人确认（403 forbidden）→ 无法授权提示', () => {
    const copy = qrErrorToAlertCopy(new ApiError({ status: 403, errorCode: 'forbidden' }));
    expect(copy.title).toBe('无法授权');
    expect(copy.message).toContain('其他账号');
  });

  test('限流（429 rate_limited）→ 操作频繁提示', () => {
    const copy = qrErrorToAlertCopy(new ApiError({ status: 429, errorCode: 'rate_limited' }));
    expect(copy.title).toBe('操作过于频繁');
  });

  test('admin 小写鉴权 401（unauthorized/token_revoked）→ 登录状态过期提示', () => {
    expect(qrErrorToAlertCopy(new ApiError({ status: 401, errorCode: 'unauthorized' })).title).toBe(
      '登录状态已过期',
    );
    expect(qrErrorToAlertCopy(new ApiError({ status: 401, errorCode: 'token_revoked' })).title).toBe(
      '登录状态已过期',
    );
  });

  test('网络错误 → 网络提示（可重试，不静默）', () => {
    const copy = qrErrorToAlertCopy(new NetworkError());
    expect(copy.title).toBe('网络连接失败');
    expect(copy.message).toContain('重试');
  });

  test('未知错误兜底为通用文案', () => {
    const copy = qrErrorToAlertCopy(new ApiError({ status: 500, errorCode: 'internal_error' }));
    expect(copy.title).toBe('出错了');
    expect(qrErrorToAlertCopy('boom')).toMatchObject({ title: '出错了' });
  });
});

describe('qrInvalidPayloadCopy — 非 Polo 码弹层', () => {
  test('P10 定稿文案', () => {
    expect(qrInvalidPayloadCopy()).toEqual({
      title: '不是 Polo 登录二维码',
      message: '这不是 Polo 登录二维码，请核对后再试',
    });
  });
});

describe('requesterDeviceLabel — clientType 展示映射', () => {
  test('mac / web 映射为中文标签，未知回退 userAgent 或未知设备', () => {
    expect(requesterDeviceLabel('mac', null)).toBe('Mac 客户端');
    expect(requesterDeviceLabel('web', null)).toBe('网页端');
    expect(requesterDeviceLabel('future-thing', 'PoloMac/1.0')).toBe('PoloMac/1.0');
    expect(requesterDeviceLabel('', null)).toBe('未知设备');
  });
});

// Keep the ticket status union honest: every admin status must have a UI state.
test('all admin ticket statuses map without throwing', () => {
  const statuses: QrTicketStatus[] = [
    'pending',
    'scanned',
    'confirmed',
    'rejected',
    'expired',
    'consumed',
  ];
  for (const status of statuses) {
    expect(statusToUiState(status)).toBeTruthy();
  }
});
