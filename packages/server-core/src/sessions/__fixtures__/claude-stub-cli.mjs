#!/usr/bin/env bun
// Stub Claude CLI — the REAL Claude Agent SDK spawns this binary (it is
// resolved through the production `claude-agent-sdk-binary` layout and stamped
// via applyAnthropicRuntimeBootstrap). The stub plays only the MODEL at the
// SDK's outermost subprocess boundary: everything between ClaudeAgent.chat and
// the tool execution is the production stack (SDK transport + control
// protocol + the in-process `session` MCP toolset served to the SDK).
//
// Scripted behavior (env):
//   POLO_STUB_TRACE          — append-only JSONL trace of model-side events
//   POLO_STUB_ASK_MARKER     — when the prompt contains this, the model calls
//                              request_user_input through tools/list discovery
//                              + a real MCP tools/call round-trip; otherwise
//                              it completes with plain text.
//   POLO_STUB_QUESTIONS      — JSON array of request_user_input questions.
//
// Protocol notes (mirror of the SDK's stream-json contract):
//   - SDK → CLI stdin lines: {type:'control_request',request_id,request} and
//     {type:'user',message:{role:'user',content:[{type:'text',text}]}}.
//   - CLI → SDK stdout lines: control_response, system/assistant/user
//     messages, and a final {type:'result'}.
import { appendFileSync } from 'node:fs'

const TRACE = process.env.POLO_STUB_TRACE ?? ''
const ASK_MARKER = process.env.POLO_STUB_ASK_MARKER ?? ''
const QUESTIONS = JSON.parse(process.env.POLO_STUB_QUESTIONS ?? '[]')

const sessionId = `stub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let mcpCounter = 0
const pendingMcp = new Map()

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function trace(entry) {
  if (TRACE) {
    try { appendFileSync(TRACE, JSON.stringify(entry) + '\n') } catch { /* trace is best-effort */ }
  }
}

function respondControl(requestId, response) {
  write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
}

function mcpRoundTrip(serverMessage) {
  const requestId = `stub-mcp-${++mcpCounter}`
  return new Promise(resolve => {
    pendingMcp.set(requestId, resolve)
    write({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'mcp_message', server_name: 'session', message: serverMessage },
    })
  })
}

function textFromUserContent(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n')
  }
  return ''
}

async function runTurn(userText) {
  trace({ event: 'launch', resume: process.argv.includes('--resume'), promptHead: userText.slice(0, 60) })
  emitSystemInit()

  const shouldAsk = ASK_MARKER.length > 0 && userText.includes(ASK_MARKER)
  if (!shouldAsk) {
    emitAssistantText('Understood — continuing with the provided answer.')
    emitResult('done')
    return
  }

  // MODEL-SIDE TOOL DISCOVERY: the toolset the SDK hands the model is
  // discovered through the production MCP tools/list round-trip.
  const listing = await mcpRoundTrip({ jsonrpc: '2.0', id: ++mcpCounter, method: 'tools/list', params: {} })
  const tools = listing?.response?.mcp_response?.result?.tools ?? []
  const toolNames = tools.map(t => t.name)
  trace({ event: 'tools_list', names: toolNames, hasRequestUserInput: toolNames.includes('request_user_input') })

  // MODEL TOOL CALL: request_user_input through the real tools/call path.
  const toolUseId = 'stub-tu-1'
  emitAssistantToolUse(toolUseId)
  const call = await mcpRoundTrip({
    jsonrpc: '2.0',
    id: ++mcpCounter,
    method: 'tools/call',
    params: { name: 'request_user_input', arguments: { questions: QUESTIONS } },
  })
  const resultText = (call?.response?.mcp_response?.result?.content ?? []).map(part => part?.text ?? '').join('')
  emitUserToolResult(toolUseId, resultText)
  trace({ event: 'tool_result', textHead: resultText.slice(0, 80) })

  emitAssistantText('I asked the user and am now waiting to continue with their answer.')
  emitResult('asked')
}

function emitSystemInit() {
  write({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'stub-model',
    tools: [],
    cwd: process.cwd(),
    permissionMode: 'bypassPermissions',
  })
}

function emitAssistantText(text) {
  write({
    type: 'assistant',
    message: {
      id: `stub-msg-${++mcpCounter}`,
      role: 'assistant',
      model: 'stub-model',
      type: 'message',
      content: [{ type: 'text', text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  })
}

function emitAssistantToolUse(toolUseId) {
  write({
    type: 'assistant',
    message: {
      id: `stub-msg-${++mcpCounter}`,
      role: 'assistant',
      model: 'stub-model',
      type: 'message',
      content: [{
        type: 'tool_use',
        id: toolUseId,
        name: 'mcp__session__request_user_input',
        input: { questions: QUESTIONS },
      }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  })
}

function emitUserToolResult(toolUseId, resultText) {
  write({
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: [{ type: 'text', text: resultText }],
      }],
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  })
}

function emitResult(resultText) {
  write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: resultText,
    session_id: sessionId,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0,
    duration_ms: 1,
    num_turns: 1,
  })
  trace({ event: 'result' })
  // The model turn is over — end the process like a real CLI would.
  process.exit(0)
}

// Event-driven stdin: control requests (initialize/interrupt) may arrive
// while an MCP round-trip is pending — in particular the SessionManager's
// question-handoff interrupt lands mid-tools/call.
let turnStarted = false
const lines = []
let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let newlineIndex
  while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (line) handleLine(line)
  }
})
process.stdin.on('end', () => { /* stdin closed — model already decided */ })

function handleLine(line) {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === 'control_request') {
    // The SDK's initialize handshake — respond so the query can proceed.
    respondControl(message.request_id, { commands: [], models: [], tools: [], mcp_servers: [] })
    trace({ event: 'control', subtype: message.request?.subtype })
    return
  }
  if (message.type === 'control_response') {
    const request_id = message.response?.request_id
    const pending = pendingMcp.get(request_id)
    if (pending) {
      pendingMcp.delete(request_id)
      pending(message.response)
    }
    return
  }
  if (message.type === 'user' && !turnStarted) {
    turnStarted = true
    const text = textFromUserContent(message.message?.content)
    void runTurn(text).catch(error => {
      trace({ event: 'stub_error', message: String(error) })
      process.exit(1)
    })
  }
}
