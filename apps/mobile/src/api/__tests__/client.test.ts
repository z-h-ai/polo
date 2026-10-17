// POL-14 unit tests for the api client (bun test, mock fetch).
//
// Covers: 401 -> refresh -> replay success, refresh rejection clearing local
// state + auth-expired notification, concurrent 401 single-flight refresh,
// admin error code pass-through (rate limit / code invalid), replay still
// 401 -> AuthExpiredError, and header behavior for auth-less endpoints.

import { describe, expect, test } from 'bun:test';

import {
  ApiError,
  AuthExpiredError,
  createApiClient,
  type FetchLike,
} from '../client';
import type { StoredTokens, TokenStore } from '../../auth/tokenStore';

const USER: StoredTokens['user'] = { id: 'u1', phone: '13800008000' };

interface RecordedCall {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeTokens(initial?: StoredTokens | null) {
  let cached: StoredTokens | null = initial ?? null;
  const saved: StoredTokens[] = [];
  let clearCount = 0;
  const store: Pick<
    TokenStore,
    'getCached' | 'save' | 'updateAccessToken' | 'clear' | 'load'
  > = {
    getCached: () => cached,
    load: async () => cached,
    save: async (tokens) => {
      cached = tokens;
      saved.push(tokens);
    },
    updateAccessToken: async (accessToken) => {
      if (cached) cached = { ...cached, accessToken };
    },
    clear: async () => {
      cached = null;
      clearCount += 1;
    },
  };
  return {
    store,
    saved,
    getCleared: () => clearCount,
    get cached() {
      return cached;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

class FetchScript {
  calls: RecordedCall[] = [];
  constructor(
    private readonly handler: (call: RecordedCall) => Response | Promise<Response>,
  ) {}

  fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const path = url.startsWith('http') ? url.slice(url.indexOf('/', 8)) : url;
    const call: RecordedCall = {
      path,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    this.calls.push(call);
    return this.handler(call);
  };

  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((call) => call.path === path);
  }
}

function makeClient(script: FetchScript, tokens: ReturnType<typeof makeTokens>) {
  return createApiClient({
    tokens: tokens.store,
    fetch: script.fetch,
    baseUrl: 'http://admin.test',
    timeoutMs: 2_000,
  });
}

describe('api client', () => {
  test('401 -> refresh rotation -> replay once succeeds with new token', async () => {
    const tokens = makeTokens({
      accessToken: 'at1',
      refreshToken: 'rt1',
      user: USER,
    });
    const script = new FetchScript((call) => {
      if (call.path === '/api/auth/refresh') {
        return jsonResponse({ accessToken: 'at2', refreshToken: 'rt2', expiresIn: 604_800 });
      }
      const auth = call.headers.Authorization;
      if (auth === 'Bearer at1') return jsonResponse({ errorCode: 'TOKEN_REVOKED' }, 401);
      if (auth === 'Bearer at2') return jsonResponse({ ok: true, me: 'u1' });
      return jsonResponse({ errorCode: 'UNAUTHORIZED' }, 401);
    });
    const client = makeClient(script, tokens);

    const result = await client.get<{ ok: boolean; me: string }>('/api/me');

    expect(result).toEqual({ ok: true, me: 'u1' });
    const refreshCalls = script.callsTo('/api/auth/refresh');
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]?.body).toEqual({ refreshToken: 'rt1' });
    expect(refreshCalls[0]?.headers.Authorization).toBeUndefined();
    // rotated tokens persisted
    expect(tokens.saved).toHaveLength(1);
    expect(tokens.cached?.accessToken).toBe('at2');
    expect(tokens.cached?.refreshToken).toBe('rt2');
    // original request replayed exactly once with the fresh token
    const meCalls = script.callsTo('/api/me');
    expect(meCalls).toHaveLength(2);
    expect(meCalls[0]?.headers.Authorization).toBe('Bearer at1');
    expect(meCalls[1]?.headers.Authorization).toBe('Bearer at2');
  });

  test('refresh rejection clears tokens and notifies auth-expired listeners', async () => {
    const tokens = makeTokens({
      accessToken: 'at1',
      refreshToken: 'rt-stale',
      user: USER,
    });
    const script = new FetchScript((call) => {
      if (call.path === '/api/auth/refresh') return jsonResponse({ errorCode: 'TOKEN_REVOKED' }, 401);
      return jsonResponse({ errorCode: 'TOKEN_REVOKED' }, 401);
    });
    const client = makeClient(script, tokens);
    let expired = 0;
    client.onAuthExpired(() => {
      expired += 1;
    });

    await expect(client.get('/api/me')).rejects.toBeInstanceOf(AuthExpiredError);
    expect(tokens.getCleared()).toBe(1);
    expect(expired).toBe(1);
  });

  test('concurrent 401s share a single refresh (single flight)', async () => {
    const tokens = makeTokens({
      accessToken: 'at1',
      refreshToken: 'rt1',
      user: USER,
    });
    let refreshCount = 0;
    const script = new FetchScript(async (call) => {
      if (call.path === '/api/auth/refresh') {
        refreshCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({ accessToken: 'at2', refreshToken: 'rt2', expiresIn: 60 });
      }
      if (call.headers.Authorization === 'Bearer at2') return jsonResponse({ ok: true });
      return jsonResponse({ errorCode: 'TOKEN_EXPIRED' }, 401);
    });
    const client = makeClient(script, tokens);

    const [a, b] = await Promise.all([
      client.get<{ ok: boolean }>('/api/session'),
      client.get<{ ok: boolean }>('/api/profile'),
    ]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(refreshCount).toBe(1);
  });

  test('concurrent 401s with a failing refresh clear/notify exactly once', async () => {
    const tokens = makeTokens({
      accessToken: 'at1',
      refreshToken: 'rt1',
      user: USER,
    });
    let refreshCount = 0;
    const script = new FetchScript(async (call) => {
      if (call.path === '/api/auth/refresh') {
        refreshCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({ errorCode: 'TOKEN_REVOKED' }, 401);
      }
      return jsonResponse({ errorCode: 'TOKEN_EXPIRED' }, 401);
    });
    const client = makeClient(script, tokens);
    let expired = 0;
    client.onAuthExpired(() => {
      expired += 1;
    });

    const results = await Promise.allSettled([
      client.get('/api/session'),
      client.get('/api/profile'),
    ]);

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(refreshCount).toBe(1);
    expect(tokens.getCleared()).toBe(1);
    expect(expired).toBe(1);
  });

  test('refresh failure does not wipe a session that re-logged in mid-flight', async () => {
    const tokens = makeTokens({
      accessToken: 'at1',
      refreshToken: 'rt1',
      user: USER,
    });
    const script = new FetchScript(async (call) => {
      if (call.path === '/api/auth/refresh') {
        // A full phone re-login lands while the stale refresh is in flight.
        await tokens.store.save({
          accessToken: 'at-fresh',
          refreshToken: 'rt-fresh',
          user: USER,
        });
        return jsonResponse({ errorCode: 'TOKEN_REVOKED' }, 401);
      }
      return jsonResponse({ errorCode: 'TOKEN_REVOKED' }, 401);
    });
    const client = makeClient(script, tokens);
    let expired = 0;
    client.onAuthExpired(() => {
      expired += 1;
    });

    await expect(client.get('/api/me')).rejects.toBeInstanceOf(AuthExpiredError);
    // The fresh session survives: no clear, no auth-expired broadcast.
    expect(tokens.getCleared()).toBe(0);
    expect(expired).toBe(0);
    expect(tokens.cached?.accessToken).toBe('at-fresh');
    expect(tokens.cached?.refreshToken).toBe('rt-fresh');
  });

  test('concurrent replays that still 401 clear/notify exactly once and never re-refresh', async () => {
    const tokens = makeTokens({
      accessToken: 'at1',
      refreshToken: 'rt1',
      user: USER,
    });
    let refreshCount = 0;
    const script = new FetchScript(async (call) => {
      if (call.path === '/api/auth/refresh') {
        refreshCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return jsonResponse({ accessToken: 'at2', refreshToken: 'rt2', expiresIn: 60 });
      }
      // Even the rotated token is rejected (session revoked server-side).
      return jsonResponse({ errorCode: 'TOKEN_REVOKED' }, 401);
    });
    const client = makeClient(script, tokens);
    let expired = 0;
    client.onAuthExpired(() => {
      expired += 1;
    });

    const results = await Promise.allSettled([
      client.get('/api/session'),
      client.get('/api/profile'),
    ]);

    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof AuthExpiredError)).toBe(true);
    expect(refreshCount).toBe(1); // replay never triggers a second refresh
    expect(tokens.getCleared()).toBe(1);
    expect(expired).toBe(1);
  });

