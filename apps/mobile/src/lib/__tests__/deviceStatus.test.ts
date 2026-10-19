// POL-241 unit tests for the device list status inference (P02 三态) and the
// manage-screen date/label helpers (P12).
//
// The wire carries only lastSeenAt, so 在线 is an INFERENCE (recent heartbeat
// -> 在线·经云中转); POL-242's connection manager will replace it — these tests
// pin the heuristic the UI ships until then.

import { describe, expect, test } from 'bun:test';

import {
  boundAtLabel,
  formatDate,
  formatRelativeTime,
  inferDeviceStatus,
  ONLINE_WINDOW_MS,
} from '../deviceStatus';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

describe('inferDeviceStatus — 三态推断', () => {
  test('recent heartbeat (inside the window) -> 在线 · 经云中转', () => {
    const seen = new Date(NOW - 30_000).toISOString();
    const status = inferDeviceStatus({ lastSeenAt: seen }, NOW);
    expect(status).toEqual({ kind: 'online', label: '在线 · 经云中转', online: true });
  });

  test('exactly at the window edge still counts as online', () => {
    const seen = new Date(NOW - ONLINE_WINDOW_MS).toISOString();
    expect(inferDeviceStatus({ lastSeenAt: seen }, NOW).online).toBe(true);
  });

  test('stale heartbeat -> 离线 · 最近在线 …', () => {
    const seen = new Date(NOW - 2 * 3_600_000).toISOString(); // 2 小时前
    const status = inferDeviceStatus({ lastSeenAt: seen }, NOW);
    expect(status).toEqual({
      kind: 'offline',
      label: '离线 · 最近在线 2 小时前',
      online: false,
    });
  });

  test('null lastSeenAt -> 离线 · 暂无活跃记录', () => {
    expect(inferDeviceStatus({ lastSeenAt: null }, NOW)).toEqual({
      kind: 'offline',
      label: '离线 · 暂无活跃记录',
      online: false,
    });
  });

  test('an unreadable timestamp never throws and is offline', () => {
    const status = inferDeviceStatus({ lastSeenAt: 'not-a-date' }, NOW);
    expect(status.kind).toBe('offline');
  });
});

describe('formatRelativeTime', () => {
  test('刚刚 / 分钟 / 小时 / 天 buckets', () => {
    expect(formatRelativeTime(NOW - 20_000, NOW)).toBe('刚刚');
    expect(formatRelativeTime(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59 分钟前');
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前');
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 天前');
  });

  test('older than 30 days falls back to the date string', () => {
    const seen = new Date(NOW - 45 * 86_400_000);
    expect(formatRelativeTime(seen.getTime(), NOW)).toBe(formatDate(seen));
  });

  test('future timestamps (clock skew) clamp to 刚刚', () => {
    expect(formatRelativeTime(NOW + 86_400_000, NOW)).toBe('刚刚');
  });
});

describe('boundAtLabel (P12 row sub)', () => {
  test('online binding renders 在线 · 绑定于 …', () => {
    const device = {
      lastSeenAt: new Date(NOW - 60_000).toISOString(),
      boundAt: new Date(NOW - 86_400_000).toISOString(),
    };
    expect(boundAtLabel(device, NOW)).toBe(`在线 · 绑定于 ${formatDate(new Date(NOW - 86_400_000))}`);
  });

  test('offline binding renders 离线 · 绑定于 …', () => {
    const device = {
      lastSeenAt: new Date(NOW - 10 * 86_400_000).toISOString(),
      boundAt: new Date(NOW - 30 * 86_400_000).toISOString(),
    };
    expect(boundAtLabel(device, NOW)).toBe(`离线 · 绑定于 ${formatDate(new Date(NOW - 30 * 86_400_000))}`);
  });

  test('an unreadable boundAt degrades to 未知日期', () => {
    const device = { lastSeenAt: null, boundAt: 'garbage' };
    expect(boundAtLabel(device, NOW)).toBe('离线 · 绑定于 未知日期');
  });
});
