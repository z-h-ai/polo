/** Internal authority supplied by the verified desktop-managed CLI bootstrap. */
export type ToolExecutionPolicy = 'managed-file-only';
export const MANAGED_TOOL_UNSUPPORTED = 'POLO_MANAGED_TOOL_UNSUPPORTED: Polo CLI supports AI and Read/Write/Edit/Ls; Shell, scripts, MCP/Source and Skill execution are unavailable.';
export function isManagedFileTool(name: string): boolean {
  return ['read', 'write', 'edit', 'ls'].includes(name.toLowerCase());
}
