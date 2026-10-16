import { expect, test } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('an owned Thread retains its source when the mutable global default later becomes managed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-owned-resume-'))
  let calls = 0
  const provider = Bun.serve({ port: 0, async fetch(req) {
    await req.json(); calls++
    expect(req.headers.get('authorization')).toBe('Bearer controlled-owned-key')
    const frame = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: 'owned', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    return new Response(frame({ role: 'assistant', content: 'OWNED_OK' }, null) + frame({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const owned = { slug: 'owned', name: 'Owned', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', baseUrl: `http://127.0.0.1:${provider.port}/v1`, customEndpoint: { api: 'openai-completions' }, models: ['test-model'], defaultModel: 'test-model', createdAt: 1 }
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], { env: { ...process.env, HOME: root, POLO_AI_CONFIG_DIR: root, LLM_API_KEY: 'controlled-owned-key' }, stdout: 'pipe', stderr: 'pipe' })
    const deadline = setTimeout(() => child.kill('SIGTERM'), 25000)
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); clearTimeout(deadline)
    if (code !== 0) throw new Error(`CLI ${code}: ${err}\n${out}`)
    return out.trim().split('\n').map(line => JSON.parse(line))
  }
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [], defaultLlmConnection: 'owned', llmConnections: [owned] }))
    const events = await run(['exec', '--json', '-C', root, 'Reply OWNED_OK.'])
    const thread = events.find(row => row.type === 'thread.started')!.thread_id
    const managed = { ...owned, slug: `polo-space-${crypto.randomUUID()}`, managedBy: 'admin' }
    await writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [], defaultLlmConnection: managed.slug, llmConnections: [owned, managed] }))
    const resumed = await run(['exec', 'resume', thread, '--json', 'Continue with the original owned connection.'])
    expect(resumed.some(row => row.type === 'turn.completed')).toBe(true)
    expect(calls).toBe(2)
  } finally { provider.stop(true); await rm(root, { recursive: true, force: true }) }
}, 60000)
