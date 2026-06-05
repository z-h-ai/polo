import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AdminApiClient, createAdminApiClient } from '../client.ts';
import type { FetchFn } from '../client.ts';
import {
  AuthenticationError,
  AccountDisabledError,
  DuplicateRequestError,
  AdminApiError,
  AdminApiUnavailableError,
  AdminApiTimeoutError,
  ConfigurationError,
} from '../errors.ts';

// ─── helpers ────────────────────────────────────────────────────────────────

function mockFetch(status: number, body: unknown, delay = 0): FetchFn {
  return async (_input, _init) => {
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function failingFetch(error: Error): FetchFn {
  return async () => {
    throw error;
  };
}

// ─── env helpers ─────────────────────────────────────────────────────────────

const ORIGINAL_ADMIN_API_URL = process.env.ADMIN_API_URL;

beforeEach(() => {
  process.env.ADMIN_API_URL = 'http://localhost:3001';
});

afterEach(() => {
  if (ORIGINAL_ADMIN_API_URL === undefined) {
    delete process.env.ADMIN_API_URL;
  } else {
    process.env.ADMIN_API_URL = ORIGINAL_ADMIN_API_URL;
  }
});

// ─── AC5: Base URL config ────────────────────────────────────────────────────

describe('AC5: Base URL config', () => {
  it('reads ADMIN_API_URL from env var', async () => {
    process.env.ADMIN_API_URL = 'http://testhost:4000';
    let capturedUrl: string | undefined;
    const fetchSpy: FetchFn = async (input) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ allowed: true, remaining: 100, limit: 200, used: 100, period: 'monthly' }),
        { status: 200 },
      );
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy });
    await client.checkQuota('jwt-token');

    expect(capturedUrl).toStartWith('http://testhost:4000');
  });

  it('handles trailing slash in URL: http://host:3001/ → still works', async () => {
    process.env.ADMIN_API_URL = 'http://localhost:3001/';
    let capturedUrl: string | undefined;
    const fetchSpy: FetchFn = async (input) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(
        JSON.stringify({ allowed: true, remaining: 100, limit: 200, used: 100, period: 'monthly' }),
        { status: 200 },
      );
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy });
    await client.checkQuota('jwt-token');

    // Should not produce double-slash like http://localhost:3001//api/quota/check
    expect(capturedUrl).toBe('http://localhost:3001/api/quota/check');
  });

  it('missing ADMIN_API_URL → throws ConfigurationError on first call', async () => {
    delete process.env.ADMIN_API_URL;
    const client = createAdminApiClient({ fetchFn: mockFetch(200, {}) });

    await expect(client.checkQuota('jwt-token')).rejects.toBeInstanceOf(ConfigurationError);
  });
});

// ─── AC1: checkQuota ──────────────────────────────────────────────────────────

describe('AC1: checkQuota', () => {
  it('sends POST to {ADMIN_API_URL}/api/quota/check with Authorization: Bearer <jwt>', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedAuthHeader: string | undefined;

    const fetchSpy: FetchFn = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      capturedMethod = init?.method;
      capturedAuthHeader = (init?.headers as Record<string, string>)?.['Authorization'];
      return new Response(
        JSON.stringify({ allowed: true, remaining: 90, limit: 100, used: 10, period: 'monthly' }),
        { status: 200 },
      );
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy });
    await client.checkQuota('test-jwt-token');

    expect(capturedUrl).toBe('http://localhost:3001/api/quota/check');
    expect(capturedMethod).toBe('POST');
    expect(capturedAuthHeader).toBe('Bearer test-jwt-token');
  });

  it('returns QuotaCheckResult { allowed, remaining, limit, used, period }', async () => {
    const responseBody = { allowed: true, remaining: 90, limit: 100, used: 10, period: 'monthly' };
    const client = createAdminApiClient({ fetchFn: mockFetch(200, responseBody) });

    const result = await client.checkQuota('jwt-token');

    expect(result).toEqual({ allowed: true, remaining: 90, limit: 100, used: 10, period: 'monthly' });
  });

  it('3-second timeout — request aborted after 3s → throws AdminApiTimeoutError', async () => {
    // Simulate a slow fetch that would hang, but we use a tiny timeout override for test speed
    const slowFetch: FetchFn = async (_input, init) => {
      // Wait until the signal aborts
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    };

    const client = createAdminApiClient({ fetchFn: slowFetch, checkQuotaTimeoutMs: 50 });
    await expect(client.checkQuota('jwt-token')).rejects.toBeInstanceOf(AdminApiTimeoutError);
  }, 3000);
});

// ─── AC2: reportUsage ─────────────────────────────────────────────────────────

