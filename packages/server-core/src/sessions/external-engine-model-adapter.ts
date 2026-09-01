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
  /** The sidecar's NATIVE JSON schema for the tool's arguments. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema?: any
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

/** Grace period between the pause SIGTERM and the enforcement SIGKILL. */
const SETTLE_GRACE_MS = 2_000

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
    async start({ sessionId, prompt, listTools, callTool }) {
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
        // NATIVE schema passthrough: the model sees the sidecar's real
        // arguments shape (request_user_input's questions[] structure among
        // them) — this proxy must not reshape what the sidecar serves.
        tools: (await listTools()).map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
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
      let terminateTimer: NodeJS.Timeout | null = null
      const settleModelTurn = () => {
        if (turnSettled || !codexProcess) return
        turnSettled = true
        codexProcess.kill('SIGTERM')
        // A model session that ignores SIGTERM must not outlive the pause:
        // it could keep querying into a generation the answer already owns.
        terminateTimer = setTimeout(() => {
          codexProcess?.kill('SIGKILL')
        }, SETTLE_GRACE_MS)
        terminateTimer.unref?.()
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

      // The model session process exiting is the turn's completion — either
      // the model finished naturally (exit 0), the turn was settled at the
      // question-handoff pause boundary, or the session FAILED (a non-zero
      // exit with no settled handoff is a failed turn, never a silent no-op).
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve(null)
        }, maxTurnMs)
        timer.unref?.()
        proc.once('exit', (code: number | null) => {
          clearTimeout(timer)
          if (terminateTimer) clearTimeout(terminateTimer)
          // Release the proxy's stdio handles so the turn leaves no dangling
          // transport behind.
          void proxy.close().catch(() => {})
          resolve(code)
        })
        proc.once('error', (error: Error) => {
          clearTimeout(timer)
          if (terminateTimer) clearTimeout(terminateTimer)
          void proxy.close().catch(() => {})
          reject(error)
        })
      })
      if (!turnSettled && exitCode !== null && exitCode !== 0) {
        // The model session failed mid-turn (bad CLI arguments, crash,
        // rejected tool call). The message is durably persisted; surfacing
        // the failure through the completion boundary must not be swallowed
        // as a successful no-op turn.
        throw new Error(`external model session exited with code ${exitCode}`)
      }
    },
  }
}
