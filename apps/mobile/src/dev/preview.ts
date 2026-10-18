// Web 预览夹具（视觉验收专用，POL-ACC）。
//
// 仅当构建期注入 EXPO_PUBLIC_PREVIEW_MODE=1 时生效；生产构建（未设该变量）
// 的所有函数都是空操作，运行时行为与正式包完全一致。该夹具不改变任何业务
// 逻辑：只替换 token 存储为内存桩、拦截 fixture API、预填演示数据，用于
// 无设备环境下（web 导出 + 无头截图）的视觉验收。

import type { StoredTokens, TokenStore } from '../auth/tokenStore';
import { useSessionStore } from '../session/sessionStore';

export const PREVIEW_MODE = process.env.EXPO_PUBLIC_PREVIEW_MODE === '1';

const PREVIEW_USER = {
  id: 'preview-user-0001',
  phone: '13800008000',
  username: 'preview',
  displayName: '预览用户',
};

export const PREVIEW_TOKENS: StoredTokens = {
  accessToken: 'preview-access-token',
  refreshToken: 'preview-refresh-token',
  user: PREVIEW_USER,
};

/** session.ts 创建 store 时的 token 存储替换（仅预览模式返回桩）。 */
export function previewTokenStoreOverride(): TokenStore | null {
  if (!PREVIEW_MODE) return null;
  return {
    backend: () => 'memory',
    async load() {
      return PREVIEW_TOKENS;
    },
    getCached() {
      return PREVIEW_TOKENS;
    },
    async save() {},
    async updateAccessToken() {},
    async clear() {},
  };
}

// --- fixture API（web 预览下拦截 EXPO_PUBLIC_API_URL 请求） ---

const now = (): number => Date.now();
const DEVICES_FIXTURE = {
  devices: [
    {
      id: 'dev-preview-1',
      userId: PREVIEW_USER.id,
      macDeviceId: 'mac-preview-A1',
      name: '书房的 MacBook Pro',
      platform: 'macos',
      lastSeenAt: new Date(now() - 2 * 60 * 1000).toISOString(),
      boundAt: new Date(now() - 7 * 24 * 3600 * 1000).toISOString(),
      revoked: false,
    },
    {
      id: 'dev-preview-2',
      userId: PREVIEW_USER.id,
      macDeviceId: 'mac-preview-B2',
      name: '客厅的 Mac mini',
      platform: 'macos',
      lastSeenAt: new Date(now() - 3 * 3600 * 1000).toISOString(),
      boundAt: new Date(now() - 30 * 24 * 3600 * 1000).toISOString(),
      revoked: false,
    },
  ],
};

function res0(path: string): string {
  return path.slice(0, 60)
}

function fixtureResponse(path: string): unknown | undefined {
  if (path.startsWith('/api/devices/list')) return DEVICES_FIXTURE;
  if (path.startsWith('/api/devices/check-access')) return { allowed: true };
  if (path.startsWith('/api/billing/voice/quote')) return {
    ok: true,
    quoted: true,
    preholdSeconds: 60,
    credits: 10,
  };
  return undefined;
}

const PREVIEW_API_BASE = 'http://preview.mock';

/** 安装 fetch 拦截（web 预览构建专用；native 构建为空操作）。 */
export function installPreviewFetch(): void {
  if (!PREVIEW_MODE || typeof globalThis.fetch !== 'function') return;
  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.startsWith(PREVIEW_API_BASE)) {
      const path = url.slice(PREVIEW_API_BASE.length);
      const body = fixtureResponse(path);
      console.log('[preview-shim]', res0(path), '->', body === undefined ? 'PASS-THROUGH' : 200);
      if (body !== undefined) {
        return Promise.resolve(new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        }));
      }
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

/** 预填演示会话（P05 五态中的在线态：已送达/执行中/完成各一）。 */
export function seedPreviewSession(): void {
  if (!PREVIEW_MODE) return;
  const s = useSessionStore.getState();
  s.sessionOpened('sess-preview-01', 'ws-preview');
  s.setConnStatus('online-lan');
  s.setMacOffline(false);
  const t0 = now() - 60_000;
  s.appendUserEntry({ id: 'e1', text: '帮我把这份季度文档总结成三个要点', atMs: t0 });
  s.markDelivered({ id: 'e1', atMs: t0 + 900, channelLabel: 'Wi-Fi 直连' });
  s.markRunning({ id: 'e1', atMs: t0 + 1200 });
  s.markDone({ id: 'e1', atMs: t0 + 26_000 });
  s.appendUserEntry({ id: 'e2', text: '把会议纪要发到工作群', atMs: now() - 8_000 });
  s.markDelivered({ id: 'e2', atMs: now() - 7_600, channelLabel: 'Wi-Fi 直连' });
  s.markRunning({ id: 'e2', atMs: now() - 7_000 });
  useSessionStore.setState({
    entries: [
      ...useSessionStore.getState().entries,
      { id: 'a1', role: 'assistant', text: '三个要点：1）营收同比增长 18%，毛利率改善 2.4pct；2）新签合同额创季度新高；3）现金流保持稳健，费用率下降。', atMs: t0 + 27_000 },
    ],
  });
}

