/**
 * Unified Auth State Management
 *
 * Provides a single source of truth for all authentication state:
 * - Billing configuration (api_key or oauth_token)
 * - Workspace/MCP configuration
 *
 * MIGRATION NOTE (v0.3.0+):
 * We no longer support tokens from Claude CLI / Claude Desktop.
 * Users with legacy tokens will be prompted to re-authenticate using
 * our native OAuth flow. This is a one-time migration.
 */

import { getCredentialManager } from '../credentials/index.ts';
import {
  getActiveWorkspace,
  getAdminUrl,
  getDefaultLlmConnection,
  getLlmConnection,
  type AuthType,
  type Workspace,
} from '../config/storage.ts';
import { refreshClaudeToken, isTokenExpired } from './claude-token.ts';
import { debug } from '../utils/debug.ts';

function toLegacyBillingType(
  authType: NonNullable<ReturnType<typeof getLlmConnection>>['authType'],
): AuthType {
  switch (authType) {
    case 'oauth':
      return 'oauth_token'
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'bearer_token':
    case 'iam_credentials':
    case 'service_account_file':
    case 'environment':
    case 'none':
      return 'api_key'
  }
}

// ============================================
// Types
// ============================================

/** Migration info when user needs to re-authenticate */
export interface MigrationInfo {
  reason: 'legacy_token';
  message: string;
}

/** Result of token validation/refresh operations */
export interface TokenResult {
  accessToken: string | null;
  migrationRequired?: MigrationInfo;
}

export interface AuthState {
  /** Claude API billing configuration */
  billing: {
    /** Configured billing type, or null if not yet configured */
    type: AuthType | null;
    /** True if we have the required credentials for the configured billing type */
    hasCredentials: boolean;
    /** Anthropic API key (if using api_key auth type) */
    apiKey: string | null;
    /** Claude Max OAuth token (if using oauth_token auth type) */
    claudeOAuthToken: string | null;
    /** Migration info if user needs to re-authenticate */
    migrationRequired?: MigrationInfo;
  };

  /** Workspace/MCP configuration */
  workspace: {
    hasWorkspace: boolean;
    active: Workspace | null;
  };

  /** Admin-managed configuration state */
  admin: {
    /** True when an Admin server URL is configured */
    configured: boolean;
    /** True when Admin tokens are present */
    loggedIn: boolean;
    /** Username associated with the Admin session */
    username?: string;
  };
}

export interface SetupNeeds {
  /** No billing type configured → show billing picker */
  needsBillingConfig: boolean;
  /** Billing type set but missing credentials → show credential entry */
  needsCredentials: boolean;
  /** Everything complete → go straight to App */
  isFullyConfigured: boolean;
  /** Admin server is configured but no Admin session exists */
  needsAdminLogin: boolean;
  /** User has legacy tokens that need migration */
  needsMigration?: MigrationInfo;
}

// ============================================
// Token Refresh Mutex
// ============================================

// Mutex to prevent concurrent token refresh attempts
// When a refresh is in progress, other callers wait for it to complete
const refreshInProgress = new Map<string, Promise<TokenResult>>();

type ClaudeTokenRefresher = typeof refreshClaudeToken;

/**
 * Perform the actual token refresh (internal, called only when holding mutex)
 * Returns TokenResult with accessToken and optional migrationRequired info
 */
export async function performTokenRefresh(
  manager: ReturnType<typeof getCredentialManager>,
  refreshToken: string,
  originalSource: 'native' | 'cli' | undefined,
  connectionSlug: string,
  expectedAccessToken: string,
  refreshTokenFn: ClaudeTokenRefresher = refreshClaudeToken,
): Promise<TokenResult> {
  try {
    const refreshed = await refreshTokenFn(refreshToken);

    // Format expiry time for logging
    const expiresAtDate = refreshed.expiresAt ? new Date(refreshed.expiresAt).toISOString() : 'never';
    debug(`[auth] Successfully refreshed Claude OAuth token (expires: ${expiresAtDate})`);

    // The selected connection identity is the sole source of truth. In
    // particular, a CLI refresh must never read or mutate the unrelated legacy
    // claude_oauth::global identity.
    const replacement = {
      value: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      source: 'native' as const,
    };
    const update = await manager.compareAndSwap(
      { type: 'llm_oauth', connectionSlug },
      { value: expectedAccessToken, refreshToken },
      replacement,
    );

    if (!update.updated) {
      debug('[auth] OAuth identity changed during refresh; keeping the newer credential');
      return { accessToken: update.current?.value ?? null };
    }

    return { accessToken: refreshed.accessToken };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    debug('[auth] Failed to refresh Claude OAuth token:', errorMessage);

    // Only clear credentials for specific OAuth errors that indicate the token is truly invalid
    // Be conservative - don't clear for network errors, timeouts, or unknown errors
    const isIncompatibleToken =
      errorMessage.includes('invalid_grant') ||
      errorMessage.includes('Refresh token not found or invalid') ||
      errorMessage.includes('invalid_refresh_token');

    let migrationRequired: MigrationInfo | undefined;

    if (isIncompatibleToken) {
      // Token refresh failed - could be legacy CLI token or expired/revoked
      debug('[auth] Token refresh failed - credentials will be cleared');

      // Check if this was from CLI based on stored source
      const isFromCLI = originalSource === 'cli' || !originalSource;
      if (isFromCLI) {
        debug('[auth] Token was from CLI or unknown source - migration required');
        migrationRequired = {
          reason: 'legacy_token',
          message:
            'Your Claude authentication needs to be refreshed. ' +
            'Please sign in again.',
        };
      }

      // Clear only if this process still owns the same token generation. A
      // concurrent successful rotation must survive this stale failure.
      const deletion = await manager.compareAndSwap(
        { type: 'llm_oauth', connectionSlug },
        { value: expectedAccessToken, refreshToken },
        null,
      );
      if (!deletion.updated) {
        debug('[auth] OAuth identity changed during failed refresh; preserving the newer credential');
        return { accessToken: deletion.current?.value ?? null };
      }
    }

    // Token refresh failed - return null token with optional migration info
    return { accessToken: null, migrationRequired };
  }
}

