/**
 * Proxy Tool Registry (pi-agent-server subprocess)
 *
 * Maintains proxy tool definitions from the main process in two separate
 * scopes with explicit semantics:
 *
 * - `session` — REPLACED wholesale on every registration. The main process
 *   always sends the complete session-tool set; anything omitted (e.g.
 *   `request_user_input` on messaging/automation/headless turns) is removed.
 *   This is what makes the per-turn invocation-source capability bit
 *   fail-closed on the Pi path.
 * - `pool` — MERGED by name (existing behavior for MCP/API source tools,
 *   which arrive incrementally from the McpClientPool).
 *
 * The effective tool list is the union of both scopes. Any mutation flags
 * `toolsChanged` so `handlePrompt` recreates the Pi session before the next
 * turn picks up the new set.
 */

export interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type ProxyToolScope = 'session' | 'pool';

export class ProxyToolRegistry {
  private sessionTools: ProxyToolDef[] = [];
  private poolTools: ProxyToolDef[] = [];
  private defs: ProxyToolDef[] = [];
  private changed = false;

  /**
   * Register tools for a scope. `session` replaces the scope's tool set;
   * `pool` merges by name. Returns the number of effective tools.
   */
  register(scope: ProxyToolScope, tools: ProxyToolDef[]): number {
    if (scope === 'session') {
      // Explicit replace: the sender owns the complete session-tool set.
      this.sessionTools = [...tools];
    } else {
      const incoming = new Map(tools.map(t => [t.name, t]));
      this.poolTools = [
        ...this.poolTools.filter(t => !incoming.has(t.name)),
        ...tools,
      ];
    }
    this.rebuild();
    return this.defs.length;
  }

  private rebuild(): void {
    const next = [...this.sessionTools, ...this.poolTools];
    if (next.length !== this.defs.length || next.some((t, i) => t.name !== this.defs[i]?.name)) {
      this.changed = true;
    }
    this.defs = next;
  }

  /** Effective proxy tool definitions (session + pool). */
  get tools(): ProxyToolDef[] {
    return this.defs;
  }

  /** Whether the effective set changed since the last consume. */
  get toolsChanged(): boolean {
    return this.changed;
  }

  /** Clear the changed flag (after the Pi session has been recreated). */
  markConsumed(): void {
    this.changed = false;
  }

  has(name: string): boolean {
    return this.defs.some(t => t.name === name);
  }
}
