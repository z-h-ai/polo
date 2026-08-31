/**
 * ExternalEngineSessionDriver — the PRODUCTION driver for externally driven
 * sessions (e.g. a Codex CLI harness owns the model).
 *
 * Ownership contract (one owner/channel per engine): the driver is the
 * SINGLE owner of the session's per-turn sidecar — it spawns the session MCP
 * server process from the config the SessionManager hands it, holds that
 * one process for the whole turn, and runs the model turn against the
 * model-visible toolset it serves. The SessionManager never runs a second
 * copy, and embedded engines never run one at all.
 *
 * Model interface: the driver runs one model turn via
 * {@link ExternalEngineModelTurn} — the credentials/model layer consumes
 * toolset discovery and issues tool calls (request_user_input flows stdio →
 * HTTP callback → the SessionManager durable handoff).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

export interface ExternalEngineToolsetConfig {
  command: string
  args: string[]
  callbackPort: number
}

export interface ExternalEngineTool {
  name: string
  description?: string
}

/**
 * The MODEL layer of an external engine (credentials/LLM integration). The
 * driver serves the toolset; the model decides which tools to call and when
 * the turn is finished.
 */
export interface ExternalEngineModelTurn {
  runModelTurn(input: {
    prompt: string
    /** Real toolset discovery against the driver-owned sidecar. */
    listTools(): Promise<ExternalEngineTool[]>
    /** Real tool call: stdio → HTTP callback → durable handoff. */
    callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: unknown }>
  }): Promise<void>
}

export class ExternalEngineSessionDriver {
  /** Live (launched, not yet disposed) driver instances — production
   * diagnostic for the one-live-sidecar-per-turn invariant. */
  private static live = new Set<ExternalEngineSessionDriver>()

  private constructor(
    // Loosely typed: the concrete MCP SDK Client satisfies this shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly client: any,
    private readonly transport: StdioClientTransport,
    readonly config: ExternalEngineToolsetConfig,
  ) {
    ExternalEngineSessionDriver.live.add(this)
  }

  /** Number of live (owned, undisposed) sidecars across all sessions. */
  static activeCount(): number {
    return ExternalEngineSessionDriver.live.size
  }

  /**
   * Launch the turn's sidecar (the model's MCP toolset provider) — ONE
   * process, owned by this driver for the whole turn. Resolves only when the
   * sidecar has completed its MCP handshake.
   */
  static async launch(config: ExternalEngineToolsetConfig): Promise<ExternalEngineSessionDriver> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      stderr: 'pipe',
    })
    const client = new Client({ name: 'polo-external-engine-driver', version: '1.0.0' })
    await client.connect(transport)
    return new ExternalEngineSessionDriver(client, transport, config)
  }

  /**
   * PRODUCTION MODEL TURN ENTRY: starts the model (the injected model layer)
   * against the driver-owned toolset with the turn's prompt. The model may
   * call request_user_input — that tool call travels stdio → HTTP callback →
   * the SessionManager durable handoff and its tool result settles at the
   * durable boundary. Resolves when the model finishes its turn.
   */
  async runModelTurn(prompt: string, model: ExternalEngineModelTurn): Promise<void> {
    await model.runModelTurn({
      prompt,
      listTools: () => this.listTools(),
      callTool: (name, args) => this.callTool(name, args),
    })
  }

  /** The model-visible toolset (real discovery from the sidecar's tools/list). */
  private async listTools(): Promise<ExternalEngineTool[]> {
    const tools = await this.client.listTools()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (tools.tools ?? []).map((t: any) => ({ name: t.name as string, description: t.description as string | undefined }))
  }

  /**
   * A model tool call through the owned sidecar: stdio → HTTP callback →
   * SessionManager durable handoff. The returned promise settles at the
   * durable boundary.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: unknown }> {
    const result = await this.client.callTool({ name, arguments: args })
    return { isError: result.isError === true, content: result.content }
  }

  /** Stop the owned sidecar (turn end / session teardown). */
  async dispose(): Promise<void> {
    ExternalEngineSessionDriver.live.delete(this)
    await this.client.close().catch(() => {})
  }
}
