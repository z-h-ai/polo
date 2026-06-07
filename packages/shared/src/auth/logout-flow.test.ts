import { describe, expect, it, mock } from 'bun:test';
import { NetworkError, TokenRevokedError } from './admin-auth.ts';
import { logoutAuth, type LogoutAuthDependencies } from './logout-flow.ts';

function makeDeps(overrides: Partial<LogoutAuthDependencies> = {}): LogoutAuthDependencies {
  return {
    logout: mock(async () => {}),
    clearCachedAuthData: mock(async () => {}),
    credentialManager: {
      list: mock(async () => []),
      delete: mock(async () => false),
    },
    ...overrides,
  };
}

describe('logoutAuth', () => {
  it('calls Admin logout, clears cached auth data, and deletes LLM API key credentials', async () => {
    const logout = mock(async () => {});
    const clearCachedAuthData = mock(async () => {});
    const list = mock(async () => [
      { type: 'llm_api_key' as const, connectionSlug: 'anthropic-prod' },
      { type: 'llm_api_key' as const, connectionSlug: 'openai-prod' },
    ]);
    const deleteCredential = mock(async () => true);
    const deps = makeDeps({
      logout,
      clearCachedAuthData,
      credentialManager: { list, delete: deleteCredential },
    });

    const result = await logoutAuth(deps);

    expect(result).toEqual({ apiLogoutSucceeded: true });
    expect(logout).toHaveBeenCalledTimes(1);
    expect(clearCachedAuthData).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ type: 'llm_api_key' });
    expect(deleteCredential).toHaveBeenCalledTimes(2);
    expect(deleteCredential).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'anthropic-prod' });
    expect(deleteCredential).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'openai-prod' });
  });

  it('still clears cached auth data and LLM API key credentials when Admin logout has a network error', async () => {
    const apiError = new NetworkError('Admin unavailable');
    const clearCachedAuthData = mock(async () => {});
    const deleteCredential = mock(async () => true);
    const deps = makeDeps({
      logout: mock(async () => {
        throw apiError;
      }),
      clearCachedAuthData,
      credentialManager: {
        list: mock(async () => [{ type: 'llm_api_key' as const, connectionSlug: 'partial' }]),
        delete: deleteCredential,
      },
    });

    const result = await logoutAuth(deps);

    expect(result).toEqual({ apiLogoutSucceeded: false, apiError });
    expect(clearCachedAuthData).toHaveBeenCalledTimes(1);
    expect(deleteCredential).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'partial' });
  });

  it('still clears cached auth data and routes as success when Admin logout returns 401', async () => {
    const apiError = new TokenRevokedError(401, { error: 'token_revoked' });
    const clearCachedAuthData = mock(async () => {});
    const deps = makeDeps({
      logout: mock(async () => {
        throw apiError;
      }),
      clearCachedAuthData,
    });

    const result = await logoutAuth(deps);

    expect(result).toEqual({ apiLogoutSucceeded: false, apiError });
    expect(clearCachedAuthData).toHaveBeenCalledTimes(1);
  });
});
