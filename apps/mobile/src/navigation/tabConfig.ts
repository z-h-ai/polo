// Bottom tab configuration (POL-244, aligned with prototype M01/P13 tab bar).
//
// Pure data (no React) so the tab contract is assertable in bun test: exactly
// three tabs — 消息 / 设备 / 我的 — with 消息 owning the tabs root route.
// Icons/labels render in app/(tabs)/_layout.tsx from this list.

export type TabKey = 'messages' | 'devices' | 'profile';

export interface TabItem {
  key: TabKey;
  /** Route passed to Tabs.Screen name (expo-router file convention). */
  route: string;
  label: string;
}

export const TAB_ITEMS: readonly TabItem[] = [
  { key: 'messages', route: 'index', label: '消息' },
  { key: 'devices', route: 'devices', label: '设备' },
  { key: 'profile', route: 'profile', label: '我的' },
] as const;