async function refreshClaudeOAuthWithLease(
  manager: ReturnType<typeof getCredentialManager>,
  connectionSlug: string,
  refreshTokenFn: ClaudeTokenRefresher,
): Promise<TokenResult> {
  return manager.withExclusiveLease(`llm-oauth-refresh:${connectionSlug}`, async () => {
    // The invocation overlay may contain the generation captured at CLI
    // startup. Once the cross-process lease is held, always re-read the shared
    // store so a preceding Electron/CLI refresher is observed before HTTP.
    const current = await manager.getPersistedLlmOAuth(connectionSlug);
    if (!current?.accessToken) return { accessToken: null };
    if (!isTokenExpired(current.expiresAt)) {
      return { accessToken: current.accessToken };
    }
    if (!current.refreshToken) return { accessToken: null };

    return performTokenRefresh(
      manager,
      current.refreshToken,
      current.source,
      connectionSlug,
      current.accessToken,
      refreshTokenFn,
    );
  });
}

// ============================================
// Functions
// ============================================

/**
 * Get and refresh Claude OAuth token if needed
 *
 * This function:
 * 1. Checks if we have a token in our credential store
 * 2. Detects legacy tokens (from Claude CLI) and triggers migration
 * 3. If token is expired and we have a refresh token, refreshes it
 * 4. Returns TokenResult with valid access token and optional migration info
 *
 * MUTEX: Only one refresh can happen at a time. If a refresh is already
 * in progress, other callers wait for it and then re-read credentials.
 *
 * MIGRATION (v0.3.0+):
 * - We NO LONGER import tokens from Claude CLI keychain
 * - Legacy tokens are detected and cleared, prompting re-authentication
 */
export async function getValidClaudeOAuthToken(connectionSlug: string): Promise<TokenResult> {
  const manager = getCredentialManager();

  return getValidClaudeOAuthTokenWithManager(connectionSlug, manager);
}

/**
 * Dependency-injected implementation used by identity-isolation regressions.
 */
export async function getValidClaudeOAuthTokenWithManager(
  connectionSlug: string,
  manager: ReturnType<typeof getCredentialManager>,
  refreshTokenFn: ClaudeTokenRefresher = refreshClaudeToken,
): Promise<TokenResult> {

  // Read the selected LLM connection identity, including invocation overlays.
  const creds = await manager.getLlmOAuth(connectionSlug);

  if (!creds || !creds.accessToken) {
    return { accessToken: null };
  }

  // Check if token is expired or about to expire
  if (isTokenExpired(creds.expiresAt)) {
    const expiresAtDate = creds.expiresAt ? new Date(creds.expiresAt).toISOString() : 'unknown';
    debug(`[auth] Claude OAuth token expired (was: ${expiresAtDate}), attempting refresh`);

    // Try to refresh if we have a refresh token
    if (creds.refreshToken) {
      // Check if a refresh is already in progress
      const existingRefresh = refreshInProgress.get(connectionSlug);
      if (existingRefresh) {
        debug('[auth] Token refresh already in progress, waiting...');
        try {
          await existingRefresh;
        } catch {
          // Ignore errors from the other refresh attempt
        }
        // Re-read credentials after waiting (they may have been updated)
        const updatedCreds = await manager.getPersistedLlmOAuth(connectionSlug);
        if (updatedCreds?.accessToken && !isTokenExpired(updatedCreds.expiresAt)) {
          const expiresAtDate = updatedCreds.expiresAt ? new Date(updatedCreds.expiresAt).toISOString() : 'never';
          debug(`[auth] Got refreshed token from concurrent refresh (expires: ${expiresAtDate})`);
          return { accessToken: updatedCreds.accessToken };
        }
        // If still no valid token, return null (the other refresh may have failed)
        debug('[auth] Concurrent refresh did not produce valid token');
        return { accessToken: null };
      }

      // Start the refresh and set the mutex
      debug('[auth] Starting token refresh (holding mutex)');
      const refresh = refreshClaudeOAuthWithLease(manager, connectionSlug, refreshTokenFn);
      refreshInProgress.set(connectionSlug, refresh);

      try {
        const result = await refresh;
        return result;
      } finally {
        // Release only this connection's mutex. Different OAuth identities can
        // refresh independently without sharing results.
        if (refreshInProgress.get(connectionSlug) === refresh) {
          refreshInProgress.delete(connectionSlug);
        }
      }
    } else {
      debug('[auth] No refresh token available, cannot refresh expired token');
      return { accessToken: null };
    }
  }

  return { accessToken: creds.accessToken };
}

