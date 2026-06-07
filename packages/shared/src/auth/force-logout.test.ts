import { describe, expect, it, mock } from 'bun:test';
import { createForceLogoutHandler, type SessionExpiredEvent } from './force-logout.ts';

function event(requestUrl = 'http://localhost:3001/api/llm-connections'): SessionExpiredEvent {
  return { reason: 'token_revoked', requestUrl };
}

describe('createForceLogoutHandler', () => {
  it('runs the force logout sequence for a session-expired event', async () => {
    let cachedToken: string | null = 'jwt';
    let cachedUser: unknown = { id: 'user-1' };
    let cachedLlmConfig: unknown = { configVersion: 'cv_001', connections: [{ slug: 'anthropic-prod' }] };
    const abort = mock(() => {});
    const clearCachedAuthData = mock(async () => {
      cachedToken = null;
      cachedUser = null;
      cachedLlmConfig = null;
    });
    const saveUnsentInputDraft = mock(async () => {});
    const emitSessionExpired = mock(async (_event: SessionExpiredEvent) => {});
    const routeToLogin = mock(async () => {});
    const list = mock(async () => [
      { type: 'llm_api_key' as const, connectionSlug: 'anthropic-prod' },
      { type: 'llm_api_key' as const, connectionSlug: 'openai-prod' },
    ]);
    const deleteCredential = mock(async () => true);

    const handleForceLogout = createForceLogoutHandler({
      getInFlightLlmAbortControllers: () => [{ abort }],
      clearCachedAuthData,
      saveUnsentInputDraft,
      emitSessionExpired,
      routeToLogin,
      credentialManager: { list, delete: deleteCredential },
    });

    await handleForceLogout(event());

    expect(abort).toHaveBeenCalledTimes(1);
    expect(cachedToken).toBeNull();
    expect(cachedUser).toBeNull();
    expect(cachedLlmConfig).toBeNull();
    expect(clearCachedAuthData).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ type: 'llm_api_key' });
    expect(deleteCredential).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'anthropic-prod' });
    expect(deleteCredential).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'openai-prod' });
    expect(saveUnsentInputDraft).toHaveBeenCalledTimes(1);
    expect(emitSessionExpired).toHaveBeenCalledWith(event());
    expect(routeToLogin).toHaveBeenCalledTimes(1);
  });

  it('is idempotent for concurrent and later stale 401 events', async () => {
    let releaseCleanup: (() => void) | undefined;
    const clearCachedAuthData = mock(async () => {
      await new Promise<void>(resolve => {
        releaseCleanup = resolve;
      });
    });
    const emitSessionExpired = mock(async (_event: SessionExpiredEvent) => {});
    const routeToLogin = mock(async () => {});
    const deleteCredential = mock(async () => true);
    const handleForceLogout = createForceLogoutHandler({
      getInFlightLlmAbortControllers: () => [],
      clearCachedAuthData,
      emitSessionExpired,
      routeToLogin,
      credentialManager: {
        list: mock(async () => [{ type: 'llm_api_key' as const, connectionSlug: 'anthropic-prod' }]),
        delete: deleteCredential,
      },
    });

    const first = handleForceLogout(event('/api/first'));
    const second = handleForceLogout(event('/api/second'));
    releaseCleanup?.();
    await Promise.all([first, second]);
    await handleForceLogout(event('/api/stale'));

    expect(clearCachedAuthData).toHaveBeenCalledTimes(1);
    expect(deleteCredential).toHaveBeenCalledTimes(1);
    expect(emitSessionExpired).toHaveBeenCalledTimes(1);
    expect(routeToLogin).toHaveBeenCalledTimes(1);
  });
});
