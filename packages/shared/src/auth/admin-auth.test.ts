import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  AccountDisabledError,
  AdminApiClient,
  ConfigError,
  InvalidCredentialsError,
  NetworkError,
  RateLimitedError,
  TokenRevokedError,
  createAdminApiClient,
} from './admin-auth.ts';
import type { FetchFn } from './admin-auth.ts';

const SAMPLE_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sample';
const SAMPLE_USER = {
  id: 'usr_abc123',
  username: 'zhangsan',
  displayName: '张三',
  role: 'user',
  groupIds: ['grp_dev'],
};

const SAMPLE_CONNECTIONS_RESPONSE = {
  configVersion: 'cv_llm_001',
  connections: [
    {
      slug: 'anthropic-prod',
      name: 'Anthropic Production',
      providerType: 'anthropic',
      authType: 'api_key',
      encryptedCredentials: 'vault:v1:ciphertext',
      models: ['claude-sonnet-4-6'],
      defaultModel: 'claude-sonnet-4-6',
    },
  ],
  defaultConnection: 'anthropic-prod',
};

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function mockFetch(status: number, body: unknown, headers?: Record<string, string>): FetchFn {
  return async () => jsonResponse(status, body, headers);
}

function failingFetch(error: Error): FetchFn {
  return async () => {
    throw error;
  };
}

const ORIGINAL_POLO_ADMIN_API_URL = process.env.POLO_ADMIN_API_URL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

beforeEach(() => {
  process.env.POLO_ADMIN_API_URL = 'http://localhost:3001';
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  if (ORIGINAL_POLO_ADMIN_API_URL === undefined) {
    delete process.env.POLO_ADMIN_API_URL;
  } else {
    process.env.POLO_ADMIN_API_URL = ORIGINAL_POLO_ADMIN_API_URL;
  }

  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
});

describe('AdminApiClient auth login', () => {
  it('login("zhangsan", "correct_password") returns token and user', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(200, { token: SAMPLE_JWT, user: SAMPLE_USER }),
    });

    await expect(client.login('zhangsan', 'correct_password')).resolves.toEqual({
      token: SAMPLE_JWT,
      user: SAMPLE_USER,
    });
  });

  it('login sends POST /api/auth/login with JSON credentials and no client-side validation', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedContentType: string | undefined;
    let capturedBody: unknown;

    const fetchSpy: FetchFn = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedMethod = init?.method;
      capturedContentType = (init?.headers as Record<string, string>)?.['Content-Type'];
      capturedBody = JSON.parse(init?.body as string);
      return jsonResponse(200, { token: SAMPLE_JWT, user: SAMPLE_USER });
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy });

    await client.login('', 'password');
    expect(capturedBody).toEqual({ username: '', password: 'password' });

    await client.login('user', '');
    expect(capturedUrl).toBe('http://localhost:3001/api/auth/login');
    expect(capturedMethod).toBe('POST');
    expect(capturedContentType).toBe('application/json');
    expect(capturedBody).toEqual({ username: 'user', password: '' });
  });

  it('login invalid credentials throws InvalidCredentialsError with server message', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(401, { error: 'invalid_credentials', message: '用户名或密码错误' }),
    });

    await expect(client.login('zhangsan', 'wrong_password')).rejects.toThrow(InvalidCredentialsError);
    await expect(client.login('zhangsan', 'wrong_password')).rejects.toThrow('用户名或密码错误');
  });

  it('login disabled user throws AccountDisabledError with server message', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(403, { error: 'account_disabled', message: '账号已禁用' }),
    });

    await expect(client.login('disabled_user', 'any')).rejects.toThrow(AccountDisabledError);
    await expect(client.login('disabled_user', 'any')).rejects.toThrow('禁用');
  });

  it('login rate limited throws RateLimitedError with Retry-After seconds', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(
        429,
        { error: 'rate_limited', message: 'Too many attempts' },
        { 'Retry-After': '42' },
      ),
    });

    let caught: RateLimitedError | undefined;
    try {
      await client.login('any', 'any');
    } catch (error) {
      caught = error as RateLimitedError;
    }

    expect(caught).toBeInstanceOf(RateLimitedError);
    expect(caught?.retryAfterSeconds).toBe(42);
  });

  it('login when Admin API is unreachable throws NetworkError', async () => {
    const client = createAdminApiClient({
      fetchFn: failingFetch(new TypeError('Failed to fetch')),
    });

    await expect(client.login('any', 'any')).rejects.toThrow(NetworkError);
  });
});