describe('AC2: reportUsage', () => {
  it('sends POST to {ADMIN_API_URL}/api/quota/usage with correct body', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedBody: unknown;

    const fetchSpy: FetchFn = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      capturedMethod = init?.method;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ recorded: true, totalUsed: 150, remaining: 50 }),
        { status: 200 },
      );
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy });
    const usage = {
      requestId: 'req-123',
      sessionId: 'sess-abc',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
    };
    await client.reportUsage('jwt-token', usage);

    expect(capturedUrl).toBe('http://localhost:3001/api/quota/usage');
    expect(capturedMethod).toBe('POST');
    expect(capturedBody).toEqual(usage);
  });

  it('body includes { requestId, sessionId, model, inputTokens, outputTokens }', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchSpy: FetchFn = async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ recorded: true, totalUsed: 150, remaining: 50 }),
        { status: 200 },
      );
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy });
    await client.reportUsage('jwt-token', {
      requestId: 'req-xyz',
      sessionId: 'sess-xyz',
      model: 'claude-opus-4',
      inputTokens: 200,
      outputTokens: 100,
    });

    expect(capturedBody).toHaveProperty('requestId');
    expect(capturedBody).toHaveProperty('sessionId');
    expect(capturedBody).toHaveProperty('model');
    expect(capturedBody).toHaveProperty('inputTokens');
    expect(capturedBody).toHaveProperty('outputTokens');
  });

  it('returns UsageReportResult { recorded, totalUsed, remaining }', async () => {
    const responseBody = { recorded: true, totalUsed: 150, remaining: 50 };
    const client = createAdminApiClient({ fetchFn: mockFetch(200, responseBody) });

    const result = await client.reportUsage('jwt-token', {
      requestId: 'req-1',
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 50,
    });

    expect(result).toEqual({ recorded: true, totalUsed: 150, remaining: 50 });
  });

  it('5-second timeout — request aborted after 5s → throws AdminApiTimeoutError', async () => {
    const slowFetch: FetchFn = async (_input, init) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    };

    const client = createAdminApiClient({ fetchFn: slowFetch, reportUsageTimeoutMs: 50 });
    await expect(
      client.reportUsage('jwt-token', {
        requestId: 'req-1',
        sessionId: 'sess-1',
        model: 'claude-sonnet-4-6',
        inputTokens: 10,
        outputTokens: 5,
      }),
    ).rejects.toBeInstanceOf(AdminApiTimeoutError);
  }, 3000);
});

// ─── AC3: getQuotaStatus ──────────────────────────────────────────────────────

describe('AC3: getQuotaStatus', () => {
  it('sends GET to {ADMIN_API_URL}/api/quota/status with Bearer header', async () => {
    let capturedUrl: string | undefined;
    let capturedMethod: string | undefined;
    let capturedAuthHeader: string | undefined;

    const fetchSpy: FetchFn = async (input, init) => {
      capturedUrl = typeof input === 'string' ? input : (input as URL).toString();
      capturedMethod = init?.method;
      capturedAuthHeader = (init?.headers as Record<string, string>)?.['Authorization'];
      return new Response(
        JSON.stringify({
          userId: 'user-1',
          period: 'monthly',
          limit: 100,
          used: 50,
          remaining: 50,
          usageBreakdown: [],
        }),
        { status: 200 },
      );
    };

    const client = createAdminApiClient({ fetchFn: fetchSpy });
    await client.getQuotaStatus('my-jwt');

    expect(capturedUrl).toBe('http://localhost:3001/api/quota/status');
    expect(capturedMethod).toBe('GET');
    expect(capturedAuthHeader).toBe('Bearer my-jwt');
  });

  it('returns QuotaStatus { userId, period, limit, used, remaining, usageBreakdown }', async () => {
    const responseBody = {
      userId: 'user-abc',
      period: 'monthly',
      limit: 1000,
      used: 400,
      remaining: 600,
      usageBreakdown: [{ model: 'claude-sonnet-4-6', tokens: 400 }],
    };
    const client = createAdminApiClient({ fetchFn: mockFetch(200, responseBody) });

    const result = await client.getQuotaStatus('jwt-token');

    expect(result).toEqual(responseBody);
  });
});

// ─── AC4: Error handling ──────────────────────────────────────────────────────

describe('AC4: Error handling', () => {
  it('HTTP 401 → throws AuthenticationError', async () => {
    const client = createAdminApiClient({ fetchFn: mockFetch(401, { error: 'Unauthorized' }) });
    await expect(client.checkQuota('bad-jwt')).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('HTTP 403 → throws AccountDisabledError', async () => {
    const client = createAdminApiClient({ fetchFn: mockFetch(403, { error: 'Forbidden' }) });
    await expect(client.checkQuota('jwt')).rejects.toBeInstanceOf(AccountDisabledError);
  });

  it('HTTP 409 (duplicate) → throws DuplicateRequestError', async () => {
    const client = createAdminApiClient({ fetchFn: mockFetch(409, { error: 'Conflict' }) });
    await expect(
      client.reportUsage('jwt', {
        requestId: 'dupe',
        sessionId: 'sess',
        model: 'claude-sonnet-4-6',
        inputTokens: 10,
        outputTokens: 5,
      }),
    ).rejects.toBeInstanceOf(DuplicateRequestError);
  });

  it('HTTP 500 → throws AdminApiError with status code', async () => {
    const client = createAdminApiClient({ fetchFn: mockFetch(500, { error: 'Internal Server Error' }) });
    let caught: AdminApiError | undefined;
    try {
      await client.checkQuota('jwt');
    } catch (e) {
      caught = e as AdminApiError;
    }
    expect(caught).toBeInstanceOf(AdminApiError);
    expect(caught?.statusCode).toBe(500);
  });

  it('Network error (fetch fails) → throws AdminApiUnavailableError', async () => {
    const client = createAdminApiClient({
      fetchFn: failingFetch(new TypeError('Failed to fetch')),
    });
    await expect(client.checkQuota('jwt')).rejects.toBeInstanceOf(AdminApiUnavailableError);
  });

  it('Timeout → throws AdminApiTimeoutError', async () => {
    const slowFetch: FetchFn = async (_input, init) => {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    };
    const client = createAdminApiClient({ fetchFn: slowFetch, checkQuotaTimeoutMs: 50 });
    await expect(client.checkQuota('jwt')).rejects.toBeInstanceOf(AdminApiTimeoutError);
  }, 3000);
});
