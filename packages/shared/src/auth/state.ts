/**
 * Unified Auth State Management
 *
 * Provides a single source of truth for all authentication state:
 * - Billing configuration
 * - Workspace/MCP configuration
 *
 * MIGRATION NOTE (v0.3.0+):
 * We no longer support tokens from Claude CLI / Claude Desktop.
 * Users with legacy tokens must sign in again through Admin-managed config.
 */

import { getCredentialManager } from '../credentials/index.ts';
import {
  loadStoredConfig,
  getActiveWorkspace,
  getDefaultLlmConnection,
  getLlmConnection,
  type AuthType,
  type Workspace,
} from '../config/storage.ts';
import { isPlatformMode } from './platform.ts';

function toLegacyBillingType(
  authType: NonNullable<ReturnType<typeof getLlmConnection>>['authType'],
): AuthType {
  switch (authType) {
    case 'api_key':
    case 'api_key_with_endpoint':
    case 'bearer_token':
    case 'iam_credentials':
    case 'service_account_file':
    case 'environment':
    case 'none':
      return 'api_key'
    default:
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

export interface AuthState {
  /** Claude API billing configuration */
  billing: {
    /** Configured billing type, or null if not yet configured */
    type: AuthType | null;
    /** True if we have the required credentials for the configured billing type */
    hasCredentials: boolean;
    /** Anthropic API key (if using api_key auth type) */
    apiKey: string | null;
    /** Migration info if user needs to re-authenticate */
    migrationRequired?: MigrationInfo;
  };

  /** Workspace/MCP configuration */
  workspace: {
    hasWorkspace: boolean;
    active: Workspace | null;
  };
}

export interface SetupNeeds {
  /** No billing type configured → show billing picker */
  needsBillingConfig: boolean;
  /** Billing type set but missing credentials → show credential entry */
  needsCredentials: boolean;
  /** Everything complete → go straight to App */
  isFullyConfigured: boolean;
  /** User has legacy tokens that need migration */
  needsMigration?: MigrationInfo;
}

/**
 * Get complete authentication state from all sources (config file + credential store)
 *
 * Uses LLM connections as the source of truth for auth type and credentials.
 * Falls back to legacy global credentials for backwards compatibility.
 *
 * In platform mode (PLATFORM_ANTHROPIC_API_KEY set), returns a fully-configured
 * state so the UI never shows "configure billing" prompts.
 */
export async function getAuthState(): Promise<AuthState> {
  // Platform mode: the API key is injected via env — treat as fully configured
  if (isPlatformMode()) {
    const activeWorkspace = getActiveWorkspace();
    return {
      billing: {
        type: 'api_key',
        hasCredentials: true,
        apiKey: null, // raw key is never exposed to the renderer
      },
      workspace: {
        hasWorkspace: !!activeWorkspace,
        active: activeWorkspace,
      },
    };
  }

  const config = loadStoredConfig();
  const manager = getCredentialManager();
  const activeWorkspace = getActiveWorkspace();

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
  let migrationRequired: MigrationInfo | undefined;

  if (connection && defaultConnectionSlug) {
    // Use LLM connection credentials
    hasCredentials = await manager.hasLlmCredentials(defaultConnectionSlug, connection.authType, connection.providerType);

    if (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint' || connection.authType === 'bearer_token') {
      apiKey = await manager.getLlmApiKey(defaultConnectionSlug);
    }
    // Other auth types (iam_credentials, service_account_file, environment, none) are handled by hasLlmCredentials
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
      migrationRequired,
    },
    workspace: {
      hasWorkspace: !!activeWorkspace,
      active: activeWorkspace,
    },
  };
}

/**
 * Derive what setup steps are needed based on current auth state
 *
 * In platform mode (PLATFORM_ANTHROPIC_API_KEY set), always returns fully-configured
 * so the onboarding / billing setup steps are skipped entirely.
 */
export function getSetupNeeds(state: AuthState, setupDeferred?: boolean): SetupNeeds {
  // Platform mode: the API key is injected via env — skip all onboarding steps
  if (isPlatformMode()) {
    return {
      isFullyConfigured: true,
      needsBillingConfig: false,
      needsCredentials: false,
      needsMigration: undefined,
    };
  }

  // Need billing config if no billing type is set
  const needsBillingConfig = state.billing.type === null;

  // Need credentials if billing type is set but credentials are missing
  const needsCredentials = state.billing.type !== null && !state.billing.hasCredentials;

  return {
    needsBillingConfig,
    needsCredentials,
    // Fully configured if setup is complete OR user chose "Setup later"
    isFullyConfigured: (!needsBillingConfig && !needsCredentials) || !!setupDeferred,
    needsMigration: state.billing.migrationRequired,
  };
}
