/**
 * Session MCP Server Launcher (review fix round 8, issue B)
 *
 * The canonical per-turn spawn constructor for the session MCP server
 * subprocess (the Codex/external-harness path). The harness spawns ONE server
 * instance per turn and passes the turn's request_user_input capability and
 * processing generation as EXPLICIT construct arguments — never ambient
 * global state — so the per-turn capability filter and the durable question
 * handoff behave exactly like the Claude/Pi paths:
 *
 * - desktop turn        → `--allow-request-user-input` + `--turn-generation N`
 * - any other source    → neither flag (fail closed; the tool is not
 *                         registered and the callback chain stays dormant)
 */

export interface SessionMcpSpawnOptions {
  sessionId: string;
  workspaceRootPath: string;
  plansFolderPath: string;
  /** HTTP callback port for call_llm (optional). */
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
