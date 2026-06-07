import { getCredentialManager } from '../credentials/index.ts';

export interface SessionExpiredEvent {
  reason: 'token_revoked';
  requestUrl: string;
}

export type OnForceLogout = (event: SessionExpiredEvent) => void | Promise<void>;

export interface ForceLogoutDependencies {
  getInFlightLlmAbortControllers: () => Iterable<Pick<AbortController, 'abort'>>;
  clearCachedAuthData: () => void | Promise<void>;
  saveUnsentInputDraft?: () => void | Promise<void>;
  emitSessionExpired: OnForceLogout;
  routeToLogin: () => void | Promise<void>;
  credentialManager?: Pick<ReturnType<typeof getCredentialManager>, 'list' | 'delete'>;
}

export function createForceLogoutHandler(
  dependencies: ForceLogoutDependencies,
): OnForceLogout {
  let forceLogoutPromise: Promise<void> | null = null;
  let forceLogoutCompleted = false;

  return event => {
    if (forceLogoutCompleted) {
      return;
    }

    if (forceLogoutPromise) {
      return forceLogoutPromise;
    }

    forceLogoutPromise = runForceLogout(event, dependencies).finally(() => {
      forceLogoutCompleted = true;
      forceLogoutPromise = null;
    });

    return forceLogoutPromise;
  };
}

async function runForceLogout(
  event: SessionExpiredEvent,
  dependencies: ForceLogoutDependencies,
): Promise<void> {
  for (const controller of dependencies.getInFlightLlmAbortControllers()) {
    controller.abort();
  }

  await dependencies.clearCachedAuthData();

  const manager = dependencies.credentialManager ?? getCredentialManager();
  const llmApiKeyIds = await manager.list({ type: 'llm_api_key' });
  await Promise.all(llmApiKeyIds.map(id => manager.delete(id)));

  await dependencies.saveUnsentInputDraft?.();
  await dependencies.emitSessionExpired(event);
  await dependencies.routeToLogin();
}
