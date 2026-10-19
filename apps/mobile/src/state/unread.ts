// Unread-badge state for the 消息 tab (POL-244).
//
// Static placeholder wiring: the badge renders 0/1 per the shell card
// ("静态 0/1 可切"); real unread counts arrive with the session/message cards
// (POL-243). The reducer is pure so transitions are unit-testable.

import { create } from 'zustand';

export type UnreadAction =
  | { type: 'set'; count: number }
  | { type: 'increment'; by?: number }
  | { type: 'clear' };

/** Clamp-at-zero unread counter; increment never goes backwards. */
export function reduceUnread(count: number, action: UnreadAction): number {
  switch (action.type) {
    case 'set':
      return Math.max(0, Math.trunc(action.count));
    case 'increment': {
      const by = action.by === undefined ? 1 : Math.max(1, Math.trunc(action.by));
      return count + by;
    }
    case 'clear':
      return 0;
  }
}

/** Tab-bar badge copy: null hides the bubble; 100+ collapses to '99+'. */
export function unreadBadgeLabel(count: number): string | null {
  if (count <= 0) return null;
  if (count > 99) return '99+';
  return String(count);
}

export interface UnreadState {
  count: number;
  apply(action: UnreadAction): void;
}

export function createUnreadStore() {
  return create<UnreadState>((set) => ({
    count: 0,
    apply(action) {
      set((state) => ({ count: reduceUnread(state.count, action) }));
    },
  }));
}

/** App-wide singleton consumed by the tab bar badge slot. */
export const useUnreadStore = createUnreadStore();
