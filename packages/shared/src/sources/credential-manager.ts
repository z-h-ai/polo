/**
 * SourceCredentialManager
 *
 * Unified credential management for sources. Consolidates credential CRUD,
 * credential ID resolution, expiry checking, and OAuth flows.
 *
 * This replaces scattered credential logic across:
 * - SourceService.getSourceToken()
 * - SourceService.getApiCredential()
 * - SourceService.getCredentialId()
 * - session-scoped-tools OAuth triggers
 * - IPC handlers for credential storage
 */

import {
  isApiOAuthProvider,
  hasRenewEndpoint,
  type LoadedSource,
} from './types.ts';
import { buildAuthorizationHeader } from './api-tools.ts';
import type { CredentialId, StoredCredential } from '../credentials/types.ts';
import { getCredentialManager } from '../credentials/index.ts';
import { debug } from '../utils/debug.ts';
import { loadSourceConfig, saveSourceConfig } from './storage.ts';

/**
 * Result of authentication attempt
 */
export interface AuthResult {
  success: boolean;
  error?: string;
  /** For Gmail OAuth, includes user's email */
  email?: string;
}

export interface SourceAuthCallbacks {
  onStatus: (message: string) => void;
  onError: (error: string) => void;
}

/**
 * API credential types (string for simple auth, object for basic auth or multi-header)
 */
export interface BasicAuthCredential {
  username: string;
  password: string;
}

/**
 * Multi-header credentials stored as Record<string, string>
 * Used for APIs like Datadog that require multiple auth headers (DD-API-KEY + DD-APPLICATION-KEY)
 */
export type MultiHeaderCredential = Record<string, string>;

export type ApiCredential = string | BasicAuthCredential | MultiHeaderCredential;

/**
 * Type guard to check if credential is a MultiHeaderCredential.
 * Returns true for Record<string, string> objects that are NOT BasicAuthCredential.
 */
export function isMultiHeaderCredential(cred: ApiCredential): cred is MultiHeaderCredential {
  return (
    typeof cred === 'object' &&
    cred !== null &&
    !('username' in cred && 'password' in cred)
  );
}

/**
 * SourceCredentialManager - unified credential operations for sources
 *
 * Usage:
 * ```typescript
 * const credManager = new SourceCredentialManager();
 *
 * // Save credentials
 * await credManager.save(source, { value: 'token123' });
 *
 * // Load credentials
 * const cred = await credManager.load(source);
 *
 * // Run OAuth flow
 * const result = await credManager.authenticate(source, {
 *   onStatus: (msg) => console.log(msg),
 *   onError: (err) => console.error(err),
 * });
 * ```
 */
export class SourceCredentialManager {
  // Track in-flight refresh promises to prevent concurrent refreshes for the same source
  // This prevents race conditions (especially important for Microsoft which rotates refresh tokens)
  private pendingRefreshes = new Map<string, Promise<string | null>>();

  // ============================================================
  // Core CRUD Operations
  // ============================================================

  /**
   * Save credential for a source
   */
  async save(source: LoadedSource, credential: StoredCredential): Promise<void> {
    const credentialId = this.getCredentialId(source);
    const manager = getCredentialManager();
    await manager.set(credentialId, credential);
    debug(`[SourceCredentialManager] Saved ${credentialId.type} for ${source.config.slug}`);
  }

  /**
   * Load credential for a source
   *
   * For MCP sources, tries both OAuth and bearer credentials as fallback
   * (credentials may have been stored via different auth modes)
   */
  async load(source: LoadedSource): Promise<StoredCredential | null> {
    const manager = getCredentialManager();

    // For MCP sources, try both OAuth and bearer credentials
    // (stdio transport doesn't need credentials)
    if (source.config.type === 'mcp' && source.config.mcp?.transport !== 'stdio' && source.config.mcp?.authType !== 'none') {
      return this.loadMcpCredential(source);
    }

    // API sources with authType:'none' must never read the shared source_apikey
    // slot. 'none', 'header', and 'query' all map to source_apikey for storage
    // compatibility; reading here would resurrect stale header/query credentials
    // after a source is switched to public/default-header auth.
    if (source.config.type === 'api' && source.config.api?.authType === 'none') {
      debug(`[SourceCredentialManager] Skipping credential load for public API source ${source.config.slug}`);
      return null;
    }

    // For other sources, use the credential ID based on authType
    const credentialId = this.getCredentialId(source);
    const cred = await manager.get(credentialId);

    if (cred) {
      debug(`[SourceCredentialManager] Found ${credentialId.type} for ${source.config.slug}`);
    }

    return cred;
  }

