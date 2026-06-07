import { describe, expect, it, mock } from 'bun:test';
import {
  AdminAuthApiError,
  NetworkError,
  TokenRevokedError,
  startupAuth,
  type StartupAuthDependencies,
} from './startup-flow.ts';
import type { AdminUser, ValidateTokenResult } from './admin-auth.ts';

const sampleUser: AdminUser = {
  id: 'user-1',
  username: 'zhangsan',
  displayName: 'Zhang San',
  role: 'admin',
  groupIds: ['grp-dev'],
};

const cachedConfig = {
  configVersion: 'cv_001',
  connections: [
    {
      slug: 'anthropic-prod',
      name: 'Anthropic Production',
      providerType: 'anthropic',
      authType: 'api_key',
    },
  ],
  defaultConnection: 'anthropic-prod',
};

function valid(configVersion: string): ValidateTokenResult {
  return { valid: true, user: sampleUser, configVersion };
}

function makeDeps(overrides: Partial<StartupAuthDependencies> = {}): StartupAuthDependencies {
  return {
    validateToken: mock(async () => valid('cv_001')),
    getCachedConfig: mock(async () => cachedConfig),
    clearCachedAuthData: mock(async () => {}),
    credentialManager: {
      list: mock(async () => []),
      delete: mock(async () => false),
    },
    ...overrides,
  };
}

describe('startupAuth', () => {
  it('returns login-page without validating when no cached token exists', async () => {
    const deps = makeDeps();

    const result = await startupAuth({ cachedToken: null, cachedConfigVersion: null }, deps);

    expect(result).toEqual({ action: 'login-page' });
    expect(deps.validateToken).not.toHaveBeenCalled();
  });

  it('treats an empty cached token as missing', async () => {
    const deps = makeDeps();

    const result = await startupAuth({ cachedToken: '', cachedConfigVersion: null }, deps);

    expect(result).toEqual({ action: 'login-page' });
    expect(deps.validateToken).not.toHaveBeenCalled();
  });

  it('validates a cached token once with the cached token and enters app when config version matches', async () => {
    const validateToken = mock(async () => valid('cv_001'));
    const deps = makeDeps({ validateToken });

    const result = await startupAuth({ cachedToken: 'jwt', cachedConfigVersion: 'cv_001' }, deps);

    expect(validateToken).toHaveBeenCalledTimes(1);
    expect(validateToken).toHaveBeenCalledWith('jwt');
    expect(result).toEqual({ action: 'enter-app', config: cachedConfig });
  });

  it('fetches config when the validated config version differs from the cached version', async () => {
    const deps = makeDeps({ validateToken: mock(async () => valid('cv_002')) });

    const result = await startupAuth({ cachedToken: 'jwt', cachedConfigVersion: 'cv_001' }, deps);

    expect(result).toEqual({ action: 'fetch-config', token: 'jwt', user: sampleUser });
  });

  it('fetches config when there is no cached config version', async () => {
    const deps = makeDeps({ validateToken: mock(async () => valid('cv_001')) });

    const result = await startupAuth({ cachedToken: 'jwt', cachedConfigVersion: null }, deps);

    expect(result).toEqual({ action: 'fetch-config', token: 'jwt', user: sampleUser });
  });

  it('clears cached auth and LLM API key credentials when a token is revoked', async () => {
    const clearCachedAuthData = mock(async () => {});
    const list = mock(async () => [
      { type: 'llm_api_key' as const, connectionSlug: 'anthropic-prod' },
      { type: 'llm_api_key' as const, connectionSlug: 'openai-prod' },
    ]);
    const deleteCredential = mock(async () => true);
    const deps = makeDeps({
      validateToken: mock(async () => {
        throw new TokenRevokedError(401, { error: 'token_revoked' });
      }),
      clearCachedAuthData,
      credentialManager: { list, delete: deleteCredential },
    });

    const result = await startupAuth({ cachedToken: 'jwt', cachedConfigVersion: 'cv_001' }, deps);

    expect(result).toEqual({ action: 'login-page' });
    expect(clearCachedAuthData).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ type: 'llm_api_key' });
    expect(deleteCredential).toHaveBeenCalledTimes(2);
    expect(deleteCredential).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'anthropic-prod' });
    expect(deleteCredential).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'openai-prod' });
  });

  it('returns server-error for validate network errors', async () => {
    const error = new NetworkError('Admin unavailable');
    const deps = makeDeps({
      validateToken: mock(async () => {
        throw error;
      }),
    });

    const result = await startupAuth({ cachedToken: 'jwt', cachedConfigVersion: 'cv_001' }, deps);

    expect(result).toEqual({ action: 'server-error', error });
  });

  it('returns server-error when validate times out', async () => {
    const deps = makeDeps({
      validateTimeoutMs: 5,
      validateToken: mock(async () => {
        await new Promise(() => {});
        return valid('cv_001');
      }),
    });

    const result = await startupAuth({ cachedToken: 'jwt', cachedConfigVersion: 'cv_001' }, deps);

    expect(result.action).toBe('server-error');
    if (result.action !== 'server-error') {
      throw new Error(`expected server-error, got ${result.action}`);
    }
    expect(result.error).toBeInstanceOf(NetworkError);
    expect(result.error.message).toContain('timed out');
  });

  it('returns server-error for Admin 5xx validation failures', async () => {
    const error = new AdminAuthApiError('AdminAuthApiError', 503, { error: 'http_503' }, 'Admin down');
    const deps = makeDeps({
      validateToken: mock(async () => {
        throw error;
      }),
    });

    const result = await startupAuth({ cachedToken: 'jwt', cachedConfigVersion: 'cv_001' }, deps);

    expect(result).toEqual({ action: 'server-error', error });
  });

  it('rolls back cached auth and credentials when config fetch fails after validation', async () => {
    const clearCachedAuthData = mock(async () => {});
    const deleteCredential = mock(async () => true);
    const fetchError = new Error('config fetch failed');
    const deps = makeDeps({
      fetchAndStoreConfig: mock(async () => {
        throw fetchError;
      }),
      clearCachedAuthData,
      credentialManager: {
        list: mock(async () => [{ type: 'llm_api_key' as const, connectionSlug: 'partial' }]),
        delete: deleteCredential,
      },
    });

    const result = await startupAuth({ cachedToken: 'jwt', cachedConfigVersion: null }, deps);

    expect(result).toEqual({ action: 'config-error', error: fetchError });
    expect(clearCachedAuthData).toHaveBeenCalledTimes(1);
    expect(deleteCredential).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'partial' });
  });

  it('rolls back cached auth and credentials when config decrypt/write transaction fails', async () => {
    const clearCachedAuthData = mock(async () => {});
    const transactionError = new Error('all connections failed decrypt');
    const deps = makeDeps({
      fetchAndStoreConfig: mock(async () => {
        throw transactionError;
      }),
      clearCachedAuthData,
      credentialManager: {
        list: mock(async () => [{ type: 'llm_api_key' as const, connectionSlug: 'partial' }]),
        delete: mock(async () => true),
      },
    });

    const result = await startupAuth({ cachedToken: 'jwt', cachedConfigVersion: 'stale' }, deps);

    expect(result).toEqual({ action: 'config-error', error: transactionError });
    expect(clearCachedAuthData).toHaveBeenCalledTimes(1);
  });
});
