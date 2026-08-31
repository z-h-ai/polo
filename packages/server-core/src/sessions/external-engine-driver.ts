/**
 * ExternalEngineSessionDriver — the PRODUCTION driver for externally driven
 * sessions (e.g. a Codex CLI harness owns the model).
 *
 * Ownership contract (one owner/channel per engine): the driver is the
 * SINGLE owner of the session's per-turn sidecar — it spawns the session MCP
 * server process from the config the SessionManager hands it, holds that
 * one process for the whole turn, and exposes the model-visible toolset
 * through it. The SessionManager never runs a second copy, and embedded
 * engines never run one at all.
 *
 * Model interface: `listTools()` and `callTool()` are the surface a real
 * model/credential integration consumes — discovery of request_user_input
 * from the actual toolset and the tool call that flows stdio → HTTP callback
 * → the SessionManager durable handoff.
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

export class ExternalEngineSessionDriver {
  private constructor(
    // Loosely typed: the concrete MCP SDK Client satisfies this shape.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly client: any,
    private readonly transport: StdioClientTransport,
    readonly config: ExternalEngineToolsetConfig,
  ) {}

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

  /** The model-visible toolset (real discovery from the sidecar's tools/list). */
  async listTools(): Promise<ExternalEngineTool[]> {
    const tools = await this.client.listTools()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (tools.tools ?? []).map((t: any) => ({ name: t.name as string, description: t.description as string | undefined }))
  }

  /**
   * A model tool call (e.g. request_user_input) through the owned sidecar:
   * stdio → HTTP callback → SessionManager durable handoff. The returned
   * promise settles at the durable boundary.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: unknown }> {
    const result = await this.client.callTool({ name, arguments: args })
    return { isError: result.isError === true, content: result.content }
  }

  /** Stop the owned sidecar (turn end / session teardown). */
  async dispose(): Promise<void> {
    await this.client.close().catch(() => {})
  }
}