  test('replay still 401 after a mid-flight re-login keeps the fresh session', async () => {
    const tokens = makeTokens({
      accessToken: 'at1',
      refreshToken: 'rt1',
      user: USER,
    });
    const script = new FetchScript(async (call) => {
      if (call.path === '/api/auth/refresh') {
        return jsonResponse({ accessToken: 'at2', refreshToken: 'rt2', expiresIn: 60 });
      }
      if (call.headers.Authorization === 'Bearer at2') {
        // While the replay is out, the user completes a fresh phone login.
        await tokens.store.save({
          accessToken: 'at-fresh',
          refreshToken: 'rt-fresh',
          user: USER,
        });
        return jsonResponse({ errorCode: 'TOKEN_REVOKED' }, 401);
      }
      return jsonResponse({ errorCode: 'TOKEN_REVOKED' }, 401);
    });
    const client = makeClient(script, tokens);
    let expired = 0;
    client.onAuthExpired(() => {
      expired += 1;
    });

    await expect(client.get('/api/me')).rejects.toBeInstanceOf(AuthExpiredError);
    expect(tokens.getCleared()).toBe(0);
    expect(expired).toBe(0);
    expect(tokens.cached?.accessToken).toBe('at-fresh');
  });

  test('admin error codes pass through: rate limit carries retryAfter', async () => {
    const tokens = makeTokens();
    const script = new FetchScript(() =>
      jsonResponse(
        { errorCode: 'sms_rate_limited', message: 'too many', retryAfter: 58 },
        429,
      ),
    );
    const client = makeClient(script, tokens);

    const error = await client.post('/api/auth/phone/send-code', { phone: '13800008000' }, { auth: false })
      .then(() => null)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.errorCode).toBe('sms_rate_limited');
    expect(apiError.status).toBe(429);
    expect(apiError.retryAfterSeconds).toBe(58);
  });

