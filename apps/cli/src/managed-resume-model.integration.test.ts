import { test, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

test('a managed resume model override is invocation-only and leaves the original Thread selection intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-managed-model-'))
  const desktop = Bun.spawn([process.execPath, resolve('apps/cli/src/__fixtures__/managed-desktop.ts'), root], { stdout: 'pipe', stderr: 'pipe' })
  const errors = new Response(desktop.stderr).text(), reader = desktop.stdout.getReader()
  let ready = '', child: ReturnType<typeof Bun.spawn> | undefined
  try {
    while (!ready.includes('\n')) { const row = await reader.read(); if (row.done) throw new Error(await errors); ready += new TextDecoder().decode(row.value) }
    const fixture = JSON.parse(ready.split('\n')[0]!)
    await fetch(fixture.admin + '/fixture/control', { method: 'POST', body: JSON.stringify({ allowAlternateModel: true }) })
    const run = async (args: string[]) => {
      const spawned = Bun.spawn([process.execPath, resolve('apps/cli/src/index.ts'), ...args], { env: { ...process.env, HOME: root, POLO_AI_CONFIG_DIR: root, POLO_AI_RUNTIME_DISCOVERY_FILE: join(root, 'runtime/electron.json'), LLM_API_KEY: '', LLM_BASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' })
      child = spawned
      const deadline = setTimeout(() => child?.kill('SIGTERM'), 30000)
      const [code, out, err] = await Promise.all([child.exited, new Response(spawned.stdout).text(), new Response(spawned.stderr).text()]); clearTimeout(deadline)
      if (code !== 0) throw new Error(`CLI ${code}: ${err}\n${out}`)
      return out
    }
    const out = await run(['exec', '--provider', 'polo', '--json', '-C', join(root, 'work'), 'Minimal reply.'])
    const thread = out.trim().split('\n').map(line => JSON.parse(line)).find(row => row.type === 'thread.started').thread_id
    await run(['exec', 'resume', thread, '--provider', 'polo', '--model', 'alternate-model', '--json', 'Reply using the explicitly allowed alternate model.'])
    const metadata = JSON.parse(await readFile(join(root, 'cli-sessions/global/executions', thread, 'thread.json'), 'utf8'))
    expect(metadata.connection.model).toBe('test-model')
    await run(['exec', 'resume', thread, '--provider', 'polo', '--json', 'Resume with the original Thread model.'])
    const facts = await (await fetch(fixture.admin + '/fixture/state')).json() as any
    expect(facts.bodies.map((body: any) => body.model)).toEqual(['test-model', 'alternate-model', 'test-model'])
  } finally { child?.kill('SIGTERM'); desktop.kill('SIGTERM'); await desktop.exited; await errors; await rm(root, { recursive: true, force: true }) }
}, 90000)