/**
 * Get complete authentication state from all sources (config file + credential store)
 *
 * Uses LLM connections as the source of truth for auth type and credentials.
 * Falls back to legacy global credentials for backwards compatibility.
 */
export async function getAuthState(): Promise<AuthState> {
  const manager = getCredentialManager();
  const activeWorkspace = getActiveWorkspace();
  const adminUrl = getAdminUrl();
  const adminTokens = await manager.getAdminTokens();

  // Get the default LLM connection to determine auth type
  const defaultConnectionSlug = getDefaultLlmConnection();
  const connection = defaultConnectionSlug ? getLlmConnection(defaultConnectionSlug) : null;

  // Determine auth type from connection (no legacy fallback - migration ensures all users have connections)
  let effectiveAuthType: AuthType | null = null;
  if (connection) {
    // Any configured default connection counts as billing-configured,
    // including environment/IAM auth (Bedrock, Vertex).
    effectiveAuthType = toLegacyBillingType(connection.authType)
  }
  // No fallback to legacy config.authType - if no connection, return unauthenticated state

  // Check credentials based on the effective auth type and connection
  let hasCredentials = false;
  let apiKey: string | null = null;
  let claudeOAuthToken: string | null = null;
  let migrationRequired: MigrationInfo | undefined;

  if (connection && defaultConnectionSlug) {
    // Use LLM connection credentials
    // Pass providerType for OAuth routing (OpenAI OAuth needs idToken)
    hasCredentials = await manager.hasLlmCredentials(defaultConnectionSlug, connection.authType, connection.providerType);

    if (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint' || connection.authType === 'bearer_token') {
      apiKey = await manager.getLlmApiKey(defaultConnectionSlug);
      // Keyless providers (Ollama) are valid when a custom base URL is configured
      if (!apiKey && connection.baseUrl) {
        hasCredentials = true;
      }
    } else if (connection.authType === 'oauth') {
      const llmOAuth = await manager.getLlmOAuth(defaultConnectionSlug);
      if (llmOAuth?.accessToken) {
        claudeOAuthToken = llmOAuth.accessToken;
      }
    }
    // Other auth types (iam_credentials, service_account_file, environment, none) are handled by hasLlmCredentials
    // OpenAI / ChatGPT OAuth credentials are handled inside PiAgent's auth path
  } else {
    // No connection configured - credentials not available
    // Legacy migration should have created a default connection
    hasCredentials = false;
  }

  return {
    billing: {
      type: effectiveAuthType,
      hasCredentials,
      apiKey,
      claudeOAuthToken,
      migrationRequired,
    },
    workspace: {
      hasWorkspace: !!activeWorkspace,
      active: activeWorkspace,
    },
    admin: {
      configured: !!adminUrl,
      loggedIn: !!adminTokens,
      ...(adminTokens?.username ? { username: adminTokens.username } : {}),
    },
  };
}

/**
 * Derive what setup steps are needed based on current auth state
 */
export function getSetupNeeds(state: AuthState, setupDeferred?: boolean): SetupNeeds {
  if (state.admin.configured) {
    const needsAdminLogin = !state.admin.loggedIn;

    return {
      needsBillingConfig: false,
      needsCredentials: false,
      needsAdminLogin,
      isFullyConfigured: !needsAdminLogin && state.billing.type !== null,
      needsMigration: state.billing.migrationRequired,
    };
  }

  // Need billing config if no billing type is set
  const needsBillingConfig = state.billing.type === null;

  // Need credentials if billing type is set but credentials are missing
  const needsCredentials = state.billing.type !== null && !state.billing.hasCredentials;

  return {
    needsBillingConfig,
    needsCredentials,
    needsAdminLogin: false,
    // Fully configured if setup is complete OR user chose "Setup later"
    isFullyConfigured: (!needsBillingConfig && !needsCredentials) || !!setupDeferred,
    needsMigration: state.billing.migrationRequired,
  };
}

// ============================================
// Test helpers (exported for testing only)
// ============================================

/**
 * Reset the refresh mutex (for testing only)
 * This allows tests to start with a clean state
 */
export function _resetRefreshMutex(): void {
  refreshInProgress.clear();
}
