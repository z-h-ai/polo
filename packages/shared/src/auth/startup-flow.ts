import { getCredentialManager } from '../credentials/index.ts';
import {
  NetworkError,
  TokenRevokedError,
  createAdminApiClient,
  type AdminUser,
  type ValidateTokenResult,
} from './admin-auth.ts';

export {
  AdminAuthApiError,
  NetworkError,
  TokenRevokedError,
} from './admin-auth.ts';

const DEFAULT_VALIDATE_TIMEOUT_MS = 10_000;

export interface LlmConfig {
  configVersion: string;
  connections: unknown[];
  defaultConnection: string | null;
}

export interface StartupContext {
  cachedToken: string | null;
  cachedConfigVersion: string | null;
}

export type StartupResult =
  | { action: 'enter-app'; config: LlmConfig }
  | { action: 'login-page' }
  | { action: 'server-error'; error: Error }
  | { action: 'config-error'; error: Error }
  | { action: 'fetch-config'; token: string; user: AdminUser };

export interface StartupAuthDependencies {
  validateToken?: (token: string) => Promise<ValidateTokenResult>;
  validateTimeoutMs?: number;
  getCachedConfig: () => LlmConfig | null | Promise<LlmConfig | null>;
  fetchAndStoreConfig?: (token: string, user: AdminUser) => Promise<LlmConfig>;
  clearCachedAuthData: () => void | Promise<void>;
  credentialManager?: Pick<ReturnType<typeof getCredentialManager>, 'list' | 'delete'>;
}

export async function startupAuth(
  context: StartupContext,
  dependencies: StartupAuthDependencies,
): Promise<StartupResult> {
  const token = context.cachedToken?.trim();
  if (!token) {
    return { action: 'login-page' };
  }

  let validation: ValidateTokenResult;
  try {
    validation = await validateCachedToken(token, dependencies);
  } catch (error) {
    if (error instanceof TokenRevokedError) {
      await clearAllCachedAuthData(dependencies);
      return { action: 'login-page' };
    }

    return { action: 'server-error', error: toError(error) };
  }

  const cachedConfig = await dependencies.getCachedConfig();
  if (
    cachedConfig &&
    context.cachedConfigVersion &&
    validation.configVersion === context.cachedConfigVersion
  ) {
    return { action: 'enter-app', config: cachedConfig };
  }

  if (!dependencies.fetchAndStoreConfig) {
    return { action: 'fetch-config', token, user: validation.user };
  }

  try {
    const config = await dependencies.fetchAndStoreConfig(token, validation.user);
    return { action: 'enter-app', config };
  } catch (error) {
    await clearAllCachedAuthData(dependencies);
    return { action: 'config-error', error: toError(error) };
  }
}

async function validateCachedToken(
  token: string,
  dependencies: StartupAuthDependencies,
): Promise<ValidateTokenResult> {
  const validateToken = dependencies.validateToken ?? defaultValidateToken;
  const timeoutMs = dependencies.validateTimeoutMs ?? DEFAULT_VALIDATE_TIMEOUT_MS;
  return withTimeout(
    () => validateToken(token),
    timeoutMs,
    'Admin API validate timed out',
  );
}

async function defaultValidateToken(token: string): Promise<ValidateTokenResult> {
  return createAdminApiClient({
    token,
    validateTimeoutMs: DEFAULT_VALIDATE_TIMEOUT_MS,
  }).validateToken();
}

async function clearAllCachedAuthData(dependencies: StartupAuthDependencies): Promise<void> {
  await dependencies.clearCachedAuthData();

  const manager = dependencies.credentialManager ?? getCredentialManager();
  const llmApiKeyIds = await manager.list({ type: 'llm_api_key' });
  await Promise.all(llmApiKeyIds.map(id => manager.delete(id)));
}

async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new NetworkError(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
