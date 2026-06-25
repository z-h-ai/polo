import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AdminClient } from '../client.ts';
import { AdminError } from '../types.ts';

let originalFetch: typeof globalThis.fetch;
let fetchCalls: { url: string; init: RequestInit }[] = [];

function mockJsonFetch(responseBody: unknown, status = 200) {
  fetchCalls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    fetchCalls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

describe('AdminClient', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends login request as JSON', async () => {
    const response = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      user: {
        id: 'user-1',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        groupIds: ['group-1'],
      },
    };
    mockJsonFetch(response);

    const client = new AdminClient('https://admin.example.com/');
    const result = await client.login('admin', 'secret');

    expect(result).toEqual(response);
    expect(fetchCalls[0]!.url).toBe('https://admin.example.com/api/auth/login');
    expect(fetchCalls[0]!.init.method).toBe('POST');
    expect(fetchCalls[0]!.init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(fetchCalls[0]!.init.body).toBe(JSON.stringify({
      username: 'admin',
      password: 'secret',
    }));
  });

  it('sends refresh request as JSON', async () => {
    const response = {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 3600,
    };
    mockJsonFetch(response);

    const client = new AdminClient('https://admin.example.com');
    const result = await client.refresh('old-refresh-token');

    expect(result).toEqual(response);
    expect(fetchCalls[0]!.url).toBe('https://admin.example.com/api/auth/refresh');
    expect(fetchCalls[0]!.init.method).toBe('POST');
    expect(fetchCalls[0]!.init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
    expect(fetchCalls[0]!.init.body).toBe(JSON.stringify({
      refreshToken: 'old-refresh-token',
    }));
  });

  it('sends validate request with bearer access token', async () => {
    const response = {
      valid: true,
      configVersion: 'config-v1',
      user: {
        id: 'user-1',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        groupIds: [],
      },
    };
    mockJsonFetch(response);

    const client = new AdminClient('https://admin.example.com');
    const result = await client.validate('access-token');

    expect(result).toEqual(response);
    expect(fetchCalls[0]!.url).toBe('https://admin.example.com/api/auth/validate');
    expect(fetchCalls[0]!.init.method).toBe('POST');
    expect(fetchCalls[0]!.init.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer access-token',
    });
    expect(fetchCalls[0]!.init.body).toBeUndefined();
  });

  it('throws AdminError for server error responses', async () => {
    mockJsonFetch({
      errorCode: 'INVALID_CREDENTIALS',
      message: 'Invalid username or password',
    }, 401);

    const client = new AdminClient('https://admin.example.com');

    try {
      await client.login('admin', 'wrong');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminError);
      expect((error as AdminError).errorCode).toBe('INVALID_CREDENTIALS');
      expect((error as AdminError).status).toBe(401);
      expect((error as AdminError).message).toBe('Invalid username or password');
    }
  });

  it('refreshes tokens and retries once on authenticated 401 responses', async () => {
    fetchCalls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push({ url, init: init ?? {} });

      if (url.endsWith('/api/auth/validate') && fetchCalls.length === 1) {
        return new Response(JSON.stringify({ errorCode: 'TOKEN_EXPIRED', message: 'expired' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/api/auth/refresh')) {
        return new Response(JSON.stringify({
          accessToken: 'fresh-access-token',
          refreshToken: 'fresh-refresh-token',
          expiresIn: 3600,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        valid: true,
        configVersion: 'config-v2',
        user: {
          id: 'user-1',
          username: 'admin',
          displayName: 'Admin',
          role: 'admin',
          groupIds: [],
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const refreshedTokens: unknown[] = [];
    const client = new AdminClient('https://admin.example.com', {
      tokenStore: {
        getRefreshToken: () => 'old-refresh-token',
        onTokensRefreshed: tokens => {
          refreshedTokens.push(tokens);
        },
      },
    });

    const result = await client.validate('stale-access-token');

    expect(result.valid).toBe(true);
    expect(refreshedTokens).toEqual([{
      accessToken: 'fresh-access-token',
      refreshToken: 'fresh-refresh-token',
      expiresIn: 3600,
    }]);
    expect(fetchCalls.map(call => call.url)).toEqual([
      'https://admin.example.com/api/auth/validate',
      'https://admin.example.com/api/auth/refresh',
      'https://admin.example.com/api/auth/validate',
    ]);
    expect((fetchCalls[2]!.init.headers as Record<string, string>).Authorization).toBe('Bearer fresh-access-token');
  });
});
