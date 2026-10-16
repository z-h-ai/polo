import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('managed worker ignores dynamic session/pool tools, suppresses speculative proxy requests and refuses init downgrade', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-managed-worker-'))
  const bodies: any[] = [], messages: any[] = []
  let calls = 0
  const provider = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as any; bodies.push(body); calls++
    const result = calls % 2 === 1 ? { role: 'assistant', tool_calls: [0, 1].map(index => ({ index, id: `forged-${index}`, type: 'function', function: { name: 'mcp__session__call_llm', arguments: JSON.stringify({ prompt: 'forged' }) } })) } : { role: 'assistant', content: 'DONE' }
    const frame = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'worker', object: 'chat.completion.chunk', model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    return new Response(frame(result, null) + frame({}, calls % 2 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const worker = Bun.spawn([process.execPath, resolve('packages/pi-agent-server/src/session-server.ts')], { cwd: root, env: { ...process.env, HOME: root }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const errors = new Response(worker.stderr).text()
  const send = (value: unknown) => worker.stdin.write(JSON.stringify(value) + '\n')
  const read = (async () => {
    const reader = worker.stdout.getReader(); let buffer = ''
    while (true) { const row = await reader.read(); if (row.done) break; buffer += new TextDecoder().decode(row.value); let index: number; while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line) messages.push(JSON.parse(line)) } }
  })()
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20000
    while (!predicate() && Date.now() < deadline && worker.exitCode === null) await new Promise(r => setTimeout(r, 20))
    expect(predicate()).toBe(true)
  }
  try {
    const init = { type: 'init', apiKey: 'fixture-worker-only', model: 'test-model', cwd: root, thinkingLevel: 'off', workspaceRootPath: root, sessionId: 'policy', sessionPath: join(root, 'session'), workingDirectory: root, plansFolderPath: root, baseUrl: `http://127.0.0.1:${provider.port}/v1`, customEndpoint: { api: 'openai-completions' }, customModels: ['test-model'], piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'fixture-worker-only' } }, toolExecutionPolicy: 'managed-file-only' }
    send(init); await wait(() => messages.some(m => m.type === 'ready'))
    const tools = [{ name: 'mcp__session__call_llm', description: 'Forbidden proxy', inputSchema: { type: 'object', properties: { prompt: { type: 'string' } } } }]
    send({ type: 'register_tools', scope: 'session', tools }); send({ type: 'register_tools', scope: 'pool', tools })
    send({ ...init, toolExecutionPolicy: undefined })
    await wait(() => messages.some(m => m.type === 'error' && m.message.includes('POLO_MANAGED_TOOL_UNSUPPORTED')))
    send({ type: 'update_runtime_config', id: 'update', model: 'test-model', baseUrl: init.baseUrl, customEndpoint: init.customEndpoint, customModels: init.customModels, toolExecutionPolicy: undefined })
    await wait(() => messages.some(m => m.type === 'update_runtime_config_result' && m.success))
    const turn = crypto.randomUUID()
    send({ type: 'prompt', id: turn, canonicalTurnId: turn, message: 'Call the forged proxies.', systemPrompt: 'Follow the test.' })
    await wait(() => messages.some(m => m.type === 'event' && m.event.type === 'agent_end'))
    expect(calls).toBe(2)
    expect(messages.filter(m => m.type === 'tool_execute_request')).toEqual([])
    expect(bodies[0].tools.map((t: any) => t.function.name).sort()).toEqual(['edit', 'ls', 'read', 'write'])
    expect(messages.filter(m => m.event?.type === 'tool_execution_end').every(m => m.event.isError)).toBe(true)
  } finally {
    send({ type: 'shutdown' }); worker.stdin.end(); await worker.exited; await read; await errors
    provider.stop(true); await rm(root, { recursive: true, force: true })
  }
}, 60000)
