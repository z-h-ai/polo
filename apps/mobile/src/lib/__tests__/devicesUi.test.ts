// POL-16 unit tests for the device list/manage view-model builders:
// the P02 empty-vs-list shape decision, per-card copy, footer lines, the P12
// phone masking + section titles, and the unbind sheet copy contract.

import { describe, expect, test } from 'bun:test';

import type { DeviceView } from '../../api/devices';
import {
  deviceIconForPlatform,
  deviceListShape,
  DEVICE_EMPTY_COPY,
  DEVICE_LIST_FOOTER_LINES,
  macDisplayName,
  manageSectionTitles,
  MANAGE_NOTE_LINES,
  maskPhone,
  toDeviceCardModel,
  UNBIND_SHEET_COPY,
} from '../devicesUi';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');

function device(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: 'dev-1',
    name: 'Douglas 的 iPhone',
    platform: 'ios',
    macDeviceId: 'mac-7F3A-92C1-0D8E',
    macName: null,
    pushToken: null,
    lastSeenAt: new Date(NOW - 30_000).toISOString(),
    boundAt: new Date(NOW - 86_400_000).toISOString(),
    revoked: false,
    ...overrides,
  };
}

describe('macDisplayName — macName 优先回退链', () => {
  test('macName 非空优先显示（P02/P12 标题）', () => {
    expect(macDisplayName({ macName: '书房的 MacBook Pro', macDeviceId: 'mac-7F3A' })).toBe(
      '书房的 MacBook Pro',
    );
  });

  test('macName 空/纯空白回退 macDeviceId', () => {
    expect(macDisplayName({ macName: null, macDeviceId: 'mac-7F3A' })).toBe('mac-7F3A');
    expect(macDisplayName({ macName: '', macDeviceId: 'mac-7F3A' })).toBe('mac-7F3A');
    expect(macDisplayName({ macName: '   ', macDeviceId: 'mac-7F3A' })).toBe('mac-7F3A');
  });

  test('两者皆空兜底 未知电脑', () => {
    expect(macDisplayName({ macName: null, macDeviceId: '' })).toBe('未知电脑');
  });
});

describe('deviceListShape — P02 空态 vs 列表态', () => {
  test('no bindings -> the empty-guidance shape', () => {
    expect(deviceListShape([], NOW)).toEqual({ shape: 'empty' });
  });

  test('bindings -> one card per row, newest first preserved', () => {
    const online = device({ id: 'a' });
    const offline = device({
      id: 'b',
      macDeviceId: 'mac-old',
      lastSeenAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    });
    const shape = deviceListShape([online, offline], NOW);
    expect(shape.shape).toBe('list');
    if (shape.shape !== 'list') return;
    expect(shape.cards).toHaveLength(2);
    expect(shape.cards[0]).toEqual({
      key: 'a',
      title: 'mac-7F3A-92C1-0D8E',
      statusLabel: '在线 · 经云中转',
      online: true,
      dimmed: false,
      platform: 'ios',
    });
    expect(shape.cards[1]?.online).toBe(false);
    expect(shape.cards[1]?.dimmed).toBe(true);
    expect(shape.cards[1]?.statusLabel).toBe('离线 · 最近在线 2 小时前');
  });
});

describe('toDeviceCardModel', () => {
  test('offline cards dim the whole card (P02 opacity .62)', () => {
    const offline = toDeviceCardModel(device({ lastSeenAt: null }), NOW);
    expect(offline.dimmed).toBe(true);
    expect(offline.statusLabel).toBe('离线 · 暂无活跃记录');
  });

  test('cards carry the raw platform for the V-11 glyph pick', () => {
    expect(toDeviceCardModel(device({ platform: 'macos' }), NOW).platform).toBe('macos');
    expect(toDeviceCardModel(device({ platform: 'bogus' }), NOW).platform).toBe('bogus');
  });
});

describe('deviceIconForPlatform — V-11 glyph fallback', () => {
  test("'macos' renders the computer graphic", () => {
    expect(deviceIconForPlatform('macos')).toBe('devices');
  });

  test('unknown/other platforms fall back to the phone graphic, never person', () => {
    expect(deviceIconForPlatform('ios')).toBe('phone');
    expect(deviceIconForPlatform('android')).toBe('phone');
    expect(deviceIconForPlatform('')).toBe('phone');
    expect(deviceIconForPlatform(undefined)).toBe('phone');
    expect(deviceIconForPlatform(null)).toBe('phone');
  });
});

describe('copy contracts', () => {
  test('P02 footer: dual-channel + privacy + provisional-status note', () => {
    expect(DEVICE_LIST_FOOTER_LINES).toEqual([
      '同一 Wi-Fi 自动直连电脑，延迟更低；在外网也能用（经 Polo 云安全中转）',
      '消息只在你和你的电脑之间传输，授权可随时在「设备管理」撤销',
      '在线状态按最近活跃推断，实时连接状态即将上线',
    ]);
  });

  test('P02 empty-state guidance copy', () => {
    expect(DEVICE_EMPTY_COPY.title).toBe('还没有绑定电脑');
    expect(DEVICE_EMPTY_COPY.scan).toBe('扫码添加电脑');
    expect(DEVICE_EMPTY_COPY.manual).toBe('手动输入配对码');
    expect(DEVICE_EMPTY_COPY.message).toContain('设置 → 手机连接');
  });

  test('P12 note block: 5-phone cap + 60s window, web guidance, unknown device', () => {
    expect(MANAGE_NOTE_LINES[0]).toContain('最多同时绑定 5 台手机');
    expect(MANAGE_NOTE_LINES[0]).toContain('最长 60 秒内全网断开');
    expect(MANAGE_NOTE_LINES[1]).toContain('www.z-h-ai.com');
    expect(MANAGE_NOTE_LINES[1]).toContain('账号安全');
    expect(MANAGE_NOTE_LINES[2]).toContain('陌生设备');
  });

  test('unbind sheet carries the PRD §⑤ consequence copy', () => {
    expect(UNBIND_SHEET_COPY.body).toBe(
      '解绑后，本手机将立即无法向这台电脑发送消息；再次使用需重新扫码配对。',
    );
    expect(UNBIND_SHEET_COPY.bodyTiming).toBe('解绑即时受理，最长 60 秒内全网断开。');
    expect(UNBIND_SHEET_COPY.confirm).toBe('确认解绑');
  });
});

describe('maskPhone (P12 本机)', () => {
  test('13800008000 -> 138****8000', () => {
    expect(maskPhone('13800008000')).toBe('138****8000');
  });

  test('non-11-digit input passes through untouched', () => {
    expect(maskPhone('12345')).toBe('12345');
    expect(maskPhone('')).toBe('');
  });
});

describe('manageSectionTitles', () => {
  test('the bound count renders into the section title', () => {
    expect(manageSectionTitles(0).bound).toBe('已绑定的电脑（0）');
    expect(manageSectionTitles(2).bound).toBe('已绑定的电脑（2）');
    expect(manageSectionTitles(2).mine).toBe('本机');
  });
});
