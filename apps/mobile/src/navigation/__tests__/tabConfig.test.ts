// POL-19 unit tests for the bottom tab contract (bun test).
//
// The shell promises exactly three tabs — 消息 / 设备 / 我的 — with 消息
// owning the tabs root route (post-login landing page).

import { describe, expect, test } from 'bun:test';

import { TAB_ITEMS } from '../tabConfig';

describe('TAB_ITEMS', () => {
  test('exposes exactly 消息/设备/我的 in order', () => {
    expect(TAB_ITEMS.map((item) => item.label)).toEqual(['消息', '设备', '我的']);
    expect(TAB_ITEMS.map((item) => item.key)).toEqual(['messages', 'devices', 'profile']);
  });

  test('消息 owns the tabs root route; the others own their file routes', () => {
    const [messages, devices, profile] = TAB_ITEMS;
    expect(messages?.route).toBe('index');
    expect(devices?.route).toBe('devices');
    expect(profile?.route).toBe('profile');
  });
});
