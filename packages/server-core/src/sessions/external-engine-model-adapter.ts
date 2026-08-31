/**
 * Production model adapters for externally driven sessions.
 *
 * `createCodexSessionModelTurn` runs the actual model turn: it starts a real
 * Codex session process whose toolset is the driver-owned session MCP
 * sidecar — exposed to the Codex process over its stdio through a 1:1 MCP
 * proxy that the driver mediates. The Codex model therefore discovers the
 * request_user_input JSON schema natively from tools/list and its tool call
 * travels proxy → sidecar → HTTP callback → the SessionManager durable
 * handoff. The Codex process exiting is the model turn's completion (the
 * completion identity — generation + driver — is bound by the caller). An
 * ACCEPTED request_user_input handoff settles the turn itself: the model
 * process is terminated there, because the pending question is durable and
 * the answer path owns the continuation as a new generation.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

export interface ExternalEngineTool {
  name: string
  description?: string
}

export interface ExternalEngineMcpConfig {
  command: string
  args: string[]
  callbackPort: number
}

/**
 * The REAL model session turn for externally driven sessions: starts a
 * Codex session process whose toolset is the driver-owned session MCP
 * sidecar (natively registered over its stdio proxy), so the model
 * discovers the request_user_input JSON schema via tools/list and its tool
 * call flows proxy → sidecar → HTTP callback → the durable handoff.
 */
export interface ExternalEngineModelTurn {
  start(input: {
    sessionId: string
    prompt: string
    sessionMcpConfig: ExternalEngineMcpConfig
    listTools(): Promise<ExternalEngineTool[]>
    callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: unknown }>
  }): Promise<void>
}

/**
 * The tool whose ACCEPTED durable handoff pauses (ends) the model turn. The
 * handoff persists the pending question and hands the continuation to the
 * answer path (a new generation), so the model session must not consume a
 * synthetic "waiting" result and keep producing output before the user has
 * answered.
 */
const QUESTION_HANDOFF_TOOL = 'request_user_input'

/** The real model session turn: start the Codex process against the owned toolset. */
export interface CodexSessionModelTurnOptions {
  /**
   * Resolve the Codex CLI command for this runtime. Production bootstrap
   * registers the packaged binary; returning null degrades deterministically
   * (the turn ends without model output; the message stays persisted).
   */
  resolveCodexCommand: (sessionId: string) => { command: string; args: string[]; env?: Record<string, string> } | null
  /** Round budget for the Codex session lifetime guard (default 30 min). */
  maxTurnMs?: number
}

export function createCodexSessionModelTurn(options: CodexSessionModelTurnOptions): {
  start(input: {
    sessionId: string
    prompt: string
    sessionMcpConfig: ExternalEngineMcpConfig
    /** Real toolset discovery against the driver-owned sidecar. */
    listTools(): Promise<ExternalEngineTool[]>
    /** Real tool call: proxy → sidecar → durable handoff. */
    callTool(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; content: unknown }>
  }): Promise<void>
} {
  const maxTurnMs = options.maxTurnMs ?? 30 * 60_000
  return {
    async start({ sessionId, prompt, sessionMcpConfig, listTools, callTool }) {
      const codex = options.resolveCodexCommand(sessionId)
      if (!codex) {
        // No Codex CLI configured in this runtime — deterministic degrade.
        return
      }

      // The driver mediates a 1:1 MCP proxy over the Codex process's stdio:
      // tools/list and tools/call from the Codex session are served from the
      // driver-owned sidecar, so the model discovers the REAL JSON schemas.
      const proxy = new Server(
        { name: 'polo-session-toolset-proxy', version: '1.0.0' },
        { capabilities: { tools: {} } },
      )
      proxy.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: (await listTools()).map(t => ({
          name: t.name,
          description: t.description,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          inputSchema: { type: 'object' } as any,
        })),
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let codexProcess: ChildProcess | null = null
      // PAUSE BOUNDARY: once the model's request_user_input handoff is
      // accepted at the durable boundary, this model turn is terminal. The
      // model session process is terminated so it cannot consume the
      // "waiting for user input" result and keep querying before the user
      // has answered — the answer path owns the continuation (a new
      // generation and a new model session).
      let turnSettled = false
      const settleModelTurn = () => {
        if (turnSettled) return
        turnSettled = true
        codexProcess?.kill('SIGTERM')
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      proxy.setRequestHandler(CallToolRequestSchema, async (req: any) => {
        const result = await callTool(req.params.name, req.params.arguments ?? {})
        if (req.params.name === QUESTION_HANDOFF_TOOL && !result.isError) {
          // Flush the tool result to the model process first — the boundary
          // is the durable handoff, not the transport teardown.
          setImmediate(() => settleModelTurn())
        }
        return { content: result.content, isError: result.isError }
      })

      codexProcess = spawn(codex.command, [...codex.args, prompt], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // The bootstrap's per-runtime Codex environment travels with the
          // resolved command (credentials, CLI paths).
          ...(codex.env ?? {}),
          // The session MCP sidecar is registered natively as the Codex
          // session's MCP server (command + args of the driver-owned
          // sidecar), so tools/list serves the real schemas.
          POLO_SESSION_MCP_COMMAND: sessionMcpConfig.command,
          POLO_SESSION_MCP_ARGS: sessionMcpConfig.args.join(' '),
          POLO_SESSION_MCP_CALLBACK_PORT: String(sessionMcpConfig.callbackPort),
          POLO_SESSION_ID: sessionId,
        },
      })
      const proc = codexProcess
      ;(proc.stderr as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
        console.error(`[external-engine model] ${chunk.toString().trim()}`)
      })

      const transport = new StdioServerTransport(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proc.stdout as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        proc.stdin as any,
      )
      await proxy.connect(transport)

      // The Codex process exiting is the model turn's completion — either the
      // model finished its turn naturally, or the turn was settled at the
      // question-handoff pause boundary above.
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, maxTurnMs)
        timer.unref?.()
        proc.once('exit', () => {
          clearTimeout(timer)
          // Release the proxy's stdio handles so the turn leaves no dangling
          // transport behind.
          void proxy.close().catch(() => {})
          resolve()
        })
        proc.once('error', () => {
          clearTimeout(timer)
          void proxy.close().catch(() => {})
          resolve()
        })
      })
    },
  }
}
