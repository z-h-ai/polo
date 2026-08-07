/**
 * Built-in Sources
 *
 * System-level sources that are always available in every workspace.
 * These sources are not shown in the sources list UI but are available
 * for the agent to use.
 *
 * NOTE: polo-ai-docs is now an always-available MCP server configured
 * directly in polo-ai.ts, not a source. This file is kept for backwards
 * compatibility but returns empty results.
 */

import type { LoadedSource, FolderSourceConfig } from './types.ts';

/**
 * Get all built-in sources for a workspace.
 *
 * Currently returns empty array - polo-ai-docs has been moved to
 * an always-available MCP server in polo-ai.ts.
 *
 * @param _workspaceId - The workspace ID (unused)
 * @param _workspaceRootPath - Absolute path to workspace root folder (unused)
 * @returns Empty array (no built-in sources)
 */
export function getBuiltinSources(_workspaceId: string, _workspaceRootPath: string): LoadedSource[] {
  return [];
}

/**
 * Get the built-in Polo AI docs source.
 *
 * @deprecated polo-ai-docs is now an always-available MCP server
 * configured directly in polo-ai.ts. This function is kept for
 * backwards compatibility but returns a placeholder.
 */
export function getDocsSource(workspaceId: string, workspaceRootPath: string): LoadedSource {
  // Return a placeholder - this shouldn't be called anymore
  const placeholderConfig: FolderSourceConfig = {
    id: 'builtin-polo-ai-docs',
    name: 'Polo AI Docs',
    slug: 'polo-ai-docs',
    enabled: false,
    provider: 'mintlify',
    type: 'mcp',
    mcp: {
      transport: 'http',
      url: 'https://app.polo.z-h-ai.com/docs/mcp',
      authType: 'none',
    },
    tagline: 'Search Polo AI documentation and source setup guides',
    icon: '📚',
    isAuthenticated: true,
    connectionStatus: 'connected',
  };

  return {
    workspaceId,
    workspaceRootPath,
    folderPath: '',
    config: placeholderConfig,
    guide: { raw: '' },
    isBuiltin: true,
  };
}

/**
 * Check if a source slug is a built-in source.
 *
 * Returns false - polo-ai-docs is now an always-available MCP server,
 * not a source in the sources system.
 *
 * @param _slug - Source slug to check (unused)
 * @returns false (no built-in sources)
 */
export function isBuiltinSource(_slug: string): boolean {
  return false;
}