  /**
   * Load MCP credential with fallback (OAuth -> bearer)
   */
  private async loadMcpCredential(source: LoadedSource): Promise<StoredCredential | null> {
    const manager = getCredentialManager();
    const baseId = {
      workspaceId: source.workspaceId,
      sourceId: source.config.slug,
    };

    // Try OAuth first
    const oauthCreds = await manager.get({ type: 'source_oauth', ...baseId });
    if (oauthCreds?.value) {
      debug(`[SourceCredentialManager] Found source_oauth for ${source.config.slug}`);
      return oauthCreds;
    }

    // Fall back to bearer
    const bearerCreds = await manager.get({ type: 'source_bearer', ...baseId });
    if (bearerCreds?.value) {
      debug(`[SourceCredentialManager] Found source_bearer for ${source.config.slug}`);
      return bearerCreds;
    }

    debug(`[SourceCredentialManager] No credential found for MCP source ${source.config.slug}`);
    return null;
  }

  /**
   * Delete credential for a source
   */
  async delete(source: LoadedSource): Promise<boolean> {
    const credentialId = this.getCredentialId(source);
    const manager = getCredentialManager();
    const deleted = await manager.delete(credentialId);
    if (deleted) {
      debug(`[SourceCredentialManager] Deleted ${credentialId.type} for ${source.config.slug}`);
    }
    return deleted;
  }

  /**
   * Delete credential for a source synchronously.
   * Used by sync config-save paths to avoid stale credential reads on immediate reload.
   */
  deleteSync(source: LoadedSource): boolean {
    const credentialId = this.getCredentialId(source);
    const manager = getCredentialManager();
    const deleted = manager.deleteSync(credentialId);
    if (deleted) {
      debug(`[SourceCredentialManager] Deleted ${credentialId.type} for ${source.config.slug}`);
    }
    return deleted;
  }

  /**
   * Get token value for a source (convenience method)
   * Returns null if no credential exists or if expired
   */
  async getToken(source: LoadedSource): Promise<string | null> {
    const cred = await this.load(source);
    if (!cred?.value) return null;

    // Check expiry
    if (this.isExpired(cred)) {
      debug(`[SourceCredentialManager] Token expired for ${source.config.slug}`);
      return null;
    }

    return cred.value;
  }

  /**
   * Get API credential for a source (handles basic auth and multi-header JSON parsing)
   */
  async getApiCredential(source: LoadedSource): Promise<ApiCredential | null> {
    const cred = await this.load(source);
    // Check both API and MCP headerNames (same credential store pattern)
    const headerNames = source.config.api?.headerNames || source.config.mcp?.headerNames;
    debug(`[SourceCredentialManager] getApiCredential for ${source.config.slug}: cred.value exists=${!!cred?.value}, headerNames=${JSON.stringify(headerNames)}`);
    if (!cred?.value) return null;

    // Check for multi-header auth (JSON with header names as keys)
    // Works for both API sources (api.headerNames) and MCP sources (mcp.headerNames)
    if (headerNames?.length) {
      debug(`[SourceCredentialManager] Attempting multi-header parse for ${source.config.slug}, raw value length=${cred.value.length}`);
      try {
        const parsed = JSON.parse(cred.value);
        debug(`[SourceCredentialManager] Parsed JSON keys: ${Object.keys(parsed).join(', ')}`);
        // Validate all required headers are present
        const hasAllHeaders = headerNames.every((h) => h in parsed);
        debug(`[SourceCredentialManager] hasAllHeaders=${hasAllHeaders}`);
        if (hasAllHeaders) {
          return parsed as MultiHeaderCredential;
        }
      } catch (e) {
        // Not JSON, fall through to other auth types
        debug(`[SourceCredentialManager] JSON parse failed: ${e}`);
      }
    }

    // Check for basic auth (JSON with username/password)
    if (source.config.api?.authType === 'basic') {
      try {
        const parsed = JSON.parse(cred.value);
        if (parsed.username && parsed.password) {
          return parsed as BasicAuthCredential;
        }
      } catch {
        // Not JSON, treat as regular credential
      }
    }

    return cred.value;
  }