  test('verification errors pass through with remaining attempts when provided', async () => {
    const tokens = makeTokens();
    const script = new FetchScript(() =>
      jsonResponse(
        { errorCode: 'verification_code_invalid', attemptsRemaining: 4 },
        400,
      ),
    );
    const client = makeClient(script, tokens);

    const error = await client.post('/api/auth/phone/verify', { phone: '13800008000', code: '826410' }, { auth: false })
      .then(() => null)
      .catch((caught: unknown) => caught);

    const apiError = error as ApiError;
    expect(apiError).toBeInstanceOf(ApiError);
    expect(apiError.errorCode).toBe('verification_code_invalid');
    expect(apiError.attemptsRemaining).toBe(4);
  });

  test('replay that still 401s raises AuthExpiredError and clears state', async () => {
    const tokens = makeTokens({
      accessToken: 'at1',
      refreshToken: 'rt1',
      user: USER,
    });
    const script = new FetchScript((call) => {
      if (call.path === '/api/auth/refresh') {
        return jsonResponse({ accessToken: 'at2', refreshToken: 'rt2', expiresIn: 60 });
      }
      return jsonResponse({ errorCode: 'UNAUTHORIZED' }, 401);
    });
    const client = makeClient(script, tokens);
    let expired = 0;
    client.onAuthExpired(() => {
      expired += 1;
    });

    await expect(client.get('/api/me')).rejects.toBeInstanceOf(AuthExpiredError);
    expect(tokens.getCleared()).toBe(1);
    expect(expired).toBe(1);
    expect(script.callsTo('/api/me')).toHaveLength(2); // replayed once, then gave up
  });

