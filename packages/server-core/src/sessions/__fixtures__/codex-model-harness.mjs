#!/usr/bin/env node
/**
 * Codex-model harness STAND-IN for the external-engine Acceptance.
 *
 * Acts as the model process: its stdio IS the MCP channel to the driver-
 * mediated session toolset proxy. It performs the REAL model consumption —
 * tools/list (native schema discovery) and tools/call (request_user_input →
 * durable handoff) — using only the credentials/decision layer stubbed via
 * argv.
 *
 * Usage: node codex-model-harness.mjs <toolArgsJson> [prompt...]
 * - <toolArgsJson>: the request_user_input arguments (question fixture).
 * - The prompt is appended LAST by the launch closure. Model decision: if
 *   the prompt contains the original ask marker, call request_user_input;
 *   otherwise the turn completes without tools (the answer is in history).
 * - POLO_HARNESS_EXIT_MARKER: records how this model session ended
 *   ('sigterm' when the turn was settled by the host, 'exit' on natural
 *   completion, 'force-call-rejected' after a rejected call for a missing
 *   tool) — the observable pause-boundary / fail-closed evidence.
 * - POLO_HARNESS_FORCE_TOOL=<name>: fail-closed probe — the tool must NOT be
 *   model-visible; the harness attempts the call anyway and expects the
 *   sidecar to reject it (exit 6). Exit 7 = tool was visible (fail closed
 *   broken); exit 8 = the call for a missing tool did not error.
 * Exits 0 after the tool result is received (the durable boundary settled).
 */
import process from 'node:process'
import { appendFileSync, writeFileSync } from 'node:fs'

const toolArgsJson = process.argv[2] ?? '{}'
const exitMarkerPath = process.env.POLO_HARNESS_EXIT_MARKER ?? null
const promptLogPath = process.env.POLO_HARNESS_PROMPT_LOG ?? null
const forceTool = process.env.POLO_HARNESS_FORCE_TOOL ?? null
const prompt = process.argv.slice(3).join(' ')

// Observability: record this model session's prompt so a test can await the
// exact launch sequence (one line per model process).
if (promptLogPath) {
  // JSON-encoded so multi-line prompts stay one log entry.
  try { appendFileSync(promptLogPath, JSON.stringify(prompt) + '\n') } catch { /* best effort */ }
}

const shouldAsk = prompt.includes('please ask')

const recordExit = reason => {
  if (!exitMarkerPath) return
  try {
    writeFileSync(exitMarkerPath, reason)
  } catch { /* the marker is best-effort evidence */ }
}
process.on('SIGTERM', () => {
  recordExit('sigterm')
  process.exit(0)
})

let buffer = ''
let nextId = 1
const pending = new Map()

process.stdin.setEncoding('utf-8')
process.stdin.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    try {
      const message = JSON.parse(line)
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message)
        pending.delete(message.id)
      }
    } catch { /* ignore malformed line */ }
  }
})

function rpc(method, params) {
  const id = nextId++
  const message = { jsonrpc: '2.0', id, method, params }
  return new Promise((resolve, reject) => {
    pending.set(id, resolve)
    process.stdout.write(JSON.stringify(message) + '\n')
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`harness: timeout waiting for ${method}`))
      }
    }, 30000)
    timer.unref?.()
  })
}

async function main() {
  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codex-model-harness', version: '1.0.0' },
  })
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const tools = await rpc('tools/list', {})
  if (!tools.result) {
    console.error('harness: tools/list returned no result:', JSON.stringify(tools))
    process.exit(5)
  }
  const names = (tools.result.tools ?? []).map(t => t.name)

  // FAIL-CLOSED PROBE: a turn whose capability is off must not serve the
  // tool at all, and a call for the missing tool must be rejected by the
  // sidecar — never silently succeed.
  if (forceTool) {
    if (names.includes(forceTool)) {
      console.error(`harness: FAIL-CLOSED VIOLATION — ${forceTool} is model-visible`)
      process.exit(7)
    }
    const rejected = await rpc('tools/call', { name: forceTool, arguments: {} })
    const toolError = Boolean(rejected.error) || rejected.result?.isError === true
    if (!toolError) {
      console.error(`harness: calling missing tool ${forceTool} did not error:`, JSON.stringify(rejected.result ?? rejected.error))
      process.exit(8)
    }
    recordExit('force-call-rejected')
    process.exit(6)
  }

  // MODEL DECISION (credentials/decision layer): if the model asks the
  // question, call request_user_input — discovered NATIVELY from the
  // tools/list schemas above.
  if (shouldAsk) {
    if (!names.includes('request_user_input')) {
      console.error(`harness: request_user_input not in model-visible toolset: ${names.join(', ')}`)
      process.exit(3)
    }
    const call = await rpc('tools/call', {
      name: 'request_user_input',
      arguments: JSON.parse(toolArgsJson),
    })
    if (call.result.isError) {
      console.error(`harness: tool call failed: ${JSON.stringify(call.result.content)}`)
      process.exit(4)
    }
    // REAL MODEL SESSION SHAPE: after the tool result settles, the model
    // session keeps running — it does not end its turn on its own. Only the
    // host settling the turn at the pause boundary (SIGTERM) ends it. A
    // session that is never settled stays parked (the launch guard kills it),
    // which is exactly the defect the pause boundary exists to prevent.
    await new Promise(() => { /* parked until the host settles the turn */ })
  }

  recordExit('exit')
  process.exit(0)
}

main().catch(error => {
  console.error('harness: fatal:', error)
  process.exit(1)
})
