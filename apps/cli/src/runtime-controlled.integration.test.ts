import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Real server, SessionManager and Pi subprocess. Only the HTTP model is controlled.
test('standalone owned CLI completes a real Pi read/write tool loop and resumes the same Thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-cli-runtime-'))
  const work = join(root, 'work')
  await mkdir(work)
  const nonce = crypto.randomUUID()
  await writeFile(join(work, 'input.txt'), nonce)
  const requests: any[] = []
  const model = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as any
    const tools = body.tools?.map((t: any) => t.function.name) ?? []
    if (tools.length) requests.push(body)
    const index = tools.length ? requests.length : 100
    let delta: any
    if (index <= 2) {
      const name = tools.find((n: string) => n === (index === 1 ? 'Read' : 'Write') || n === (index === 1 ? 'read' : 'write'))
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: `call_${index}`, type: 'function', function: {
        name: name ?? (index === 1 ? 'Read' : 'Write'), arguments: JSON.stringify(index === 1
          ? { file_path: join(work, 'input.txt'), path: join(work, 'input.txt') }
          : { file_path: join(work, 'output.txt'), path: join(work, 'output.txt'), content: nonce }),
      } }] }
    } else delta = { role: 'assistant', content: `DONE ${nonce}` }
    const chunk = (d: any, finish: string | null) => `data: ${JSON.stringify({ id: 'controlled', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`
    return new Response(chunk(delta, null) + chunk({}, index <= 2 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
  } })
  await writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [], activeWorkspaceId: null, defaultLlmConnection: 'owned-test', llmConnections: [{ slug: 'owned-test', name: 'Controlled', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', baseUrl: `http://127.0.0.1:${model.port}/v1`, customEndpoint: { api: 'openai-completions' }, models: ['test-model'], defaultModel: 'test-model', createdAt: 1 }] }))
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], { cwd: resolve('.'), env: { ...process.env, POLO_AI_CONFIG_DIR: root, HOME: root, LLM_API_KEY: 'controlled-not-secret', POLO_AI_BUNDLED_ASSETS_ROOT: resolve('apps/electron') }, stdout: 'pipe', stderr: 'pipe' })
    const deadline = setTimeout(() => child.kill('SIGTERM'), 40000)
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    clearTimeout(deadline)
    if (code !== 0) throw new Error(`CLI exit ${code}: ${stderr}\n${stdout}`)
    return stdout
  }
  try {
    const stdout = await run(['exec', '--json', '--yolo', '-C', work, 'Read input.txt, write its exact contents to output.txt, then reply DONE.'])
    expect(await readFile(join(work, 'output.txt'), 'utf8')).toBe(nonce)
    expect(requests.length).toBeGreaterThanOrEqual(3)
    expect(requests[1].messages.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes(nonce))).toBe(true)
    expect(stdout).toContain('command_execution')
    const events = stdout.trim().split('\n').map(line => JSON.parse(line))
    const threadId = events.find(e => e.type === 'thread.started')?.thread_id
    expect(threadId).toBeTruthy()
    const resumed = await run(['exec', 'resume', threadId, '--json', 'Reply DONE again.'])
    expect(resumed).toContain(nonce)
    expect(resumed).toContain(threadId)
  } finally { model.stop(true); await rm(root, { recursive: true, force: true }) }
}, 100_000)