  test('auth-less requests carry no Authorization header', async () => {
    const tokens = makeTokens({
      accessToken: 'at1',
      refreshToken: 'rt1',
      user: USER,
    });
    const script = new FetchScript(() => jsonResponse({ accepted: true, expiresIn: 300, resendAfter: 60 }));
    const client = makeClient(script, tokens);

    await client.post('/api/auth/phone/send-code', { phone: '13800008000' }, { auth: false });

    const call = script.callsTo('/api/auth/phone/send-code')[0];
    expect(call?.headers.Authorization).toBeUndefined();
  });

  test('missing credentials fail fast with AuthExpiredError (no request)', async () => {
    const tokens = makeTokens(null);
    const script = new FetchScript(() => jsonResponse({ ok: true }));
    const client = makeClient(script, tokens);

    await expect(client.get('/api/me')).rejects.toBeInstanceOf(AuthExpiredError);
    expect(script.calls).toHaveLength(0);
  });
});

// POL-15 regression: qr confirm/reject return *business* 401s
// (qr_login_expired / invalid_credentials). These must surface verbatim as
// ApiError without entering the refresh chain or wiping the session — the
// credential is fine, only the ticket is dead. Admin emits these codes
// lowercase ({ error: 'qr_login_expired' }); the client reads the `error` key.
describe('api client — business 401 codes skip refresh (POL-15)', () => {
  test.each(['qr_login_expired', 'invalid_credentials'])(
    '401 %s -> ApiError verbatim, no refresh, no wipe',
    async (code) => {
      const tokens = makeTokens({ accessToken: 'at1', refreshToken: 'rt1', user: USER });
      const script = new FetchScript(() => jsonResponse({ error: code, message: 'nope' }, 401));
      const client = makeClient(script, tokens);
      let expired = 0;
      client.onAuthExpired(() => {
        expired += 1;
      });

      await expect(
        client.post('/api/auth/qr/confirm', { qrId: 'q', secret: 's', action: 'confirm' }),
      ).rejects.toMatchObject({ name: 'ApiError', errorCode: code, status: 401 });

      expect(script.callsTo('/api/auth/refresh')).toHaveLength(0);
      expect(script.callsTo('/api/auth/qr/confirm')).toHaveLength(1); // no replay
      expect(tokens.getCleared()).toBe(0);
      expect(expired).toBe(0);
      expect(tokens.cached?.accessToken).toBe('at1');
    },
  );

  test('replay 401 that turned into a business code keeps the session', async () => {
    const tokens = makeTokens({ accessToken: 'at1', refreshToken: 'rt1', user: USER });
    const script = new FetchScript(({ path, headers }) => {
      if (path === '/api/auth/refresh') {
        return jsonResponse({ accessToken: 'at2', refreshToken: 'rt2', expiresIn: 60 });
      }
      if (headers.Authorization === 'Bearer at1') {
        return jsonResponse({ error: 'unauthorized', message: 'stale' }, 401);
      }
      return jsonResponse({ error: 'qr_login_expired', message: 'ticket gone' }, 401);
    });
    const client = makeClient(script, tokens);
    let expired = 0;
    client.onAuthExpired(() => {
      expired += 1;
    });

    await expect(client.get('/api/auth/qr/status-locked')).rejects.toMatchObject({
      name: 'ApiError',
      errorCode: 'qr_login_expired',
    });
    expect(tokens.getCleared()).toBe(0);
    expect(expired).toBe(0);
  });

  test("admin's lowercase 'unauthorized' still drives the refresh chain", async () => {
    const tokens = makeTokens({ accessToken: 'at1', refreshToken: 'rt1', user: USER });
    const script = new FetchScript(({ headers }) => {
      if (headers.Authorization === 'Bearer at1') {
        return jsonResponse({ error: 'unauthorized', message: 'stale' }, 401);
      }
      if (headers.Authorization === 'Bearer at2') return jsonResponse({ ok: true });
      return jsonResponse({ accessToken: 'at2', refreshToken: 'rt2', expiresIn: 60 });
    });
    const client = makeClient(script, tokens);

    await expect(client.get('/api/me')).resolves.toEqual({ ok: true });
    expect(script.callsTo('/api/auth/refresh')).toHaveLength(1);
    expect(tokens.cached?.accessToken).toBe('at2');
  });
});
