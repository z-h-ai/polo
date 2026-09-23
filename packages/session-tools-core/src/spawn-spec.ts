/**
 * Session MCP server spawn spec — dependency-free leaf module.
 *
 * This is the SINGLE definition of the per-turn spawn contract for the
 * session MCP server subprocess. It lives in session-tools-core because
 * every consumer of the contract already depends on that package and it must
 * stay import-light: a barrel re-export here once pulled the whole agent
 * graph + koffi `.node` assets into the session server's outdir, breaking
 * `electron:build`. This module imports NOTHING.
 *
 * A spawner starts ONE server instance per turn and passes the turn's
 * request_user_input capability and processing generation as EXPLICIT
 * construct arguments — never ambient global state.
 */

/**
 * Per-turn spawn options for the session MCP server subprocess.
 */
export interface SessionMcpSpawnOptions {
  sessionId: string;
  workspaceRootPath: string;
  plansFolderPath: string;
  /** HTTP callback port for call_llm / request_user_input (optional). */
  callbackPort?: string;
  /**
   * Whether THIS turn may call request_user_input (desktop interactive
   * turns only). Omitted/false fails closed.
   */
  allowRequestUserInput?: boolean;
  /**
   * The processing generation of THIS turn — snapshotted into every
   * question_requested callback the server emits.
   */
  turnGeneration?: number;
}

/**
 * Build the argv for spawning `session-mcp-server` for one turn.
 * Pure function — the caller owns process.spawn and its lifecycle.
 */
export function buildSessionMcpServerArgs(options: SessionMcpSpawnOptions): string[] {
  const args = [
    '--session-id', options.sessionId,
    '--workspace-root', options.workspaceRootPath,
    '--plans-folder', options.plansFolderPath,
  ];
  if (options.callbackPort) {
    args.push('--callback-port', options.callbackPort);
  }
  if (options.allowRequestUserInput) {
    args.push('--allow-request-user-input');
  }
  if (options.turnGeneration !== undefined) {
    args.push('--turn-generation', String(options.turnGeneration));
  }
  return args;
}