  // ============================================================
  // Credential ID Resolution
  // ============================================================

  /**
   * Get the credential ID for a source
   *
   * Determines the correct credential type based on:
   * - Source type (mcp, api, local)
   * - Auth type (oauth, bearer, header, etc.)
   */
  getCredentialId(source: LoadedSource): CredentialId {
    const mcp = source.config.mcp;
    const api = source.config.api;

    let type: CredentialId['type'];

    if (source.config.type === 'mcp') {
      type = mcp?.authType === 'bearer' ? 'source_bearer' : 'source_oauth';
    } else if (source.config.type === 'api') {
      // Order matters: provider-specific checks first, then generic OAuth fallback
      if (isApiOAuthProvider(source.config.provider)) {
        type = 'source_oauth';
      } else if (api?.authType === 'oauth') {
        // Generic OAuth API sources — explicit config or auto-discovery
        type = 'source_oauth';
      } else if (api?.authType === 'bearer') {
        type = 'source_bearer';
      } else if (api?.authType === 'basic') {
        type = 'source_basic';
      } else {
        // header, query, or other → stored as apikey
        type = 'source_apikey';
      }
    } else {
      type = 'source_oauth';
    }

    return {
      type,
      workspaceId: source.workspaceId,
      sourceId: source.config.slug,
    };
  }

  // ============================================================
  // Expiry Checking
  // ============================================================

  /**
   * Check if a credential is expired
   */
  isExpired(credential: StoredCredential): boolean {
    if (!credential.expiresAt) return false;
    return Date.now() > credential.expiresAt;
  }

  /**
   * Check if a credential needs refresh (within 5 min of expiry)
   */
  needsRefresh(credential: StoredCredential): boolean {
    if (!credential.expiresAt) return false;
    const fiveMinutes = 5 * 60 * 1000;
    return Date.now() > credential.expiresAt - fiveMinutes;
  }

  /**
   * Mark a source as needing re-authentication.
   * Called when token is missing/expired or token refresh fails.
   * Updates config.json so the UI shows "needs auth" and the agent gets proper context.
   */
  markSourceNeedsReauth(source: LoadedSource, errorMessage: string): void {
    try {
      const config = loadSourceConfig(source.workspaceRootPath, source.config.slug);
      if (config) {
        config.isAuthenticated = false;
        config.connectionStatus = 'needs_auth';
        config.connectionError = errorMessage;
        saveSourceConfig(source.workspaceRootPath, config);
        debug(`[SourceCredentialManager] Marked ${source.config.slug} as needing re-auth: ${errorMessage}`);
      }
    } catch (error) {
      debug(`[SourceCredentialManager] Failed to mark ${source.config.slug} as needing re-auth:`, error);
    }
  }

  /**
   * Check if source has valid (non-expired) credentials
   */
  async hasValidCredentials(source: LoadedSource): Promise<boolean> {
    const token = await this.getToken(source);
    return token !== null;
  }

  async authenticate(
    source: LoadedSource,
    callbacks?: SourceAuthCallbacks,
    _sessionContext?: unknown
  ): Promise<AuthResult> {
    const defaultCallbacks: SourceAuthCallbacks = {
      onStatus: (msg) => debug(`[SourceCredentialManager] ${msg}`),
      onError: (err) => debug(`[SourceCredentialManager] Error: ${err}`),
    };
    const cb = callbacks || defaultCallbacks;

    const message = `Source ${source.config.slug} cannot start an OAuth flow in this build`;
    cb.onError(message);
    return { success: false, error: message };
  }