describe('AdminApiClient auth logout', () => {
  it('logout with valid token sends POST /api/auth/logout and returns void', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedAuthHeader: string | undefined;

    const fetchSpy: FetchFn = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedMethod = init?.method;
      capturedAuthHeader = (init?.headers as Record<string, string>)?.Authorization;
      return jsonResponse(200, { success: true });
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy, token: SAMPLE_JWT });

    await expect(client.logout()).resolves.toBeUndefined();
    expect(capturedUrl).toBe('http://localhost:3001/api/auth/logout');
    expect(capturedMethod).toBe('POST');
    expect(capturedAuthHeader).toBe(`Bearer ${SAMPLE_JWT}`);
  });

  it('logout when network fails throws NetworkError', async () => {
    const client = createAdminApiClient({
      fetchFn: failingFetch(new TypeError('Network down')),
      token: SAMPLE_JWT,
    });

    await expect(client.logout()).rejects.toThrow(NetworkError);
  });
});

describe('AdminApiClient auth validateToken', () => {
  it('validateToken with valid token returns valid user and config version', async () => {
    const response = { valid: true, user: SAMPLE_USER, configVersion: 'cv_auth_001' } as const;
    const client = createAdminApiClient({
      fetchFn: mockFetch(200, response),
      token: SAMPLE_JWT,
    });

    await expect(client.validateToken()).resolves.toEqual(response);
  });

  it('validateToken sends POST /api/auth/validate with Bearer token', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedAuthHeader: string | undefined;

    const fetchSpy: FetchFn = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedMethod = init?.method;
      capturedAuthHeader = (init?.headers as Record<string, string>)?.Authorization;
      return jsonResponse(200, { valid: true, user: SAMPLE_USER, configVersion: 'cv_auth_001' });
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy, token: SAMPLE_JWT });
    await client.validateToken();

    expect(capturedUrl).toBe('http://localhost:3001/api/auth/validate');
    expect(capturedMethod).toBe('POST');
    expect(capturedAuthHeader).toBe(`Bearer ${SAMPLE_JWT}`);
  });

  it('validateToken with revoked token throws TokenRevokedError', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(401, { error: 'token_revoked', message: 'Token revoked' }),
      token: SAMPLE_JWT,
    });

    await expect(client.validateToken()).rejects.toThrow(TokenRevokedError);
  });

  it('validateToken when Admin API is unreachable throws NetworkError', async () => {
    const client = createAdminApiClient({
      fetchFn: failingFetch(new TypeError('DNS lookup failed')),
      token: SAMPLE_JWT,
    });

    await expect(client.validateToken()).rejects.toThrow(NetworkError);
  });

  it('validateToken fails when connect/header phase exceeds its configured timeout', async () => {
    let connectStarted = false;
    let abortReason: unknown;
    const slowFetch: FetchFn = async (_input, init) => {
      connectStarted = true;
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          abortReason = init.signal?.reason;
          reject(init.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    };
    const client = createAdminApiClient({
      fetchFn: slowFetch,
      token: SAMPLE_JWT,
      // Production defaults are 5s connect/header + 5s read; shorten the same phases for CI speed.
      validateConnectTimeoutMs: 25,
      validateReadTimeoutMs: 1_000,
    });

    await expect(client.validateToken()).rejects.toThrow(NetworkError);
    expect(connectStarted).toBe(true);
    expect(abortReason).toBeInstanceOf(NetworkError);
  }, 1000);

  it('validateToken fails when body/read phase exceeds its configured timeout after headers', async () => {
    let headersReturned = false;
    let bodyReadStarted = false;

    const slowBodyFetch: FetchFn = async () => {
      headersReturned = true;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Type': 'application/json' }),
        json: async () => {
          bodyReadStarted = true;
          return new Promise(resolve => {
            setTimeout(() => {
              resolve({ valid: true, user: SAMPLE_USER, configVersion: 'cv_auth_001' });
            }, 1_000);
          });
        },
      } as Response;
    };

    const client = createAdminApiClient({
      fetchFn: slowBodyFetch,
      token: SAMPLE_JWT,
      // Production defaults are 5s connect/header + 5s read; shorten the same phases for CI speed.
      validateConnectTimeoutMs: 1_000,
      validateReadTimeoutMs: 25,
    });

    await expect(client.validateToken()).rejects.toThrow(NetworkError);
    expect(headersReturned).toBe(true);
    expect(bodyReadStarted).toBe(true);
  }, 1000);

  it('validateToken when rate limited throws RateLimitedError with Retry-After seconds', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(429, { error: 'rate_limited', message: 'Try later' }, { 'Retry-After': '7' }),
      token: SAMPLE_JWT,
    });

    let caught: RateLimitedError | undefined;
    try {
      await client.validateToken();
    } catch (error) {
      caught = error as RateLimitedError;
    }

    expect(caught).toBeInstanceOf(RateLimitedError);
    expect(caught?.retryAfterSeconds).toBe(7);
  });
});

