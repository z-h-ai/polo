/**
 * Production model adapter for externally driven sessions.
 *
 * Runs one model turn as a TOOL LOOP over the driver-owned session MCP
 * sidecar: the session's configured LLM (its backend `queryLlm` client) is
 * prompted with the toolset; when the model requests a tool, the adapter
 * executes it through the owned sidecar (stdio → HTTP callback → the
 * SessionManager durable handoff) and feeds the result back —
 * `request_user_input` settles at the durable boundary, exactly like the
 * embedded engines' tool consumption.
 *
 * The turn protocol is text-based (the session query API returns text):
 * a model tool request is the line
 *   TOOL_CALL <toolName> {json args}
 * anything else ends the turn.
 */

import type { ExternalEngineModelTurn, ExternalEngineTool } from './external-engine-driver.ts'

type LlmQueryFn = (request: { prompt: string; systemPrompt?: string }) => Promise<{ text: string }>

export interface LlmToolLoopAdapterOptions {
  /**
   * Resolve the session's LLM query client. Production bootstrap wires this
   * to the SessionManager (the session's configured backend is the LLM
   * client; the driver still owns the sidecar and the turn loop lives here).
   * Returning null degrades deterministically (the turn ends immediately).
   */
  query: (sessionId: string) => Promise<LlmQueryFn | null>
  /** Tool-loop round budget (default 8). */
  maxToolRounds?: number
}

const TOOL_CALL_PREFIX = 'TOOL_CALL '

interface ParsedToolCall {
  name: string
  args: Record<string, unknown>
}

function parseToolCall(text: string): ParsedToolCall | null {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith(TOOL_CALL_PREFIX)) continue
    const rest = line.slice(TOOL_CALL_PREFIX.length).trim()
    const spaceIndex = rest.indexOf(' ')
    const name = spaceIndex === -1 ? rest : rest.slice(0, spaceIndex)
    const json = spaceIndex === -1 ? '{}' : rest.slice(spaceIndex + 1)
    if (!name) return null
    let args: Record<string, unknown> = {}
    try {
      args = JSON.parse(json) as Record<string, unknown>
    } catch {
      args = {}
    }
    return { name, args }
  }
  return null
}

function toolsetPrompt(tools: ExternalEngineTool[]): string {
  const lines = tools.map(t => `- ${t.name}: ${(t.description ?? '').split('\n')[0]}`)
  return [
    'You may use exactly one session tool per reply. To use a tool, reply with a single line:',
    'TOOL_CALL <toolName> <json-args>',
    'Available session tools:',
    ...lines,
  ].join('\n')
}

/** Production model turn for external sessions: a real tool loop over the session LLM. */
export function createLlmToolLoopModelTurn(options: LlmToolLoopAdapterOptions): ExternalEngineModelTurn {
  const maxToolRounds = options.maxToolRounds ?? 8
  return {
    async runModelTurn({ sessionId, prompt, listTools, callTool }) {
      const query = await options.query(sessionId)
      if (!query) {
        // No model query channel — the turn ends without model output (the
        // user message is already durably persisted).
        return
      }
      const tools = await listTools()
      let context = `${prompt}\n\n${toolsetPrompt(tools)}`
      for (let round = 0; round < maxToolRounds; round++) {
        const result = await query({ prompt: context, systemPrompt: 'You are a coding agent working session tools.' })
        const call = parseToolCall(result.text)
        if (!call) return // natural end of the model turn
        const toolResult = await callTool(call.name, call.args)
        const resultText = JSON.stringify(toolResult.content ?? {})
        context = `${context}\n\nTOOL_RESULT ${call.name}: ${resultText}`
      }
    },
  }
}