  /**
   * Refresh token for a source
   *
   * Returns the new access token, or null if refresh fails.
   * On success, credentials are automatically updated.
   *
   * Uses promise deduplication to prevent concurrent refresh requests for the same source.
   * This is important because:
   * - Multiple API calls may hit refresh simultaneously when token is expiring
   * - Microsoft rotates refresh tokens, so concurrent refreshes could cause token invalidation
   */
  async refresh(source: LoadedSource): Promise<string | null> {
    const key = source.config.slug;

    // Return existing refresh promise if one is in progress
    const pending = this.pendingRefreshes.get(key);
    if (pending) {
      debug(`[SourceCredentialManager] Reusing pending refresh for ${key}`);
      return pending;
    }

    // Create and track new refresh promise
    const refreshPromise = this.doRefresh(source).finally(() => {
      this.pendingRefreshes.delete(key);
    });

    this.pendingRefreshes.set(key, refreshPromise);
    return refreshPromise;
  }

  /**
   * Internal refresh implementation
   */
  private async doRefresh(source: LoadedSource): Promise<string | null> {
    const cred = await this.load(source);
    if (!cred) {
      debug(`[SourceCredentialManager] No credential for ${source.config.slug}`);
      return null;
    }

    // API renew endpoint (non-OAuth token refresh) — check before provider routing.
    // These sources may not have a separate refreshToken; they use the current
    // access token for renewal.
    if (hasRenewEndpoint(source)) {
      return this.refreshApiRenew(source, cred);
    }

    // For all other refresh strategies, a refreshToken is required.
    if (!cred.refreshToken) {
      debug(`[SourceCredentialManager] No refresh token for ${source.config.slug}`);
      return null;
    }

    if (
      isApiOAuthProvider(source.config.provider) ||
      source.config.api?.authType === 'oauth' ||
      (source.config.type === 'mcp' && source.config.mcp?.authType === 'oauth')
    ) {
      this.markSourceNeedsReauth(source, 'OAuth token refresh is no longer supported');
    }

    return null;
  }

  /**
   * Refresh token via a custom API renew endpoint (non-OAuth).
   * Uses the current access token for renewal — no separate refresh token needed.
   */
  private async refreshApiRenew(
    source: LoadedSource,
    cred: StoredCredential,
  ): Promise<string | null> {
    const renewConfig = source.config.api?.renewEndpoint;
    if (!renewConfig?.path) return null;

    const baseUrl = source.config.api!.baseUrl;
    const authScheme = source.config.api!.authScheme;
    const currentToken = cred.value;

    try {
      // 1. Resolve URL
      const url = renewConfig.path.startsWith('http')
        ? renewConfig.path
        : new URL(renewConfig.path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();

      // 2. Build headers: defaultHeaders < renewEndpoint.headers < Authorization
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...source.config.api!.defaultHeaders,
        ...substituteTokenInHeaders(renewConfig.headers, currentToken),
      };
      // Add Authorization unless explicitly overridden in renewEndpoint.headers
      if (!renewConfig.headers?.['Authorization'] && !renewConfig.headers?.['authorization']) {
        headers['Authorization'] = buildAuthorizationHeader(authScheme, currentToken);
      }

      // 3. Build body with {{token}} substitution
      const method = renewConfig.method ?? 'POST';
      const fetchOptions: RequestInit = { method, headers };
      if (renewConfig.body && method !== 'GET') {
        fetchOptions.body = JSON.stringify(substituteTokenInBody(renewConfig.body, currentToken));
      }

      // 4. Execute
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Renew endpoint returned ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const json = await response.json() as Record<string, unknown>;

      // 5. Extract new token
      const tokenField = renewConfig.tokenField ?? 'access_token';
      const newToken = json[tokenField];
      if (typeof newToken !== 'string' || !newToken) {
        throw new Error(`Renew response missing "${tokenField}" field`);
      }

      // 6. Extract expiry
      const expiresInField = renewConfig.expiresInField ?? 'expires_in';
      const expiresInRaw = json[expiresInField];
      let expiresAt: number | undefined;
      if (typeof expiresInRaw === 'number' && expiresInRaw > 0) {
        expiresAt = Date.now() + expiresInRaw * 1000;
      } else if (renewConfig.fallbackTtlSecs) {
        expiresAt = Date.now() + renewConfig.fallbackTtlSecs * 1000;
      }
      // If neither is available, expiresAt stays undefined — needsRefresh() will
      // trigger refresh on next session start (safe but noisy).

      // 7. Save updated credential
      await this.save(source, {
        ...cred,
        value: newToken,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
      });

      debug(`[SourceCredentialManager] Refreshed token via renew endpoint for ${source.config.slug}`);
      return newToken;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debug(`[SourceCredentialManager] Renew endpoint refresh failed for ${source.config.slug}:`, error);
      this.markSourceNeedsReauth(source, `Token refresh failed: ${errorMsg}`);
      return null;
    }
  }

}