describe('AdminApiClient auth getLlmConnections', () => {
  it('getLlmConnections with valid token returns config connections', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(200, SAMPLE_CONNECTIONS_RESPONSE),
      token: SAMPLE_JWT,
    });

    await expect(client.getLlmConnections()).resolves.toEqual(SAMPLE_CONNECTIONS_RESPONSE);
  });

  it('getLlmConnections sends GET /api/llm-connections with Bearer token', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedAuthHeader: string | undefined;

    const fetchSpy: FetchFn = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      capturedMethod = init?.method;
      capturedAuthHeader = (init?.headers as Record<string, string>)?.Authorization;
      return jsonResponse(200, SAMPLE_CONNECTIONS_RESPONSE);
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy, token: SAMPLE_JWT });
    await client.getLlmConnections();

    expect(capturedUrl).toBe('http://localhost:3001/api/llm-connections');
    expect(capturedMethod).toBe('GET');
    expect(capturedAuthHeader).toBe(`Bearer ${SAMPLE_JWT}`);
  });

  it('getLlmConnections with revoked token throws TokenRevokedError', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(401, { error: 'token_revoked', message: 'Token revoked' }),
      token: SAMPLE_JWT,
    });

    await expect(client.getLlmConnections()).rejects.toThrow(TokenRevokedError);
  });

  it('getLlmConnections returns empty connections array and null default', async () => {
    const response = { configVersion: 'cv_empty', connections: [], defaultConnection: null };
    const client = createAdminApiClient({
      fetchFn: mockFetch(200, response),
      token: SAMPLE_JWT,
    });

    await expect(client.getLlmConnections()).resolves.toEqual(response);
  });

  it('getLlmConnections when Admin API is unreachable throws NetworkError', async () => {
    const client = createAdminApiClient({
      fetchFn: failingFetch(new TypeError('Connection refused')),
      token: SAMPLE_JWT,
    });

    await expect(client.getLlmConnections()).rejects.toThrow(NetworkError);
  });

  it('getLlmConnections when rate limited throws RateLimitedError with retryAfterSeconds', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(429, { error: 'rate_limited', message: 'Try later' }, { 'Retry-After': '12' }),
      token: SAMPLE_JWT,
    });

    let caught: RateLimitedError | undefined;
    try {
      await client.getLlmConnections();
    } catch (error) {
      caught = error as RateLimitedError;
    }

    expect(caught).toBeInstanceOf(RateLimitedError);
    expect(caught?.retryAfterSeconds).toBe(12);
  });
});

describe('AdminApiClient auth error envelope preservation', () => {
  it('typed error preserves error, message, details, requestId fields', async () => {
    const envelope = {
      error: 'invalid_credentials',
      message: '用户名或密码错误',
      details: { attemptCount: 3 },
      requestId: 'req_auth_123',
    };
    const client = createAdminApiClient({ fetchFn: mockFetch(401, envelope) });

    let caught: InvalidCredentialsError | undefined;
    try {
      await client.login('zhangsan', 'wrong_password');
    } catch (error) {
      caught = error as InvalidCredentialsError;
    }

    expect(caught).toBeInstanceOf(InvalidCredentialsError);
    expect(caught?.error).toBe('invalid_credentials');
    expect(caught?.message).toBe('用户名或密码错误');
    expect(caught?.details).toEqual({ attemptCount: 3 });
    expect(caught?.requestId).toBe('req_auth_123');
  });

  it('typed error handles missing optional details and requestId', async () => {
    const client = createAdminApiClient({
      fetchFn: mockFetch(401, { error: 'invalid_credentials', message: '用户名或密码错误' }),
    });

    let caught: InvalidCredentialsError | undefined;
    try {
      await client.login('zhangsan', 'wrong_password');
    } catch (error) {
      caught = error as InvalidCredentialsError;
    }

    expect(caught).toBeInstanceOf(InvalidCredentialsError);
    expect(caught?.details).toBeUndefined();
    expect(caught?.requestId).toBeUndefined();
  });
});

describe('AdminApiClient auth HTTPS enforcement', () => {
  it('constructed with http:// URL in production throws ConfigError', () => {
    process.env.NODE_ENV = 'production';
    process.env.POLO_ADMIN_API_URL = 'http://admin.example.com';

    expect(() => new AdminApiClient()).toThrow(ConfigError);
  });

  it('constructed with https:// URL works normally', async () => {
    process.env.NODE_ENV = 'production';
    process.env.POLO_ADMIN_API_URL = 'https://admin.example.com/';
    let capturedUrl: string | undefined;
    const fetchSpy: FetchFn = async (input) => {
      capturedUrl = typeof input === 'string' ? input : input.toString();
      return jsonResponse(200, { token: SAMPLE_JWT, user: SAMPLE_USER });
    };

    const client = new AdminApiClient({ fetchFn: fetchSpy });

    await expect(client.login('zhangsan', 'correct_password')).resolves.toEqual({
      token: SAMPLE_JWT,
      user: SAMPLE_USER,
    });
    expect(capturedUrl).toBe('https://admin.example.com/api/auth/login');
  });
});
