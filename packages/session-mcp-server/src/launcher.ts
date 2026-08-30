/**
 * Session MCP Server Launcher (review fix round 10, issue A).
 *
 * SELF-CONTAINED by design: this module must not import the
 * `@polo-ai/shared/agent` barrel (or anything else that reaches native
 * assets) — the session MCP server production bundle is a single light
 * file, and a barrel re-export here pulled the whole agent graph + koffi
 * `.node` assets into the outdir, breaking `electron:build`.
 *
 * The identical spawn-spec builder for the runtime resolver lives in
 * `@polo-ai/shared/agent` (session-lifecycle); keep the two copies in sync.
 */

/**
 * Per-turn spawn options for the session MCP server subprocess (the
 * Codex/external-harness path). The harness spawns ONE server instance per
 * turn and passes the turn's request_user_input capability and processing
 * generation as EXPLICIT construct arguments — never ambient global state.
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
