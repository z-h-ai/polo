// POL-19 regression guard for the expo-router file convention (bun test).
//
// The tab contract (tabConfig.ts) only names routes; the actual wiring lives
// in app/ file names. These fs assertions keep the shell honest: the three tab
// screens exist, the pre-shell root app/index.tsx stays deleted ('/' must
// resolve to (tabs)/index = 消息 Tab only), and the Stack screens declared in
// app/_layout.tsx all have a route file (no orphans).

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { TAB_ITEMS } from '../tabConfig';

// __tests__ -> navigation -> src -> apps/mobile/app
const APP_DIR = join(import.meta.dir, '..', '..', '..', 'app');

describe('expo-router route map', () => {
  test('the three tab screens exist under app/(tabs)', () => {
    const tabsDir = join(APP_DIR, '(tabs)');
    expect(existsSync(join(tabsDir, 'index.tsx'))).toBe(true); // 消息 = tabs root
    expect(existsSync(join(tabsDir, 'devices.tsx'))).toBe(true);
    expect(existsSync(join(tabsDir, 'profile.tsx'))).toBe(true);
    expect(existsSync(join(tabsDir, '_layout.tsx'))).toBe(true);
  });

  test('app/index.tsx stays deleted so / resolves to (tabs)/index only', () => {
    expect(existsSync(join(APP_DIR, 'index.tsx'))).toBe(false);
    expect(existsSync(join(APP_DIR, '_layout.tsx'))).toBe(true);
  });

  test('every non-tab Stack screen in app/_layout.tsx has a route file', () => {
    for (const route of ['login.tsx', 'scan-qr.tsx', 'qr-confirm.tsx', 'pair-placeholder.tsx']) {
      expect(existsSync(join(APP_DIR, route))).toBe(true);
    }
  });

  test('tab routes in tabConfig match the (tabs) file convention', () => {
    const tabsDir = join(APP_DIR, '(tabs)');
    for (const item of TAB_ITEMS) {
      expect(existsSync(join(tabsDir, `${item.route}.tsx`))).toBe(true);
    }
  });
});
