// Device list status inference (POL-16).
//
// P02 shows three badge states (在线·Wi-Fi 直连 / 在线·经云中转 / 离线) but the
// wire (admin DeviceView) carries no live connection data — only lastSeenAt.
// This card therefore INFERS: a recently-heartbeat device renders as
// 「在线 · 经云中转」, anything else as 「离线 · 最近在线 …」. Real connection
// state (LAN direct vs relay, IP chip) is the POL-17 connection manager's
// job — it will replace `kind: 'cloud'` with synthesized live states; the
// UI copy below is shaped so only the mapping function changes.

import type { DeviceView } from '../api/devices';

/**
 * lastSeenAt younger than this counts as 「在线 · 经云中转」. Aligned with the
 * relay/check-access 60s cache window (PRD §⑤: 解绑最长 60s 全网断开) plus
 * heartbeat slack — POL-17 replaces this heuristic with real state.
 */
export const ONLINE_WINDOW_MS = 5 * 60_000;

export type DeviceStatusKind = 'online' | 'offline';

export interface DeviceStatusView {
  kind: DeviceStatusKind;
  /** P02 badge copy, e.g. 「在线 · 经云中转」 / 「离线 · 2 小时前在线」. */
  label: string;
  /** True while the inference window says "probably reachable". */
  online: boolean;
}

export function inferDeviceStatus(
  device: Pick<DeviceView, 'lastSeenAt'>,
  nowMs: number = Date.now(),
): DeviceStatusView {
  const seenMs = device.lastSeenAt === null ? 0 : Date.parse(device.lastSeenAt);
  if (Number.isFinite(seenMs) && seenMs > 0 && nowMs - seenMs <= ONLINE_WINDOW_MS) {
    return { kind: 'online', label: '在线 · 经云中转', online: true };
  }
  const detail = Number.isFinite(seenMs) && seenMs > 0 ? `最近在线 ${formatRelativeTime(seenMs, nowMs)}` : '暂无活跃记录';
  return { kind: 'offline', label: `离线 · ${detail}`, online: false };
}

/** 刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD（更早，对齐 P12 绑定于）. */
export function formatRelativeTime(seenMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - seenMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDate(new Date(seenMs));
}

/** '2026-10-17' local date (P12 「绑定于 2026-10-17」). */
export function formatDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** P12 row sub copy: 「在线 · 绑定于 2026-10-17」. */
export function boundAtLabel(
  device: Pick<DeviceView, 'lastSeenAt'> & { boundAt: string },
  nowMs: number = Date.now(),
): string {
  const ms = Date.parse(device.boundAt);
  const bound = Number.isFinite(ms) ? formatDate(new Date(ms)) : '未知日期';
  const seen = inferDeviceStatus(device, nowMs);
  return `${seen.online ? '在线' : '离线'} · 绑定于 ${bound}`;
}
