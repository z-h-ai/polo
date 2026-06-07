import { getCredentialManager } from '../credentials/index.ts';

export interface LogoutAuthDependencies {
  logout: () => Promise<void>;
  clearCachedAuthData: () => void | Promise<void>;
  credentialManager?: Pick<ReturnType<typeof getCredentialManager>, 'list' | 'delete'>;
}

export type LogoutAuthResult =
  | { apiLogoutSucceeded: true }
  | { apiLogoutSucceeded: false; apiError: Error };

export async function logoutAuth(
  dependencies: LogoutAuthDependencies,
): Promise<LogoutAuthResult> {
  let result: LogoutAuthResult = { apiLogoutSucceeded: true };

  try {
    await dependencies.logout();
  } catch (error) {
    result = {
      apiLogoutSucceeded: false,
      apiError: toError(error),
    };
  }

  await dependencies.clearCachedAuthData();

  const manager = dependencies.credentialManager ?? getCredentialManager();
  const llmApiKeyIds = await manager.list({ type: 'llm_api_key' });
  await Promise.all(llmApiKeyIds.map(id => manager.delete(id)));

  return result;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