// ============================================================
// Token substitution helpers for renew endpoint
// ============================================================

/**
 * Recursively substitute {{token}} in string leaves of an object.
 * Supports nested objects and arrays.
 */
function substituteTokenInBody(obj: Record<string, unknown>, token: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = value.replace(/\{\{token\}\}/g, token);
    } else if (Array.isArray(value)) {
      result[key] = value.map(item =>
        typeof item === 'string' ? item.replace(/\{\{token\}\}/g, token) :
          (item && typeof item === 'object' ? substituteTokenInBody(item as Record<string, unknown>, token) : item)
      );
    } else if (value && typeof value === 'object') {
      result[key] = substituteTokenInBody(value as Record<string, unknown>, token);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Substitute {{token}} in header values.
 */
function substituteTokenInHeaders(
  headers: Record<string, string> | undefined,
  token: string,
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = value.replace(/\{\{token\}\}/g, token);
  }
  return result;
}

// ============================================================
// Helper Functions
// ============================================================

/**
 * Check if a single source needs authentication.
 * Returns true if the source requires auth but isn't yet authenticated.
 *
 * This is the **inverse** of the auth portion of isSourceUsable().
 * - isSourceUsable() → Is the source ready to use? (enabled AND auth OK)
 * - sourceNeedsAuthentication() → Does the source need auth to become usable?
 *
 * Use this to prompt users for authentication, not for filtering sources.
 * For filtering sources, use isSourceUsable() from storage.ts.
 *
 * This correctly handles:
 * - MCP sources with authType: "none" → never needs auth
 * - MCP sources with stdio transport → never needs auth (runs locally)
 * - MCP sources with oauth/bearer → needs auth if not authenticated
 * - API sources with authType: "none" → never needs auth
 * - API sources with bearer/basic/header/query auth → needs auth if not authenticated
 */
export function sourceNeedsAuthentication(source: LoadedSource): boolean {
  const mcp = source.config.mcp;
  const api = source.config.api;

  // MCP sources with oauth/bearer auth (stdio transport never needs auth)
  if (source.config.type === 'mcp' && mcp) {
    if (mcp.transport === 'stdio') {
      // Stdio sources run locally and don't need authentication
      return false;
    }
    // Only require auth if authType is explicitly set to 'oauth' or 'bearer'
    // Undefined or 'none' means no authentication required
    if (mcp.authType && mcp.authType !== 'none' && !source.config.isAuthenticated) {
      return true;
    }
  }

  // API sources with auth requirements
  if (source.config.type === 'api' && api) {
    if (api.authType !== 'none' && api.authType !== undefined && !source.config.isAuthenticated) {
      return true;
    }
  }

  return false;
}

/**
 * Get sources that need authentication
 * Returns enabled sources that require auth but aren't yet authenticated
 */
export function getSourcesNeedingAuth(sources: LoadedSource[]): LoadedSource[] {
  return sources.filter((source) => {
    if (!source.config.enabled) return false;
    return sourceNeedsAuthentication(source);
  });
}

// Singleton instance
let instance: SourceCredentialManager | null = null;

/**
 * Get shared SourceCredentialManager instance
 */
export function getSourceCredentialManager(): SourceCredentialManager {
  if (!instance) {
    instance = new SourceCredentialManager();
  }
  return instance;
}
