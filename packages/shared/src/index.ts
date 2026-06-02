/**
 * @polo-ai/shared
 *
 * Shared business logic for Polo AI.
 * Used by the Electron app.
 *
 * Import specific modules via subpath exports:
 *   import { PoloAi } from '@polo-ai/shared/agent';
 *   import { loadStoredConfig } from '@polo-ai/shared/config';
 *   import { getCredentialManager } from '@polo-ai/shared/credentials';
 *   import { PoloMcpClient } from '@polo-ai/shared/mcp';
 *   import { debug } from '@polo-ai/shared/utils';
 *   import { loadSource, createSource, getSourceCredentialManager } from '@polo-ai/shared/sources';
 *   import { createWorkspace, loadWorkspace } from '@polo-ai/shared/workspaces';
 *
 * Available modules:
 *   - agent: PoloAi SDK wrapper, plan tools
 *   - auth: OAuth, token management, auth state
 *   - clients: Polo AI API client
 *   - config: Storage, models, preferences
 *   - credentials: Encrypted credential storage
 *   - mcp: MCP client, connection validation
 *   - prompts: System prompt generation
 *   - sources: Workspace-scoped source management (MCP, API, local)
 *   - utils: Debug logging, file handling, summarization
 *   - validation: URL validation
 *   - version: Version and installation management
 *   - workspaces: Workspace management (top-level organizational unit)
 */

// Export branding (standalone, no dependencies)
export * from './branding.ts';
