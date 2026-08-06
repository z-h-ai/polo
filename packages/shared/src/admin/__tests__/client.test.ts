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
      message: 'Admin response is invalid',
    });
  });

  it('rejects malformed phone auth success fields before returning credentials', async () => {
    const user = {
      id: 'user-1',
      username: 'phone_user',
      displayName: null,
      role: 'user',
      groupIds: [],
    };
    const invalidResponses = [
      {
        accessToken: { token: 'object-token' },
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        user,
        isNewUser: false,
      },
      {
        accessToken: 'access-token',
        refreshToken: null,
        expiresIn: 3600,
        user,
        isNewUser: false,
      },
      {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: -1,
        user,
        isNewUser: false,
      },
      {
        accessToken: 'x'.repeat(16_385),
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        user,
        isNewUser: false,
      },
      {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600,
        user,
        isNewUser: 'true',
      },
    ];

    for (const response of invalidResponses) {
      mockJsonFetch(response);
      const client = new AdminClient('https://admin.example.com');

      await expect(client.verifyPhoneAuthCode({
        phone: '13800138000',
        code: '123456',
      })).rejects.toMatchObject({
        errorCode: 'SERVER_ERROR',
        message: 'Admin response is invalid',
      });
    }
  });

  it('rejects malformed send-code timing fields', async () => {
    for (const response of [
      { accepted: true, expiresIn: '300', resendAfter: 60 },
      { accepted: true, expiresIn: 300, resendAfter: -1 },
      { accepted: 'true', expiresIn: 300, resendAfter: 60 },
    ]) {
      mockJsonFetch(response);
      const client = new AdminClient('https://admin.example.com');

      await expect(client.sendPhoneAuthCode({
        phone: '13800138000',
        challengeToken: 'verified-challenge',
      })).rejects.toMatchObject({
        errorCode: 'SERVER_ERROR',
        message: 'Admin response is invalid',
      });
    }
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

  it('applies strict session response validation to login and refresh', async () => {
    mockJsonFetch({
      accessToken: ' ',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
      user: {
        id: 'user-1',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        groupIds: [],
      },
    });
    const loginClient = new AdminClient('https://admin.example.com');
    await expect(loginClient.login('admin', 'secret')).rejects.toMatchObject({
      errorCode: 'SERVER_ERROR',
    });

    mockJsonFetch({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 31_536_001,
    });
    const refreshClient = new AdminClient('https://admin.example.com');
    await expect(refreshClient.refresh('old-refresh-token')).rejects.toMatchObject({
      errorCode: 'SERVER_ERROR',
    });
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

  it('strictly validates both validate response variants', async () => {
    mockJsonFetch({ valid: false, internalReason: 'must-not-leak' });
    const invalidSessionClient = new AdminClient('https://admin.example.com');
    expect(await invalidSessionClient.validate('access-token')).toEqual({
      valid: false,
    });

    mockJsonFetch({
      valid: true,
      configVersion: null,
      user: {
        id: 'user-1',
        username: 'admin',
        displayName: 'Admin',
        role: 'admin',
        groupIds: [],
      },
    });
    const malformedClient = new AdminClient('https://admin.example.com');
    await expect(malformedClient.validate('access-token')).rejects.toMatchObject({
      errorCode: 'SERVER_ERROR',
    });
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

  it('lists organizations and strips fields outside the client contract', async () => {
    mockJsonFetch({
      organizations: [{
        id: 'organization-1',
        type: 'creator_space',
        name: 'Studio',
        purpose: 'Publish apps',
        visibility: 'private',
        status: 'active',
        createdAt: '2026-07-29T12:00:00.000Z',
        updatedAt: '2026-07-29T12:00:00.000Z',
        membership: {
          id: 'membership-1',
          role: 'owner',
          status: 'active',
          joinedAt: '2026-07-29T12:00:00.000Z',
          updatedAt: '2026-07-29T12:00:00.000Z',
          internalPolicy: 'must-not-leak',
        },
        memberCount: 1,
        billingPlan: 'must-not-leak',
      }],
    });

    const client = new AdminClient('https://admin.example.com');
    const result = await client.listOrganizations('organization-access-token');

    expect(result).toEqual({
      organizations: [{
        id: 'organization-1',
        type: 'creator_space',
        name: 'Studio',
        purpose: 'Publish apps',
        visibility: 'private',
        status: 'active',
        createdAt: '2026-07-29T12:00:00.000Z',
        updatedAt: '2026-07-29T12:00:00.000Z',
        membership: {
          id: 'membership-1',
          role: 'owner',
          status: 'active',
          joinedAt: '2026-07-29T12:00:00.000Z',
          updatedAt: '2026-07-29T12:00:00.000Z',
        },
        memberCount: 1,
      }],
    });
    expect(fetchCalls[0]!.url).toBe('https://admin.example.com/api/me/organizations');
    expect((fetchCalls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe('Bearer organization-access-token');
  });

  it('accepts the POL-56 member response shape when user.phone is omitted', async () => {
    mockJsonFetch({
      members: [{
        id: 'membership-1',
        role: 'manager',
        status: 'active',
        joinedAt: '2026-07-29T12:00:00.000Z',
        updatedAt: '2026-07-29T12:00:00.000Z',
        user: {
          id: 'user-1',
          username: 'manager-user',
          displayName: 'Manager User',
          internalProfile: 'must-not-leak',
        },
      }],
    });

    const client = new AdminClient('https://admin.example.com');
    const result = await client.listOrganizationMembers(
      'organization-access-token',
      'organization-1',
    );

    expect(result).toEqual({
      members: [{
        id: 'membership-1',
        role: 'manager',
        status: 'active',
        joinedAt: '2026-07-29T12:00:00.000Z',
        updatedAt: '2026-07-29T12:00:00.000Z',
        user: {
          id: 'user-1',
          username: 'manager-user',
          displayName: 'Manager User',
        },
      }],
    });
    expect(fetchCalls[0]!.url)
      .toBe('https://admin.example.com/api/organizations/organization-1/members');
    expect((fetchCalls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe('Bearer organization-access-token');
  });

  it('creates organizations with an idempotency key in both trusted boundaries', async () => {
    mockJsonFetch({
      organization: {
        id: 'organization-1',
        type: 'enterprise_workspace',
        name: 'Acme',
        purpose: 'Internal apps',
      },
      membership: {
        id: 'membership-1',
        role: 'owner',
        status: 'active',
      },
      replayed: false,
    }, 201);

    const client = new AdminClient('https://admin.example.com');
    const input = {
      type: 'enterprise_workspace' as const,
      name: 'Acme',
      purpose: 'Internal apps',
      idempotencyKey: 'organization-request-1',
    };
    const result = await client.createOrganization('organization-access-token', input);

    expect(result).toMatchObject({
      organization: { id: 'organization-1' },
      membership: { role: 'owner' },
      replayed: false,
    });
    expect(fetchCalls[0]!.url).toBe('https://admin.example.com/api/organizations');
    expect(fetchCalls[0]!.init.body).toBe(JSON.stringify(input));
    expect(fetchCalls[0]!.init.headers).toMatchObject({
      Authorization: 'Bearer organization-access-token',
      'Idempotency-Key': 'organization-request-1',
    });
  });

  it('previews join links publicly and accepts them with the current account', async () => {
    const token = 'join-token-12345678901234567890';
    const preview = {
      organization: {
        id: 'organization-1',
        type: 'creator_space',
        name: 'Studio',
        purpose: 'Publish apps',
      },
      join: {
        kind: 'join_link',
        effectiveStatus: 'active',
        expiresAt: null,
        usesRemaining: null,
        requiresPhoneMatch: false,
      },
    } as const;
    mockJsonFetch(preview);
    const client = new AdminClient('https://admin.example.com');

    expect(await client.previewOrganizationJoin(token)).toEqual(preview);
    expect(fetchCalls[0]!.url).toBe(
      `https://admin.example.com/api/join/${token}/preview`,
    );
    expect((fetchCalls[0]!.init.headers as Record<string, string>).Authorization)
      .toBeUndefined();

    mockJsonFetch({
      membership: {
        id: 'membership-1',
        organizationId: 'organization-1',
        userId: 'user-1',
        role: 'member',
        status: 'active',
      },
      replayed: true,
    });
    expect(await client.acceptOrganizationJoin('organization-access-token', token))
      .toMatchObject({
        membership: { organizationId: 'organization-1', role: 'member' },
        replayed: true,
      });
    expect((fetchCalls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe('Bearer organization-access-token');
  });

  it('lists Creator Skills through the capability-filtered catalog boundary', async () => {
    mockJsonFetch({
      artifacts: [{
        id: 'artifact-1',
        organizationId: 'organization-1',
        type: 'skill',
        slug: 'review-helper',
        name: 'Review Helper',
        status: 'published',
        latestPublishedVersion: '1.0.0',
        createdByUserId: 'user-1',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
        serverStorageKey: 'must-not-leak',
      }],
      nextCursor: 'next',
      internalPolicy: 'must-not-leak',
    });
    const client = new AdminClient('https://admin.example.com');

    const result = await client.listCreatorArtifacts('creator-access-token', {
      organizationId: 'organization-1',
      type: 'skill',
      includeDrafts: true,
      cursor: 'current',
    });

    expect(result).toEqual({
      artifacts: [{
        id: 'artifact-1',
        organizationId: 'organization-1',
        type: 'skill',
        slug: 'review-helper',
        name: 'Review Helper',
        status: 'published',
        latestPublishedVersion: '1.0.0',
        createdByUserId: 'user-1',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      }],
      nextCursor: 'next',
    });
    expect(fetchCalls[0]!.url).toBe(
      'https://admin.example.com/api/organizations/organization-1/artifacts'
      + '?type=skill&includeDrafts=true&cursor=current&capability=creatorSkillArtifacts',
    );
    expect((fetchCalls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe('Bearer creator-access-token');
  });

  it('binds Creator Artifact mutations to an idempotency key', async () => {
    mockJsonFetch({
      artifact: {
        id: 'artifact-1',
        organizationId: 'organization-1',
        type: 'skill',
        slug: 'review-helper',
        status: 'draft',
        createdByUserId: 'user-1',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      },
      replayed: false,
    }, 201);
    const client = new AdminClient('https://admin.example.com');

    await client.createCreatorArtifact('creator-access-token', {
      organizationId: 'organization-1',
      type: 'skill',
      slug: 'review-helper',
      idempotencyKey: 'artifact-request-1',
    });

    expect(fetchCalls[0]!.init.body).toBe(JSON.stringify({
      slug: 'review-helper',
    }));
    expect(fetchCalls[0]!.init.headers).toMatchObject({
      Authorization: 'Bearer creator-access-token',
      'Idempotency-Key': 'artifact-request-1',
    });
  });

  it('parses redacted Member detail and strips an accidental upload generation', async () => {
    mockJsonFetch({
      artifact: {
        id: 'artifact-1',
        organizationId: 'organization-1',
        type: 'skill',
        slug: 'review-helper',
        status: 'published',
        latestPublishedVersion: '1.0.0',
        createdByUserId: 'user-1',
        createdAt: '2026-07-30T00:00:00.000Z',
        updatedAt: '2026-07-30T00:00:00.000Z',
      },
      versions: [{
        id: 'version-1',
        artifactId: 'artifact-1',
        version: '1.0.0',
        status: 'published',
        archiveChecksum: 'a'.repeat(64),
        sizeBytes: 123,
        createdAt: '2026-07-30T00:00:00.000Z',
        publishedAt: '2026-07-30T00:01:00.000Z',
        uploadGeneration: 9,
      }],
      selectedVersion: '1.0.0',
    });
    const client = new AdminClient('https://admin.example.com');

    const detail = await client.getCreatorArtifact(
      'member-access-token',
      'organization-1',
      'artifact-1',
      '1.0.0',
    );

    expect(detail.versions[0]).not.toHaveProperty('uploadGeneration');
    expect(detail.versions[0]).toMatchObject({
      id: 'version-1',
      status: 'published',
      archiveChecksum: 'a'.repeat(64),
    });
  });

  it('binds upload grant and completion requests to size and checksum', async () => {
    const archiveChecksum = 'a'.repeat(64);
    const baseVersion = {
      id: 'version-1',
      artifactId: 'artifact-1',
      version: '1.0.0',
      status: 'uploaded',
      archiveChecksum,
      sizeBytes: 123,
      createdAt: '2026-07-30T00:00:00.000Z',
      uploadGeneration: 2,
    };
    mockJsonFetch({
      method: 'PUT',
      url: 'https://uploads.example.test/object',
      headers: { 'content-type': 'application/zip', 'x-cos-meta-sha256': archiveChecksum },
      expiresAt: '2030-01-01T00:00:00.000Z',
      uploadGeneration: 2,
      expectedSizeBytes: 123,
      expectedArchiveChecksum: archiveChecksum,
    });
    const client = new AdminClient('https://admin.example.com');
    const binding = {
      organizationId: 'organization-1',
      artifactId: 'artifact-1',
      version: '1.0.0',
      sizeBytes: 123,
      archiveChecksum,
      idempotencyKey: 'upload-grant-1',
    };

    await client.createCreatorSkillUploadGrant('creator-access-token', binding);
    expect(fetchCalls[0]!.init.body).toBe(JSON.stringify({ sizeBytes: 123, archiveChecksum }));

    mockJsonFetch(baseVersion);
    await client.completeCreatorSkillUpload('creator-access-token', {
      ...binding,
      uploadGeneration: 2,
      idempotencyKey: 'upload-complete-1',
    });
    expect(fetchCalls[0]!.init.body).toBe(JSON.stringify({
      uploadGeneration: 2,
      sizeBytes: 123,
      archiveChecksum,
    }));
  });

  it('queries authoritative Creator Skill safety by exact installed identity', async () => {
    mockJsonFetch({
      statuses: [{
        artifactId: 'artifact-1',
        version: '1.0.0',
        archiveChecksum: 'a'.repeat(64),
        status: 'active',
        internalTombstoneId: 'must-not-leak',
      }],
    });
    const client = new AdminClient('https://admin.example.com');
    const input = {
      artifactId: 'artifact-1',
      version: '1.0.0',
      archiveChecksum: 'a'.repeat(64),
    };

    expect(await client.getCreatorSkillSafetyStatus(
      'creator-access-token',
      input,
    )).toEqual({
      ...input,
      status: 'active',
    });
    expect(fetchCalls[0]!.url).toBe(
      'https://admin.example.com/api/installed-artifacts/status',
    );
    expect(fetchCalls[0]!.init.method).toBe('POST');
    expect(fetchCalls[0]!.init.body).toBe(JSON.stringify({ artifacts: [input] }));
    expect((fetchCalls[0]!.init.headers as Record<string, string>).Authorization)
      .toBe('Bearer creator-access-token');
  });
});
