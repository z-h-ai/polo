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
      identifier: 'admin',
      password: 'secret',
    }));
  });

  it('returns only the supported auth config field', async () => {
    mockJsonFetch({
      phoneAuthEnabled: true,
      selfRegistrationEnabled: true,
      internalProvider: 'must-not-leak',
    });

    const client = new AdminClient('https://admin.example.com');
    const result = await client.getAuthConfig();

    expect(result).toEqual({ phoneAuthEnabled: true });
    expect(fetchCalls[0]!.url).toBe('https://admin.example.com/api/auth/config');
    expect(fetchCalls[0]!.init.method).toBe('GET');
  });

  it('discovers the public browser redirect challenge contract', async () => {
    mockJsonFetch({
      type: 'browser_redirect',
      issuerUrl: 'https://challenge.example.com/phone-auth',
      verifierUrl: 'https://secret.example.com/must-not-leak',
    });

    const client = new AdminClient('https://admin.example.com');
    const result = await client.getPhoneAuthChallengeConfig();

    expect(result).toEqual({
      type: 'browser_redirect',
      issuerUrl: 'https://challenge.example.com/phone-auth',
    });
    expect(fetchCalls[0]!.url).toBe(
      'https://admin.example.com/api/auth/phone/challenge/config',
    );
    expect(fetchCalls[0]!.init.method).toBe('GET');
  });

  it('fails closed when the challenge discovery payload is invalid', async () => {
    mockJsonFetch({
      type: 'unknown',
      issuerUrl: 'https://challenge.example.com/phone-auth',
    });

    const client = new AdminClient('https://admin.example.com');

    await expect(client.getPhoneAuthChallengeConfig()).rejects.toMatchObject({
      errorCode: 'phone_auth_configuration_error',
    });
  });

  it('sends phone code input and returns stable timing fields', async () => {
    mockJsonFetch({
      accepted: true,
      expiresIn: 300,
      resendAfter: 60,
      providerRequestId: 'must-not-leak',
    });

    const client = new AdminClient('https://admin.example.com');
    const result = await client.sendPhoneAuthCode({
      phone: '13800138000',
      challengeToken: 'verified-challenge',
    });

    expect(result).toEqual({ accepted: true, expiresIn: 300, resendAfter: 60 });
    expect(fetchCalls[0]!.init.body).toBe(JSON.stringify({
      phone: '13800138000',
      challengeToken: 'verified-challenge',
    }));
  });

  it('verifies a phone code without returning server-only fields', async () => {
    const response = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      user: {
        id: 'user-1',
        username: 'phone_user',
        displayName: null,
        role: 'user',
        groupIds: [],
        phone: '13800138000',
        internalSecret: 'must-not-leak',
        profile: {
          internalSecret: 'nested-must-not-leak',
        },
      },
      isNewUser: true,
      internalGrant: 'must-not-leak',
    };
    mockJsonFetch(response);

    const client = new AdminClient('https://admin.example.com');
    const result = await client.verifyPhoneAuthCode({
      phone: '13800138000',
      code: '123456',
    });

    expect(result).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      user: {
        id: 'user-1',
        username: 'phone_user',
        displayName: null,
        role: 'user',
        groupIds: [],
      },
      isNewUser: true,
    });
    expect(JSON.stringify(result)).not.toContain('13800138000');
    expect(JSON.stringify(result)).not.toContain('internalSecret');
  });

  it('rejects malformed Admin users at the response boundary', async () => {
    mockJsonFetch({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      user: {
        id: 'user-1',
        username: 'phone_user',
        displayName: null,
        role: 'user',
        groupIds: 'not-an-array',
      },
      isNewUser: false,
    });

    const client = new AdminClient('https://admin.example.com');

    await expect(client.verifyPhoneAuthCode({
      phone: '13800138000',
      code: '123456',
    })).rejects.toMatchObject({
      errorCode: 'SERVER_ERROR',
      message: 'Admin response user is invalid',
    });
  });

  it('sets a password with bearer auth', async () => {
    mockJsonFetch({ success: true, authorizationChanged: true });

    const client = new AdminClient('https://admin.example.com');
    const result = await client.setPassword('access-token', { password: 'password-123' });

    expect(result).toEqual({ success: true });
    expect(fetchCalls[0]!.url).toBe('https://admin.example.com/api/auth/password');
    expect(fetchCalls[0]!.init.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
    });
    expect(fetchCalls[0]!.init.body).toBe(JSON.stringify({ password: 'password-123' }));
  });

  it('keeps only retryAfter from stable phone auth errors', async () => {
    mockJsonFetch({
      error: 'sms_rate_limited',
      message: 'sms_rate_limited',
      details: { retryAfter: 31.2 },
      providerSecret: 'must-not-leak',
    }, 429);

    const client = new AdminClient('https://admin.example.com');

    await expect(client.sendPhoneAuthCode({
      phone: '13800138000',
      challengeToken: 'verified-challenge',
    })).rejects.toMatchObject({
      errorCode: 'sms_rate_limited',
      status: 429,
      details: { retryAfter: 32 },
    });
  });

  it('uses a safe message for provider and server failures', async () => {
    mockJsonFetch({
      error: 'sms_send_failed',
      message: 'provider secret and stack',
    }, 502);

    const client = new AdminClient('https://admin.example.com');

    await expect(client.sendPhoneAuthCode({
      phone: '13800138000',
      challengeToken: 'verified-challenge',
    })).rejects.toMatchObject({
      errorCode: 'sms_send_failed',
      message: 'Admin service is temporarily unavailable',
    });
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

  it('logs out with the current access token and no refresh-token body', async () => {
    mockJsonFetch({ success: true });

    const client = new AdminClient('https://admin.example.com');
    await client.logout('access-token');

    expect(fetchCalls[0]!.url).toBe('https://admin.example.com/api/auth/logout');
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

  it('never exposes unknown 4xx upstream messages, secrets, or stacks', async () => {
    mockJsonFetch({
      error: 'upstream_private_failure',
      message: 'AccessKeyId=LTAI-DO-NOT-LEAK',
      error_description: 'Error: private failure\\n    at /srv/admin/secret.ts:42',
      stack: 'private-stack',
    }, 418);

    const client = new AdminClient('https://admin.example.com');

    try {
      await client.login('admin', 'secret');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AdminError);
      expect(error).toMatchObject({
        errorCode: 'VALIDATION_ERROR',
        status: 418,
        message: 'Admin request was rejected',
      });
      const serialized = JSON.stringify({
        message: (error as AdminError).message,
        details: (error as AdminError).details,
      });
      expect(serialized).not.toContain('LTAI');
      expect(serialized).not.toContain('/srv/admin');
      expect(serialized).not.toContain('private-stack');
    }
  });

  it('uses a local generic message for non-JSON and 5xx responses', async () => {
    fetchCalls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      fetchCalls.push({ url, init: init ?? {} });
      return new Response(
        'AccessKeySecret=do-not-leak\\nError at /srv/private.ts:9',
        { status: 502, statusText: 'Private upstream exception' },
      );
    }) as typeof globalThis.fetch;

    const client = new AdminClient('https://admin.example.com');

    await expect(client.login('admin', 'secret')).rejects.toMatchObject({
      errorCode: 'SERVER_ERROR',
      status: 502,
      message: 'Admin service is temporarily unavailable',
    });
  });

  it('drops retryAfter values outside the stable numeric range', async () => {
    for (const retryAfter of [-1, 0, 86_401, '60', { seconds: 60 }]) {
      mockJsonFetch({
        error: 'sms_rate_limited',
        message: 'AccessKeyId=LTAI-DO-NOT-LEAK',
        retryAfter,
      }, 429);
      const client = new AdminClient('https://admin.example.com');

      try {
        await client.sendPhoneAuthCode({
          phone: '13800138000',
          challengeToken: 'verified-challenge',
        });
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(AdminError);
        expect((error as AdminError).details).toBeUndefined();
        expect((error as AdminError).message).toBe(
          'Phone authentication request was rate limited',
        );
      }
    }
  });

  it('normalizes lowercase admin auth errors used by polo-admin', async () => {
    mockJsonFetch({
      error: 'account_disabled',
      message: 'account_disabled',
    }, 403);

    const client = new AdminClient('https://admin.example.com');

    await expect(client.login('admin', 'secret')).rejects.toMatchObject({
      errorCode: 'ACCOUNT_DISABLED',
      status: 403,
    });
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
