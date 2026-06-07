import { getCredentialManager } from '../credentials/index.ts';
import type { CredentialId, StoredCredential } from '../credentials/types.ts';
import { credentialIdToAccount } from '../credentials/types.ts';
import {
  mapDecryptedAdminConnectionToLlmConnection,
  type DecryptedAdminLlmConnection,
} from './llm-connections.ts';
import {
  loadStoredConfig,
  saveConfig,
  type StoredConfig,
} from './storage.ts';

export type { DecryptedAdminLlmConnection } from './llm-connections.ts';

export interface DecryptedAdminLlmConnectionsResult {
  configVersion: string;
  connections: DecryptedAdminLlmConnection[];
  defaultConnection: string | null;
}

export interface LlmCredentialStoreDependencies {
  credentialManager?: Pick<
    ReturnType<typeof getCredentialManager>,
    'get' | 'set' | 'delete' | 'list'
  >;
  loadStoredConfig?: () => StoredConfig | null;
  saveConfig?: (config: StoredConfig) => void;
  now?: () => number;
}

type ResolvedDependencies = Required<LlmCredentialStoreDependencies>;

export async function storeDecryptedLlmConnections(
  result: DecryptedAdminLlmConnectionsResult,
  dependencies: LlmCredentialStoreDependencies = {},
): Promise<void> {
  const deps = resolveDependencies(dependencies);
  const now = deps.now();
  const currentConfig = deps.loadStoredConfig() ?? createEmptyStoredConfig();
  const nextConfig = cloneStoredConfig(currentConfig);

  nextConfig.llmConnections = result.connections.map(connection =>
    mapDecryptedAdminConnectionToLlmConnection(connection, now),
  );
  if (result.defaultConnection) {
    nextConfig.defaultLlmConnection = result.defaultConnection;
  } else {
    delete nextConfig.defaultLlmConnection;
  }
  nextConfig.configVersion = result.configVersion;

  if (result.connections.length === 0) {
    deps.saveConfig(nextConfig);
    return;
  }

  const credentialIdsToStore = result.connections
    .filter(shouldStoreCredential)
    .map(connection => llmApiKeyId(connection.slug));
  const desiredCredentialAccounts = new Set(
    credentialIdsToStore.map(id => credentialIdToAccount(id)),
  );
  const existingLlmApiKeyIds = await deps.credentialManager.list({ type: 'llm_api_key' });
  const obsoleteCredentialIds = existingLlmApiKeyIds.filter(id =>
    !desiredCredentialAccounts.has(credentialIdToAccount(id)),
  );
  const idsToSnapshot = uniqueCredentialIds([
    ...credentialIdsToStore,
    ...obsoleteCredentialIds,
  ]);
  const snapshots = await snapshotCredentials(deps.credentialManager, idsToSnapshot);
  const touchedIds: CredentialId[] = [];

  try {
    for (const connection of result.connections) {
      if (!shouldStoreCredential(connection)) continue;

      const id = llmApiKeyId(connection.slug);
      await deps.credentialManager.set(id, { value: connection.apiKey });
      touchedIds.push(id);
    }

    for (const id of obsoleteCredentialIds) {
      if (await deps.credentialManager.delete(id)) {
        touchedIds.push(id);
      }
    }

    deps.saveConfig(nextConfig);
  } catch (error) {
    await rollbackCredentialChanges(deps.credentialManager, snapshots, touchedIds);
    throw error;
  }
}

export function getCachedConfigVersion(
  dependencies: Pick<LlmCredentialStoreDependencies, 'loadStoredConfig'> = {},
): string | null {
  const config = (dependencies.loadStoredConfig ?? loadStoredConfig)();
  return config?.configVersion ?? null;
}

export async function cleanupLlmCredentials(
  dependencies: LlmCredentialStoreDependencies = {},
): Promise<void> {
  const deps = resolveDependencies(dependencies);
  const llmApiKeyIds = await deps.credentialManager.list({ type: 'llm_api_key' });
  await Promise.all(llmApiKeyIds.map(id => deps.credentialManager.delete(id)));

  const currentConfig = deps.loadStoredConfig() ?? createEmptyStoredConfig();
  const nextConfig = cloneStoredConfig(currentConfig);
  nextConfig.llmConnections = [];
  delete nextConfig.defaultLlmConnection;
  delete nextConfig.configVersion;
  deps.saveConfig(nextConfig);
}

function resolveDependencies(
  dependencies: LlmCredentialStoreDependencies,
): ResolvedDependencies {
  return {
    credentialManager: dependencies.credentialManager ?? getCredentialManager(),
    loadStoredConfig: dependencies.loadStoredConfig ?? loadStoredConfig,
    saveConfig: dependencies.saveConfig ?? saveConfig,
    now: dependencies.now ?? Date.now,
  };
}

function shouldStoreCredential(connection: DecryptedAdminLlmConnection): boolean {
  return connection.authType !== 'environment' && connection.apiKey.length > 0;
}

function llmApiKeyId(connectionSlug: string): CredentialId {
  return { type: 'llm_api_key', connectionSlug };
}

function createEmptyStoredConfig(): StoredConfig {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  };
}

function cloneStoredConfig(config: StoredConfig): StoredConfig {
  return structuredClone(config);
}

function uniqueCredentialIds(ids: CredentialId[]): CredentialId[] {
  const seen = new Set<string>();
  const unique: CredentialId[] = [];
  for (const id of ids) {
    const account = credentialIdToAccount(id);
    if (seen.has(account)) continue;
    seen.add(account);
    unique.push(id);
  }
  return unique;
}

async function snapshotCredentials(
  manager: Pick<ReturnType<typeof getCredentialManager>, 'get'>,
  ids: CredentialId[],
): Promise<Map<string, { id: CredentialId; credential: StoredCredential | null }>> {
  const snapshots = new Map<string, { id: CredentialId; credential: StoredCredential | null }>();
  for (const id of ids) {
    snapshots.set(credentialIdToAccount(id), {
      id,
      credential: await manager.get(id),
    });
  }
  return snapshots;
}

async function rollbackCredentialChanges(
  manager: Pick<ReturnType<typeof getCredentialManager>, 'set' | 'delete'>,
  snapshots: Map<string, { id: CredentialId; credential: StoredCredential | null }>,
  touchedIds: CredentialId[],
): Promise<void> {
  const restored = new Set<string>();
  for (const id of [...touchedIds].reverse()) {
    const account = credentialIdToAccount(id);
    if (restored.has(account)) continue;
    restored.add(account);

    const snapshot = snapshots.get(account);
    try {
      if (snapshot?.credential) {
        await manager.set(snapshot.id, snapshot.credential);
      } else {
        await manager.delete(id);
      }
    } catch {
      // Preserve the original write failure; rollback best-effort failures are non-fatal here.
    }
  }
}
