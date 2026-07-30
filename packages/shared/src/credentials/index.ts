/**
 * Credential Storage Module
 *
 * Provides secure credential storage using AES-256-GCM encrypted file.
 * All methods auto-initialize, so explicit initialize() calls are optional.
 *
 * Usage:
 *   import { getCredentialManager } from './credentials';
 *
 *   const manager = getCredentialManager();
 *
 *   // Get/set API key
 *   const apiKey = await manager.getApiKey();
 *   await manager.setApiKey('sk-ant-...');
 *
 *   // Get/set workspace OAuth
 *   const oauth = await manager.getWorkspaceOAuth(workspaceId);
 *   await manager.setWorkspaceOAuth(workspaceId, { accessToken, refreshToken, ... });
 *
 *   // Get/set agent MCP/API credentials
 *   const mcpCreds = await manager.getMcpOAuth(wsId, agentId, serverName);
 *   const apiKey = await manager.getApiKeyForAgent(wsId, agentId, apiName);
 */

export {
  CredentialManager,
  getCredentialManager,
  setInvocationCredential,
  clearInvocationCredentials,
} from './manager.ts';
export type { CredentialId, CredentialType, StoredCredential } from './types.ts';
export { credentialIdToAccount, accountToCredentialId, SOURCE_CREDENTIAL_TYPES, VALID_CREDENTIAL_TYPES } from './types.ts';
export {
  startInvocationCredentialProxy,
  type InvocationCredentialProxy,
  type InvocationCredentialProxyOptions,
  type InvocationCredentialProxyTarget,
} from './invocation-credential-proxy.ts';
export type { CredentialBackend } from './backends/types.ts';
