// POL-244 unit tests for the 消息 tab unread badge (bun test).

import { describe, expect, test } from 'bun:test';

import {
  createUnreadStore,
  reduceUnread,
  unreadBadgeLabel,
} from '../unread';

describe('reduceUnread', () => {
  test('set replaces and clamps at zero', () => {
    expect(reduceUnread(0, { type: 'set', count: 1 })).toBe(1);
    expect(reduceUnread(5, { type: 'set', count: 0 })).toBe(0);
    expect(reduceUnread(5, { type: 'set', count: -3 })).toBe(0);
  });

  test('increment adds and never goes backwards', () => {
    expect(reduceUnread(0, { type: 'increment' })).toBe(1);
    expect(reduceUnread(1, { type: 'increment', by: 4 })).toBe(5);
    expect(reduceUnread(1, { type: 'increment', by: 0 })).toBe(2); // by < 1 coerced to 1
  });

  test('clear resets to zero', () => {
    expect(reduceUnread(7, { type: 'clear' })).toBe(0);
  });
});

describe('unreadBadgeLabel', () => {
  test('null hides the bubble at zero', () => {
    expect(unreadBadgeLabel(0)).toBeNull();
    expect(unreadBadgeLabel(-1)).toBeNull();
  });

  test('static 0/1 switch and cap at 99+', () => {
    expect(unreadBadgeLabel(1)).toBe('1');
    expect(unreadBadgeLabel(42)).toBe('42');
    expect(unreadBadgeLabel(100)).toBe('99+');
  });
});

describe('createUnreadStore', () => {
  test('applies actions through the reducer', () => {
    const store = createUnreadStore();
    expect(store.getState().count).toBe(0);
    store.getState().apply({ type: 'set', count: 1 });
    expect(store.getState().count).toBe(1);
    store.getState().apply({ type: 'clear' });
    expect(store.getState().count).toBe(0);
  });
});
