// Pure view-model builders for the device list (P02) and manage screens
// (P12) — POL-16. Extracted from the RN components so bun test can assert
// the list/empty rendering decisions without a renderer:
//   - which of the two screen shapes renders (empty guidance vs card list);
//   - per-card copy (three-state badge via inferDeviceStatus + macDeviceId
//     as the display title — admin exposes no Mac display name);
//   - the P02 footer lines (dual-channel + privacy) and the provisional
//     status note (POL-17 replaces the inference with live state);
//   - the P12 本机 masked phone + section titles.

import type { DeviceView } from '../api/devices';
import { inferDeviceStatus } from './deviceStatus';

/** Admin exposes no Mac display name — the stable macDeviceId is the title. */
export function macDisplayName(device: Pick<DeviceView, 'macDeviceId'>): string {
  return device.macDeviceId || '未知电脑';
}

export interface DeviceCardModel {
  key: string;
  title: string;
  statusLabel: string;
  online: boolean;
  /** 离线卡的整卡弱化 (P02 opacity .62). */
  dimmed: boolean;
}

export function toDeviceCardModel(device: DeviceView, nowMs: number): DeviceCardModel {
  const status = inferDeviceStatus(device, nowMs);
  return {
    key: device.id,
    title: macDisplayName(device),
    statusLabel: status.label,
    online: status.online,
    dimmed: !status.online,
  };
}

/** 空态 or 列表态 — the two P02 shapes. */
export type DeviceListShape =
  | { shape: 'empty' }
  | { shape: 'list'; cards: DeviceCardModel[] };

export function deviceListShape(devices: DeviceView[], nowMs: number): DeviceListShape {
  if (devices.length === 0) return { shape: 'empty' };
  return { shape: 'list', cards: devices.map((device) => toDeviceCardModel(device, nowMs)) };
}

/** P02 底注（两行）+ 在线状态为推断的说明（POL-17 接实时状态后移除）. */
export const DEVICE_LIST_FOOTER_LINES: readonly string[] = [
  '同一 Wi-Fi 自动直连电脑，延迟更低；在外网也能用（经 Polo 云安全中转）',
  '消息只在你和你的电脑之间传输，授权可随时在「设备管理」撤销',
  '在线状态按最近活跃推断，实时连接状态即将上线',
] as const;

/** P02 空态文案. */
export const DEVICE_EMPTY_COPY = {
  title: '还没有绑定电脑',
  message: '在 Mac 上打开 Polo → 设置 → 手机连接，\n用本 App 扫描配对二维码即可绑定。',
  scan: '扫码添加电脑',
  manual: '手动输入配对码',
} as const;

/** P12 本机行：13800008000 -> '138****8000'（原型 138****8000）. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length !== 11) return phone;
  return `${digits.slice(0, 3)}****${digits.slice(7)}`;
}

/** P12 section titles. */
export function manageSectionTitles(count: number): { mine: string; bound: string } {
  return { mine: '本机', bound: `已绑定的电脑（${count}）` };
}

/** P12 说明块三行（管理边界）. */
export const MANAGE_NOTE_LINES: readonly string[] = [
  '每台 Mac 最多同时绑定 5 台手机；解绑即时受理，最长 60 秒内全网断开。',
  '网页端登录设备请在 www.z-h-ai.com 「账号安全」中管理。',
  '发现陌生设备？先解绑 / 踢出，再修改账号密码。',
] as const;

/** P12 解绑二次确认弹层文案（PRD §⑤ 定稿；UnbindConfirmSheet renders it）. */
export const UNBIND_SHEET_COPY = {
  titlePrefix: '解绑',
  titleSuffix: '？',
  body: '解绑后，本手机将立即无法向这台电脑发送消息；再次使用需重新扫码配对。',
  bodyTiming: '解绑即时受理，最长 60 秒内全网断开。',
  confirm: '确认解绑',
  confirmBusy: '解绑中…',
  cancel: '取消',
} as const;
